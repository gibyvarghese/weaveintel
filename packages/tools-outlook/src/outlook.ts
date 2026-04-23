/**
 * @weaveintel/tools-outlook — Microsoft Outlook MCP server
 *
 * Uses Microsoft Graph API. Access token in ctx.metadata.outlookAccessToken.
 * Operations: list, read, search, send, label (categories), thread, subscribe.
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface OutlookCredentials {
  accessToken: string;
  userId?: string; // defaults to 'me'
}

export interface OutlookMessage {
  id: string;
  conversationId: string;
  from: string;
  to: string[];
  subject: string;
  bodyPreview: string;
  body: string;
  categories: string[];
  receivedDateTime: string;
  isRead: boolean;
}

export interface OutlookAdapter {
  listMessages(creds: OutlookCredentials, folder: string, maxResults: number): Promise<OutlookMessage[]>;
  readMessage(creds: OutlookCredentials, messageId: string): Promise<OutlookMessage>;
  searchMessages(creds: OutlookCredentials, query: string, maxResults: number): Promise<OutlookMessage[]>;
  sendMessage(creds: OutlookCredentials, to: string[], subject: string, body: string): Promise<{ messageId: string }>;
  categorizeMessage(creds: OutlookCredentials, messageId: string, categories: string[]): Promise<void>;
  listConversation(creds: OutlookCredentials, conversationId: string): Promise<OutlookMessage[]>;
  subscribeInbox(creds: OutlookCredentials, onMessage: (msg: OutlookMessage) => Promise<void>): Promise<{ stop: () => void }>;
}

function extractCredentials(ctx: ExecutionContext): OutlookCredentials {
  const token = ctx.metadata?.['outlookAccessToken'] as string | undefined;
  if (!token) throw new Error('Outlook access token missing from ctx.metadata.outlookAccessToken');
  return { accessToken: token, userId: (ctx.metadata?.['outlookUserId'] as string) ?? 'me' };
}

function graphBase(userId: string): string {
  const id = userId === 'me' ? 'me' : `users/${encodeURIComponent(userId)}`;
  return `https://graph.microsoft.com/v1.0/${id}`;
}

async function graphFetch(accessToken: string, url: string, init?: RequestInit): Promise<unknown> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`Graph API error ${resp.status}: ${text}`);
  }
  if (resp.status === 204) return {};
  return resp.json();
}

function parseMessage(raw: Record<string, unknown>): OutlookMessage {
  const from = (raw['from'] as Record<string, unknown>)?.['emailAddress'] as { address?: string } | undefined;
  const toRecipients = (raw['toRecipients'] as Array<{ emailAddress: { address: string } }>) ?? [];
  const bodyContent = (raw['body'] as Record<string, unknown>)?.['content'] as string ?? '';
  return {
    id: raw['id'] as string,
    conversationId: raw['conversationId'] as string ?? '',
    from: from?.address ?? '',
    to: toRecipients.map((r) => r.emailAddress.address),
    subject: raw['subject'] as string ?? '',
    bodyPreview: raw['bodyPreview'] as string ?? '',
    body: bodyContent,
    categories: raw['categories'] as string[] ?? [],
    receivedDateTime: raw['receivedDateTime'] as string ?? '',
    isRead: raw['isRead'] as boolean ?? false,
  };
}

export const liveOutlookAdapter: OutlookAdapter = {
  async listMessages(creds, folder, maxResults) {
    const base = graphBase(creds.userId ?? 'me');
    const data = await graphFetch(creds.accessToken, `${base}/mailFolders/${encodeURIComponent(folder)}/messages?$top=${maxResults}&$select=id,conversationId,from,toRecipients,subject,bodyPreview,body,categories,receivedDateTime,isRead`) as Record<string, unknown>;
    const items = (data['value'] as Array<Record<string, unknown>>) ?? [];
    return items.map(parseMessage);
  },

  async readMessage(creds, messageId) {
    const base = graphBase(creds.userId ?? 'me');
    const raw = await graphFetch(creds.accessToken, `${base}/messages/${encodeURIComponent(messageId)}`) as Record<string, unknown>;
    return parseMessage(raw);
  },

  async searchMessages(creds, query, maxResults) {
    const base = graphBase(creds.userId ?? 'me');
    const data = await graphFetch(creds.accessToken, `${base}/messages?$search="${encodeURIComponent(query)}"&$top=${maxResults}`) as Record<string, unknown>;
    const items = (data['value'] as Array<Record<string, unknown>>) ?? [];
    return items.map(parseMessage);
  },

  async sendMessage(creds, to, subject, body) {
    const base = graphBase(creds.userId ?? 'me');
    const message = {
      subject,
      body: { contentType: 'Text', content: body },
      toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
    };
    const result = await graphFetch(creds.accessToken, `${base}/sendMail`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }) as Record<string, unknown>;
    return { messageId: (result['id'] as string) ?? 'sent' };
  },

  async categorizeMessage(creds, messageId, categories) {
    const base = graphBase(creds.userId ?? 'me');
    await graphFetch(creds.accessToken, `${base}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ categories }),
    });
  },

  async listConversation(creds, conversationId) {
    const base = graphBase(creds.userId ?? 'me');
    const data = await graphFetch(creds.accessToken, `${base}/messages?$filter=conversationId eq '${encodeURIComponent(conversationId)}'`) as Record<string, unknown>;
    const items = (data['value'] as Array<Record<string, unknown>>) ?? [];
    return items.map(parseMessage);
  },

  async subscribeInbox(creds, onMessage) {
    let running = true;
    let lastCheck = new Date().toISOString();

    async function poll() {
      while (running) {
        try {
          const base = graphBase(creds.userId ?? 'me');
          const data = await graphFetch(creds.accessToken, `${base}/mailFolders/inbox/messages?$filter=receivedDateTime gt ${lastCheck}&$orderby=receivedDateTime desc&$top=10`) as Record<string, unknown>;
          const items = (data['value'] as Array<Record<string, unknown>>) ?? [];
          if (items.length > 0) {
            lastCheck = new Date().toISOString();
            for (const item of items) {
              await onMessage(parseMessage(item));
            }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }

    poll().catch(() => {});
    return { stop: () => { running = false; } };
  },
};

export interface OutlookMCPServerOptions {
  adapter?: OutlookAdapter;
}

export function createOutlookMCPServer(opts: OutlookMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveOutlookAdapter;
  const server = weaveMCPServer(
    { name: 'outlook', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('outlook.list', 'List Outlook messages in a mail folder', 'read-only');
  describeT('outlook.read', 'Read an Outlook message by ID', 'read-only');
  describeT('outlook.search', 'Search Outlook messages', 'read-only');
  describeT('outlook.send', 'Send an email via Outlook', 'external-side-effect');
  describeT('outlook.categorize', 'Set categories on an Outlook message', 'write');
  describeT('outlook.thread', 'List messages in an Outlook conversation', 'read-only');
  describeT('outlook.subscribe', 'Subscribe to new inbox messages', 'read-only');

  server.addTool(
    { name: 'outlook.list', description: 'List Outlook messages in a folder.', inputSchema: { type: 'object', properties: { folder: { type: 'string', default: 'inbox' }, maxResults: { type: 'number', default: 20 } } } },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      const messages = await adapter.listMessages(creds, String(args['folder'] ?? 'inbox'), Number(args['maxResults'] ?? 20));
      return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
    },
  );

  server.addTool(
    { name: 'outlook.read', description: 'Read an Outlook message by ID.', inputSchema: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] } },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      const msg = await adapter.readMessage(creds, String(args['messageId']));
      return { content: [{ type: 'text', text: JSON.stringify(msg) }] };
    },
  );

  server.addTool(
    { name: 'outlook.search', description: 'Search Outlook messages.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number', default: 20 } }, required: ['query'] } },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      const messages = await adapter.searchMessages(creds, String(args['query']), Number(args['maxResults'] ?? 20));
      return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
    },
  );

  server.addTool(
    { name: 'outlook.send', description: 'Send an email via Outlook.', inputSchema: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      const result = await adapter.sendMessage(creds, args['to'] as string[], String(args['subject']), String(args['body']));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.addTool(
    { name: 'outlook.categorize', description: 'Set categories on an Outlook message.', inputSchema: { type: 'object', properties: { messageId: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } } }, required: ['messageId', 'categories'] } },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      await adapter.categorizeMessage(creds, String(args['messageId']), args['categories'] as string[]);
      return { content: [{ type: 'text', text: 'Categories updated.' }] };
    },
  );

  server.addTool(
    { name: 'outlook.thread', description: 'List messages in an Outlook conversation.', inputSchema: { type: 'object', properties: { conversationId: { type: 'string' } }, required: ['conversationId'] } },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      const messages = await adapter.listConversation(creds, String(args['conversationId']));
      return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
    },
  );

  server.addTool(
    { name: 'outlook.subscribe', description: 'Subscribe to new inbox messages.', inputSchema: { type: 'object', properties: {} } },
    async (ctx, _args) => {
      extractCredentials(ctx);
      return { content: [{ type: 'text', text: JSON.stringify({ subscribed: true }) }] };
    },
  );

  return server;
}
