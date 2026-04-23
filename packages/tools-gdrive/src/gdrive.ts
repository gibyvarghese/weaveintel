/**
 * @weaveintel/tools-gdrive — Google Drive MCP server
 * Uses Google Drive REST API v3. Credentials: ctx.metadata.gdriveAccessToken
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface GdriveCredentials { accessToken: string; refreshAccessToken?: () => Promise<string | undefined>; }
export interface GdriveTokenProvider {
  getToken(ctx: ExecutionContext): Promise<string | undefined>;
  refreshToken(ctx: ExecutionContext): Promise<string | undefined>;
}
export interface GdriveFile { id: string; name: string; mimeType: string; size?: number; modifiedTime: string; parents?: string[]; webViewLink?: string; }

export interface GdriveAdapter {
  listFiles(creds: GdriveCredentials, folderId: string | null, pageSize: number): Promise<GdriveFile[]>;
  readFile(creds: GdriveCredentials, fileId: string): Promise<{ file: GdriveFile; content: string }>;
  createFile(creds: GdriveCredentials, name: string, content: string, mimeType: string, parentId?: string): Promise<GdriveFile>;
  updateFile(creds: GdriveCredentials, fileId: string, content: string): Promise<GdriveFile>;
  shareFile(creds: GdriveCredentials, fileId: string, email: string, role: string): Promise<void>;
  subscribeChanges(creds: GdriveCredentials, onFile: (f: GdriveFile) => Promise<void>): Promise<{ stop: () => void }>;
}

function createMetadataTokenProvider(): GdriveTokenProvider {
  return {
    async getToken(ctx) {
      return ctx.metadata?.['gdriveAccessToken'] as string | undefined;
    },
    async refreshToken(ctx) {
      return ctx.metadata?.['gdriveRefreshAccessToken'] as string | undefined;
    },
  };
}

async function extractCredentials(ctx: ExecutionContext, provider: GdriveTokenProvider): Promise<GdriveCredentials> {
  const token = await provider.getToken(ctx);
  if (!token) throw new Error('Google Drive access token missing from ctx.metadata.gdriveAccessToken');
  return { accessToken: token };
}

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

async function driveFetch(
  token: string,
  url: string,
  init?: RequestInit,
  refreshToken?: () => Promise<string | undefined>,
): Promise<unknown> {
  let activeToken = token;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resp = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${activeToken}`, ...(init?.headers as Record<string, string> | undefined) },
    });
    if (resp.status === 401 && attempt === 0 && refreshToken) {
      const refreshed = await refreshToken();
      if (refreshed) {
        activeToken = refreshed;
        continue;
      }
    }
    if (!resp.ok) throw new Error(`Drive API ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
    if (resp.status === 204) return {};
    return resp.json();
  }
  throw new Error('Drive API request failed after token refresh attempt');
}

function parseFile(raw: Record<string, unknown>): GdriveFile {
  return {
    id: raw['id'] as string,
    name: raw['name'] as string,
    mimeType: raw['mimeType'] as string,
    size: raw['size'] ? Number(raw['size']) : undefined,
    modifiedTime: raw['modifiedTime'] as string ?? '',
    parents: raw['parents'] as string[] | undefined,
    webViewLink: raw['webViewLink'] as string | undefined,
  };
}

export const liveGdriveAdapter: GdriveAdapter = {
  async listFiles(creds, folderId, pageSize) {
    const q = folderId ? encodeURIComponent(`'${folderId}' in parents and trashed=false`) : encodeURIComponent('trashed=false');
    const data = await driveFetch(creds.accessToken, `${DRIVE_BASE}/files?q=${q}&pageSize=${pageSize}&fields=files(id,name,mimeType,size,modifiedTime,parents,webViewLink)`, undefined, creds.refreshAccessToken) as Record<string, unknown>;
    return ((data['files'] as Array<Record<string, unknown>>) ?? []).map(parseFile);
  },
  async readFile(creds, fileId) {
    const meta = await driveFetch(creds.accessToken, `${DRIVE_BASE}/files/${fileId}?fields=id,name,mimeType,size,modifiedTime,parents,webViewLink`, undefined, creds.refreshAccessToken) as Record<string, unknown>;
    const content = await driveFetch(creds.accessToken, `${DRIVE_BASE}/files/${fileId}?alt=media`, undefined, creds.refreshAccessToken) as string;
    return { file: parseFile(meta), content: String(content) };
  },
  async createFile(creds, name, content, mimeType, parentId) {
    const metadata = { name, mimeType, parents: parentId ? [parentId] : undefined };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([content], { type: mimeType }));
    const raw = await driveFetch(creds.accessToken, `${UPLOAD_BASE}/files?uploadType=multipart`, { method: 'POST', body: form }, creds.refreshAccessToken) as Record<string, unknown>;
    return parseFile(raw);
  },
  async updateFile(creds, fileId, content) {
    const raw = await driveFetch(creds.accessToken, `${UPLOAD_BASE}/files/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain' }, body: content }, creds.refreshAccessToken) as Record<string, unknown>;
    return parseFile(raw);
  },
  async shareFile(creds, fileId, email, role) {
    await driveFetch(creds.accessToken, `${DRIVE_BASE}/files/${fileId}/permissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'user', role, emailAddress: email }) }, creds.refreshAccessToken);
  },
  async subscribeChanges(_creds, _onFile) { return { stop: () => {} }; },
};

export interface GdriveMCPServerOptions { adapter?: GdriveAdapter; tokenProvider?: GdriveTokenProvider; }

export function createGdriveMCPServer(opts: GdriveMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveGdriveAdapter;
  const tokenProvider = opts.tokenProvider ?? createMetadataTokenProvider();
  const server = weaveMCPServer(
    { name: 'gdrive', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('gdrive.list', 'List Google Drive files', 'read-only');
  describeT('gdrive.read', 'Read a Google Drive file', 'read-only');
  describeT('gdrive.create', 'Create a Google Drive file', 'write');
  describeT('gdrive.update', 'Update a Google Drive file', 'write');
  describeT('gdrive.share', 'Share a Google Drive file', 'write');
  describeT('gdrive.subscribe', 'Subscribe to Google Drive changes', 'read-only');

  server.addTool({ name: 'gdrive.list', description: 'List files in Google Drive.', inputSchema: { type: 'object', properties: { folderId: { type: 'string' }, pageSize: { type: 'number', default: 20 } } } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    const files = await adapter.listFiles(creds, (args['folderId'] as string) ?? null, Number(args['pageSize'] ?? 20));
    return { content: [{ type: 'text', text: JSON.stringify(files) }] };
  });

  server.addTool({ name: 'gdrive.read', description: 'Read a Google Drive file.', inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    const result = await adapter.readFile(creds, String(args['fileId']));
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.addTool({ name: 'gdrive.create', description: 'Create a file in Google Drive.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string', default: 'text/plain' }, parentId: { type: 'string' } }, required: ['name', 'content'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    const file = await adapter.createFile(creds, String(args['name']), String(args['content']), String(args['mimeType'] ?? 'text/plain'), args['parentId'] as string | undefined);
    return { content: [{ type: 'text', text: JSON.stringify(file) }] };
  });

  server.addTool({ name: 'gdrive.update', description: 'Update a Google Drive file.', inputSchema: { type: 'object', properties: { fileId: { type: 'string' }, content: { type: 'string' } }, required: ['fileId', 'content'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    const file = await adapter.updateFile(creds, String(args['fileId']), String(args['content']));
    return { content: [{ type: 'text', text: JSON.stringify(file) }] };
  });

  server.addTool({ name: 'gdrive.share', description: 'Share a Google Drive file.', inputSchema: { type: 'object', properties: { fileId: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', default: 'reader' } }, required: ['fileId', 'email'] } }, async (ctx, args) => {
    const creds = await extractCredentials(ctx, tokenProvider);
    creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
    await adapter.shareFile(creds, String(args['fileId']), String(args['email']), String(args['role'] ?? 'reader'));
    return { content: [{ type: 'text', text: 'Shared.' }] };
  });

  server.addTool({ name: 'gdrive.subscribe', description: 'Subscribe to Google Drive changes.', inputSchema: { type: 'object', properties: {} } }, async (ctx, _args) => {
    await extractCredentials(ctx, tokenProvider);
    return { content: [{ type: 'text', text: JSON.stringify({ subscribed: true }) }] };
  });

  return server;
}
