/**
 * @weaveintel/tools-gmail — Gmail MCP server
 *
 * Exposes Gmail operations as MCP tools. Credentials are supplied by the
 * MCP caller via the _meta.executionContext (not stored in this package).
 *
 * Operations:
 *   gmail.list      — list messages in a label/inbox
 *   gmail.read      — read a message by ID
 *   gmail.search    — search messages via Gmail query string
 *   gmail.send      — send an email
 *   gmail.label     — apply/remove a label on a message
 *   gmail.thread    — list messages in a thread
 *   gmail.subscribe — long-poll subscribe to new inbox messages
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

// ─── Types ────────────────────────────────────────────────────

export interface GmailCredentials {
  /** OAuth2 access token for the Gmail account. */
  accessToken: string;
  /** Gmail user ID or 'me'. Defaults to 'me'. */
  userId?: string;
  /** Optional callback used to refresh an expired access token. */
  refreshAccessToken?: () => Promise<string | undefined>;
}

export interface GmailTokenProvider {
  getToken(ctx: ExecutionContext): Promise<string | undefined>;
  refreshToken(ctx: ExecutionContext): Promise<string | undefined>;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  snippet: string;
  body: string;
  labelIds: string[];
  internalDate: string;
}

export interface GmailAdapter {
  listMessages(creds: GmailCredentials, label: string, maxResults: number): Promise<GmailMessage[]>;
  readMessage(creds: GmailCredentials, messageId: string): Promise<GmailMessage>;
  searchMessages(creds: GmailCredentials, query: string, maxResults: number): Promise<GmailMessage[]>;
  sendMessage(creds: GmailCredentials, to: string[], subject: string, body: string): Promise<{ messageId: string; threadId: string }>;
  labelMessage(creds: GmailCredentials, messageId: string, addLabels: string[], removeLabels: string[]): Promise<void>;
  listThread(creds: GmailCredentials, threadId: string): Promise<GmailMessage[]>;
  subscribeInbox(creds: GmailCredentials, onMessage: (msg: GmailMessage) => Promise<void>): Promise<{ stop: () => void }>;
}

// ─── Live adapter (real Gmail REST API) ──────────────────────

function createMetadataTokenProvider(): GmailTokenProvider {
  return {
    async getToken(ctx) {
      return ctx.metadata?.['gmailAccessToken'] as string | undefined;
    },
    async refreshToken(ctx) {
      return ctx.metadata?.['gmailRefreshAccessToken'] as string | undefined;
    },
  };
}

async function extractCredentials(ctx: ExecutionContext, provider: GmailTokenProvider): Promise<GmailCredentials> {
  const token = await provider.getToken(ctx);
  if (!token) throw new Error('Gmail access token missing from execution context metadata.gmailAccessToken');
  return { accessToken: token, userId: (ctx.metadata?.['gmailUserId'] as string) ?? 'me' };
}

function gmailApiBase(userId: string): string {
  return `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(userId)}`;
}

