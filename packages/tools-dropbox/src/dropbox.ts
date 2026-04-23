/**
 * @weaveintel/tools-dropbox — Dropbox MCP server
 * Uses Dropbox API v2. Credentials: ctx.metadata.dropboxAccessToken
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface DropboxCredentials { accessToken: string; refreshAccessToken?: () => Promise<string | undefined>; }
export interface DropboxTokenProvider {
  getToken(ctx: ExecutionContext): Promise<string | undefined>;
  refreshToken(ctx: ExecutionContext): Promise<string | undefined>;
}
export interface DropboxEntry { id: string; name: string; path: string; size?: number; isFolder: boolean; serverModified?: string; }

export interface DropboxAdapter {
  listFolder(creds: DropboxCredentials, path: string): Promise<DropboxEntry[]>;
  readFile(creds: DropboxCredentials, path: string): Promise<{ entry: DropboxEntry; content: string }>;
  createFile(creds: DropboxCredentials, path: string, content: string): Promise<DropboxEntry>;
  updateFile(creds: DropboxCredentials, path: string, content: string): Promise<DropboxEntry>;
  shareFile(creds: DropboxCredentials, path: string): Promise<{ url: string }>;
  subscribeChanges(creds: DropboxCredentials, onEntry: (e: DropboxEntry) => Promise<void>): Promise<{ stop: () => void }>;
}

function createMetadataTokenProvider(): DropboxTokenProvider {
  return {
    async getToken(ctx) {
      return ctx.metadata?.['dropboxAccessToken'] as string | undefined;
    },
    async refreshToken(ctx) {
      return ctx.metadata?.['dropboxRefreshAccessToken'] as string | undefined;
    },
  };
}

async function extractCredentials(ctx: ExecutionContext, provider: DropboxTokenProvider): Promise<DropboxCredentials> {
  const token = await provider.getToken(ctx);
  if (!token) throw new Error('Dropbox access token missing from ctx.metadata.dropboxAccessToken');
  return { accessToken: token };
}

async function dbxFetch(
  token: string,
  endpoint: string,
  body: unknown,
  isContent = false,
  refreshToken?: () => Promise<string | undefined>,
): Promise<unknown> {
  const baseUrl = isContent ? 'https://content.dropboxapi.com/2' : 'https://api.dropboxapi.com/2';
  let activeToken = token;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resp = await fetch(`${baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${activeToken}`, 'Content-Type': isContent ? 'application/octet-stream' : 'application/json', ...(isContent ? { 'Dropbox-API-Arg': JSON.stringify(body) } : {}) },
      body: isContent ? undefined : JSON.stringify(body),
    });
    if (resp.status === 401 && attempt === 0 && refreshToken) {
      const refreshed = await refreshToken();
      if (refreshed) {
        activeToken = refreshed;
        continue;
      }
    }
    if (!resp.ok) throw new Error(`Dropbox API ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    const ct = resp.headers.get('Content-Type') ?? '';
    return ct.includes('application/json') ? resp.json() : resp.text();
  }
  throw new Error('Dropbox request failed after token refresh attempt');
}

function parseEntry(raw: Record<string, unknown>): DropboxEntry {
  return {
    id: raw['id'] as string ?? '',
    name: raw['name'] as string,
    path: raw['path_lower'] as string ?? raw['path_display'] as string ?? '',
    size: raw['size'] ? Number(raw['size']) : undefined,
    isFolder: raw['.tag'] === 'folder',
    serverModified: raw['server_modified'] as string | undefined,
  };
}

export const liveDropboxAdapter: DropboxAdapter = {
  async listFolder(creds, path) {
    const data = await dbxFetch(creds.accessToken, 'files/list_folder', { path: path === '/' ? '' : path }, false, creds.refreshAccessToken) as Record<string, unknown>;
    return ((data['entries'] as Array<Record<string, unknown>>) ?? []).map(parseEntry);
  },
  async readFile(creds, path) {
    let activeToken = creds.accessToken;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resp = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: { Authorization: `Bearer ${activeToken}`, 'Dropbox-API-Arg': JSON.stringify({ path }), 'Content-Type': '' },
      });
      if (resp.status === 401 && attempt === 0 && creds.refreshAccessToken) {
        const refreshed = await creds.refreshAccessToken();
        if (refreshed) {
          activeToken = refreshed;
          continue;
        }
      }
      if (!resp.ok) throw new Error(`Dropbox download ${resp.status}`);
      const metaHeader = resp.headers.get('Dropbox-API-Result');
      const meta = metaHeader ? JSON.parse(metaHeader) as Record<string, unknown> : {};
      const content = await resp.text();
      return { entry: parseEntry({ ...meta, name: meta['name'] ?? path.split('/').pop() ?? path }), content };
    }
    throw new Error('Dropbox download failed after token refresh attempt');
  },
  async createFile(creds, path, content) {
    let activeToken = creds.accessToken;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${activeToken}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true }) },
        body: content,
      });
      if (raw.status === 401 && attempt === 0 && creds.refreshAccessToken) {
        const refreshed = await creds.refreshAccessToken();
        if (refreshed) {
          activeToken = refreshed;
          continue;
        }
      }
      if (!raw.ok) throw new Error(`Dropbox upload ${raw.status}`);
      return parseEntry(await raw.json() as Record<string, unknown>);
    }
    throw new Error('Dropbox upload failed after token refresh attempt');
  },
  async updateFile(creds, path, content) {
    let activeToken = creds.accessToken;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const raw = await fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${activeToken}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite' }) },
        body: content,
      });
      if (raw.status === 401 && attempt === 0 && creds.refreshAccessToken) {
        const refreshed = await creds.refreshAccessToken();
        if (refreshed) {
          activeToken = refreshed;
          continue;
        }
      }
      if (!raw.ok) throw new Error(`Dropbox overwrite ${raw.status}`);
      return parseEntry(await raw.json() as Record<string, unknown>);
    }
    throw new Error('Dropbox overwrite failed after token refresh attempt');
  },
  async shareFile(creds, path) {
    const data = await dbxFetch(creds.accessToken, 'sharing/create_shared_link_with_settings', { path }, false, creds.refreshAccessToken) as Record<string, unknown>;
    return { url: data['url'] as string };
  },
  async subscribeChanges() { return { stop: () => {} }; },
};

export interface DropboxMCPServerOptions { adapter?: DropboxAdapter; tokenProvider?: DropboxTokenProvider; }

export function createDropboxMCPServer(opts: DropboxMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveDropboxAdapter;
  const tokenProvider = opts.tokenProvider ?? createMetadataTokenProvider();
  const server = weaveMCPServer(
    { name: 'dropbox', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('dropbox.list', 'List Dropbox folder contents', 'read-only');
  describeT('dropbox.read', 'Read a Dropbox file', 'read-only');
  describeT('dropbox.create', 'Create a Dropbox file', 'write');
  describeT('dropbox.update', 'Update a Dropbox file', 'write');
  describeT('dropbox.share', 'Share a Dropbox file', 'write');
  describeT('dropbox.subscribe', 'Subscribe to Dropbox changes', 'read-only');

  server.addTool({ name: 'dropbox.list', description: 'List files in a Dropbox folder.', inputSchema: { type: 'object', properties: { path: { type: 'string', default: '/' } } } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.listFolder(creds, String(args['path'] ?? '/'))) }] };
  });

  server.addTool({ name: 'dropbox.read', description: 'Read a Dropbox file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.readFile(creds, String(args['path']))) }] };
  });

  server.addTool({ name: 'dropbox.create', description: 'Upload a file to Dropbox.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.createFile(creds, String(args['path']), String(args['content']))) }] };
  });

  server.addTool({ name: 'dropbox.update', description: 'Overwrite a Dropbox file.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.updateFile(creds, String(args['path']), String(args['content']))) }] };
  });

  server.addTool({ name: 'dropbox.share', description: 'Share a Dropbox file and get a link.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.shareFile(creds, String(args['path']))) }] };
  });

  server.addTool({ name: 'dropbox.subscribe', description: 'Subscribe to Dropbox changes.', inputSchema: { type: 'object', properties: {} } }, async (ctx) => {
    await extractCredentials(ctx, tokenProvider);
    return { content: [{ type: 'text', text: JSON.stringify({ subscribed: true }) }] };
  });

  return server;
}
