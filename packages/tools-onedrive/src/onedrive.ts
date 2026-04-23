/**
 * @weaveintel/tools-onedrive — Microsoft OneDrive MCP server
 * Uses Microsoft Graph API /me/drive. Credentials: ctx.metadata.onedriveAccessToken
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface OnedriveCredentials { accessToken: string; userId?: string; }
export interface OnedriveItem { id: string; name: string; size?: number; lastModifiedDateTime: string; folder?: boolean; webUrl?: string; parentId?: string; }

export interface OnedriveAdapter {
  listItems(creds: OnedriveCredentials, path: string): Promise<OnedriveItem[]>;
  readItem(creds: OnedriveCredentials, itemId: string): Promise<{ item: OnedriveItem; content: string }>;
  createItem(creds: OnedriveCredentials, path: string, content: string): Promise<OnedriveItem>;
  updateItem(creds: OnedriveCredentials, itemId: string, content: string): Promise<OnedriveItem>;
  shareItem(creds: OnedriveCredentials, itemId: string, email: string, role: string): Promise<{ shareLink?: string }>;
  subscribeChanges(creds: OnedriveCredentials, onItem: (i: OnedriveItem) => Promise<void>): Promise<{ stop: () => void }>;
}

function extractCredentials(ctx: ExecutionContext): OnedriveCredentials {
  const token = ctx.metadata?.['onedriveAccessToken'] as string | undefined;
  if (!token) throw new Error('OneDrive access token missing from ctx.metadata.onedriveAccessToken');
  return { accessToken: token, userId: ctx.metadata?.['onedriveUserId'] as string | undefined };
}

function driveBase(userId?: string) {
  const id = userId && userId !== 'me' ? `users/${encodeURIComponent(userId)}` : 'me';
  return `https://graph.microsoft.com/v1.0/${id}/drive`;
}

async function driveFetch(token: string, url: string, init?: RequestInit): Promise<unknown> {
  const resp = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers as Record<string, string> | undefined) },
  });
  if (!resp.ok) throw new Error(`Graph OneDrive ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
  if (resp.status === 204) return {};
  const ct = resp.headers.get('Content-Type') ?? '';
  return ct.includes('application/json') ? resp.json() : resp.text();
}

function parseItem(raw: Record<string, unknown>): OnedriveItem {
  return {
    id: raw['id'] as string,
    name: raw['name'] as string,
    size: raw['size'] ? Number(raw['size']) : undefined,
    lastModifiedDateTime: raw['lastModifiedDateTime'] as string ?? '',
    folder: !!(raw['folder']),
    webUrl: raw['webUrl'] as string | undefined,
    parentId: (raw['parentReference'] as Record<string, unknown> | undefined)?.['id'] as string | undefined,
  };
}

export const liveOnedriveAdapter: OnedriveAdapter = {
  async listItems(creds, path) {
    const base = driveBase(creds.userId);
    const endpoint = path && path !== '/' ? `${base}/root:${path}:/children` : `${base}/root/children`;
    const data = await driveFetch(creds.accessToken, endpoint) as Record<string, unknown>;
    return ((data['value'] as Array<Record<string, unknown>>) ?? []).map(parseItem);
  },
  async readItem(creds, itemId) {
    const base = driveBase(creds.userId);
    const meta = await driveFetch(creds.accessToken, `${base}/items/${itemId}`) as Record<string, unknown>;
    const content = await driveFetch(creds.accessToken, `${base}/items/${itemId}/content`) as string;
    return { item: parseItem(meta), content: String(content) };
  },
  async createItem(creds, path, content) {
    const base = driveBase(creds.userId);
    const raw = await driveFetch(creds.accessToken, `${base}/root:${path}:/content`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content }) as Record<string, unknown>;
    return parseItem(raw);
  },
  async updateItem(creds, itemId, content) {
    const base = driveBase(creds.userId);
    const raw = await driveFetch(creds.accessToken, `${base}/items/${itemId}/content`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: content }) as Record<string, unknown>;
    return parseItem(raw);
  },
  async shareItem(creds, itemId, email, role) {
    const base = driveBase(creds.userId);
    const raw = await driveFetch(creds.accessToken, `${base}/items/${itemId}/invite`, { method: 'POST', body: JSON.stringify({ recipients: [{ email }], roles: [role], sendInvitation: false }) }) as Record<string, unknown>;
    const perms = (raw['value'] as Array<Record<string, unknown>>) ?? [];
    const link = (perms[0]?.['link'] as Record<string, unknown>)?.['webUrl'] as string | undefined;
    return { shareLink: link };
  },
  async subscribeChanges() { return { stop: () => {} }; },
};

export interface OnedriveMCPServerOptions { adapter?: OnedriveAdapter; }

export function createOnedriveMCPServer(opts: OnedriveMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveOnedriveAdapter;
  const server = weaveMCPServer(
    { name: 'onedrive', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('onedrive.list', 'List OneDrive items', 'read-only');
  describeT('onedrive.read', 'Read a OneDrive item', 'read-only');
  describeT('onedrive.create', 'Create a OneDrive item', 'write');
  describeT('onedrive.update', 'Update a OneDrive item', 'write');
  describeT('onedrive.share', 'Share a OneDrive item', 'write');
  describeT('onedrive.subscribe', 'Subscribe to OneDrive changes', 'read-only');

  server.addTool({ name: 'onedrive.list', description: 'List items in OneDrive.', inputSchema: { type: 'object', properties: { path: { type: 'string', default: '/' } } } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.listItems(creds, String(args['path'] ?? '/'))) }] };
  });

  server.addTool({ name: 'onedrive.read', description: 'Read a OneDrive item.', inputSchema: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.readItem(creds, String(args['itemId']))) }] };
  });

  server.addTool({ name: 'onedrive.create', description: 'Create a file in OneDrive.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.createItem(creds, String(args['path']), String(args['content']))) }] };
  });

  server.addTool({ name: 'onedrive.update', description: 'Update a OneDrive file.', inputSchema: { type: 'object', properties: { itemId: { type: 'string' }, content: { type: 'string' } }, required: ['itemId', 'content'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.updateItem(creds, String(args['itemId']), String(args['content']))) }] };
  });

  server.addTool({ name: 'onedrive.share', description: 'Share a OneDrive item.', inputSchema: { type: 'object', properties: { itemId: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', default: 'read' } }, required: ['itemId', 'email'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    return { content: [{ type: 'text', text: JSON.stringify(await adapter.shareItem(creds, String(args['itemId']), String(args['email']), String(args['role'] ?? 'read'))) }] };
  });

  server.addTool({ name: 'onedrive.subscribe', description: 'Subscribe to OneDrive changes.', inputSchema: { type: 'object', properties: {} } }, async (ctx) => {
    extractCredentials(ctx);
    return { content: [{ type: 'text', text: JSON.stringify({ subscribed: true }) }] };
  });

  return server;
}