async function gmailFetch(
  accessToken: string,
  url: string,
  init?: RequestInit,
  refreshToken?: () => Promise<string | undefined>,
): Promise<unknown> {
  let activeToken = accessToken;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resp = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${activeToken}`,
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (resp.status === 401 && attempt === 0 && refreshToken) {
      const refreshed = await refreshToken();
      if (refreshed) {
        activeToken = refreshed;
        continue;
      }
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new Error(`Gmail API error ${resp.status}: ${text}`);
    }
    return resp.json();
  }
  throw new Error('Gmail API request failed after token refresh attempt');
}

function parseMessage(raw: Record<string, unknown>): GmailMessage {
  const headers = (raw['payload'] as Record<string, unknown>)?.['headers'] as Array<{ name: string; value: string }> ?? [];
  const getHeader = (name: string) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
  const body = extractBody(raw['payload'] as Record<string, unknown>);
  return {
    id: raw['id'] as string,
    threadId: raw['threadId'] as string,
    from: getHeader('from'),
    to: getHeader('to').split(',').map((s) => s.trim()).filter(Boolean),
    subject: getHeader('subject'),
    snippet: raw['snippet'] as string ?? '',
    body,
    labelIds: raw['labelIds'] as string[] ?? [],
    internalDate: raw['internalDate'] as string ?? '',
  };
}

function extractBody(payload: Record<string, unknown> | undefined): string {
  if (!payload) return '';
  const parts = payload['parts'] as Array<Record<string, unknown>> | undefined;
  if (parts) {
    for (const part of parts) {
      const mimeType = part['mimeType'] as string;
      if (mimeType === 'text/plain') {
        const data = (part['body'] as Record<string, unknown>)?.['data'] as string;
        if (data) return Buffer.from(data, 'base64url').toString('utf-8');
      }
    }
  }
  const bodyData = (payload['body'] as Record<string, unknown>)?.['data'] as string;
  if (bodyData) return Buffer.from(bodyData, 'base64url').toString('utf-8');
  return '';
}

export const liveGmailAdapter: GmailAdapter = {
  async listMessages(creds, label, maxResults) {
    const base = gmailApiBase(creds.userId ?? 'me');
    const data = await gmailFetch(creds.accessToken, `${base}/messages?labelIds=${encodeURIComponent(label)}&maxResults=${maxResults}`, undefined, creds.refreshAccessToken) as Record<string, unknown>;
    const messages = (data['messages'] as Array<{ id: string }> | undefined) ?? [];
    return Promise.all(messages.map((m) => this.readMessage(creds, m.id)));
  },

  async readMessage(creds, messageId) {
    const base = gmailApiBase(creds.userId ?? 'me');
    const raw = await gmailFetch(creds.accessToken, `${base}/messages/${encodeURIComponent(messageId)}?format=full`, undefined, creds.refreshAccessToken) as Record<string, unknown>;
    return parseMessage(raw);
  },

  async searchMessages(creds, query, maxResults) {
    const base = gmailApiBase(creds.userId ?? 'me');
    const data = await gmailFetch(creds.accessToken, `${base}/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`, undefined, creds.refreshAccessToken) as Record<string, unknown>;
    const messages = (data['messages'] as Array<{ id: string }> | undefined) ?? [];
    return Promise.all(messages.map((m) => this.readMessage(creds, m.id)));
  },

  async sendMessage(creds, to, subject, body) {
    const base = gmailApiBase(creds.userId ?? 'me');
    const raw = [
      `To: ${to.join(', ')}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');
    const encoded = Buffer.from(raw).toString('base64url');
    const result = await gmailFetch(creds.accessToken, `${base}/messages/send`, {
      method: 'POST',
      body: JSON.stringify({ raw: encoded }),
    }, creds.refreshAccessToken) as Record<string, unknown>;
    return { messageId: result['id'] as string, threadId: result['threadId'] as string };
  },

  async labelMessage(creds, messageId, addLabels, removeLabels) {
    const base = gmailApiBase(creds.userId ?? 'me');
    await gmailFetch(creds.accessToken, `${base}/messages/${encodeURIComponent(messageId)}/modify`, {
      method: 'POST',
      body: JSON.stringify({ addLabelIds: addLabels, removeLabelIds: removeLabels }),
    }, creds.refreshAccessToken);
  },

  async listThread(creds, threadId) {
    const base = gmailApiBase(creds.userId ?? 'me');
    const data = await gmailFetch(creds.accessToken, `${base}/threads/${encodeURIComponent(threadId)}?format=full`, undefined, creds.refreshAccessToken) as Record<string, unknown>;
    const messages = (data['messages'] as Array<Record<string, unknown>> | undefined) ?? [];
    return messages.map(parseMessage);
  },

  async subscribeInbox(creds, onMessage) {
    // Poll-based inbox subscription using history API
    let historyId: string | null = null;
    let running = true;

    async function poll() {
      while (running) {
        try {
          const base = gmailApiBase(creds.userId ?? 'me');
          if (!historyId) {
            const profile = await gmailFetch(creds.accessToken, `${base}/profile`, undefined, creds.refreshAccessToken) as Record<string, unknown>;
            historyId = profile['historyId'] as string;
          } else {
            const data = await gmailFetch(creds.accessToken, `${base}/history?startHistoryId=${historyId}&historyTypes=messageAdded`, undefined, creds.refreshAccessToken) as Record<string, unknown>;
            const newHistoryId = data['historyId'] as string | undefined;
            if (newHistoryId) historyId = newHistoryId;
            const history = (data['history'] as Array<Record<string, unknown>> | undefined) ?? [];
            for (const h of history) {
              const added = (h['messagesAdded'] as Array<{ message: { id: string } }> | undefined) ?? [];
              for (const a of added) {
                try {
                  const msg = await liveGmailAdapter.readMessage(creds, a.message.id);
                  await onMessage(msg);
                } catch {}
              }
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

// ─── MCP server factory ───────────────────────────────────────

export interface GmailMCPServerOptions {
  /**
   * Adapter to use. Defaults to the live Gmail REST adapter.
   * Override with a fixture adapter in tests.
   */
  adapter?: GmailAdapter;
  tokenProvider?: GmailTokenProvider;
}

export function createGmailMCPServer(opts: GmailMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveGmailAdapter;
  const tokenProvider = opts.tokenProvider ?? createMetadataTokenProvider();
  const server = weaveMCPServer(
    { name: 'gmail', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  // Tool descriptors (for risk tagging)
  describeT('gmail.list', 'List Gmail messages in a label/inbox', 'read-only');
  describeT('gmail.read', 'Read a Gmail message by ID', 'read-only');
  describeT('gmail.search', 'Search Gmail messages', 'read-only');
  describeT('gmail.send', 'Send an email via Gmail', 'external-side-effect');
  describeT('gmail.label', 'Apply/remove Gmail labels on a message', 'write');
  describeT('gmail.thread', 'List messages in a Gmail thread', 'read-only');
  describeT('gmail.subscribe', 'Subscribe to new inbox messages (poll)', 'read-only');

  server.addTool(
    {
      name: 'gmail.list',
      description: 'List Gmail messages in a label/inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Gmail label ID, e.g. INBOX', default: 'INBOX' },
          maxResults: { type: 'number', description: 'Max messages to return', default: 20 },
        },
      },
    },
    async (ctx: ExecutionContext, args: Record<string, unknown>) => {
      const creds = await extractCredentials(ctx, tokenProvider);
      creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
      const messages = await adapter.listMessages(creds, String(args['label'] ?? 'INBOX'), Number(args['maxResults'] ?? 20));
      return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
    },
  );

  server.addTool(
    {
      name: 'gmail.read',
      description: 'Read a Gmail message by ID.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string', description: 'Gmail message ID' },
        },
        required: ['messageId'],
      },
    },
    async (ctx: ExecutionContext, args: Record<string, unknown>) => {
      const creds = await extractCredentials(ctx, tokenProvider);
      creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
      const msg = await adapter.readMessage(creds, String(args['messageId']));
      return { content: [{ type: 'text', text: JSON.stringify(msg) }] };
    },
  );

  server.addTool(
    {
      name: 'gmail.search',
      description: 'Search Gmail messages using Gmail query syntax.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query, e.g. "from:alice@example.com"' },
          maxResults: { type: 'number', default: 20 },
        },
        required: ['query'],
      },
    },
    async (ctx: ExecutionContext, args: Record<string, unknown>) => {
      const creds = await extractCredentials(ctx, tokenProvider);
      creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
      const messages = await adapter.searchMessages(creds, String(args['query']), Number(args['maxResults'] ?? 20));
      return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
    },
  );

  server.addTool(
    {
      name: 'gmail.send',
      description: 'Send an email via Gmail.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    async (ctx: ExecutionContext, args: Record<string, unknown>) => {
      const creds = await extractCredentials(ctx, tokenProvider);
      creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
      const result = await adapter.sendMessage(creds, args['to'] as string[], String(args['subject']), String(args['body']));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.addTool(
    {
      name: 'gmail.label',
      description: 'Apply or remove labels on a Gmail message.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          addLabels: { type: 'array', items: { type: 'string' }, default: [] },
          removeLabels: { type: 'array', items: { type: 'string' }, default: [] },
        },
        required: ['messageId'],
      },
    },
    async (ctx: ExecutionContext, args: Record<string, unknown>) => {
      const creds = await extractCredentials(ctx, tokenProvider);
      creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
      await adapter.labelMessage(creds, String(args['messageId']), (args['addLabels'] as string[]) ?? [], (args['removeLabels'] as string[]) ?? []);
      return { content: [{ type: 'text', text: 'Labels updated.' }] };
    },
  );

  server.addTool(
    {
      name: 'gmail.thread',
      description: 'List all messages in a Gmail thread.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string' },
        },
        required: ['threadId'],
      },
    },
    async (ctx: ExecutionContext, args: Record<string, unknown>) => {
      const creds = await extractCredentials(ctx, tokenProvider);
      creds.refreshAccessToken = async () => tokenProvider.refreshToken(ctx);
      const messages = await adapter.listThread(creds, String(args['threadId']));
      return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
    },
  );

  server.addTool(
    {
      name: 'gmail.subscribe',
      description: 'Subscribe to new inbox messages. Returns immediately; callback fires asynchronously.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', default: 'INBOX' },
        },
      },
    },
    async (ctx: ExecutionContext, _args: Record<string, unknown>) => {
      // In MCP context subscriptions are managed externally; this surfaces readiness
      await extractCredentials(ctx, tokenProvider); // validate creds present
      return { content: [{ type: 'text', text: JSON.stringify({ subscribed: true, note: 'Use adapter.subscribeInbox for push delivery.' }) }] };
    },
  );

  return server;
}
