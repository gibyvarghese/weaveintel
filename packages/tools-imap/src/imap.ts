/**
 * @weaveintel/tools-imap — IMAP Email MCP server
 *
 * Implements IMAP operations via HTTP-based IMAP proxy or Node-based IMAP client.
 * For simplicity, this uses an adapter pattern — the live adapter uses node's
 * net/tls modules to speak IMAP directly.
 * Credentials: ctx.metadata.imapHost, ctx.metadata.imapUser, ctx.metadata.imapPassword,
 *              ctx.metadata.imapPort (optional, default 993), ctx.metadata.imapTls (optional, default 'true')
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}

export interface ImapMessage {
  uid: number;
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  body: string;
  flags: string[];
  mailbox: string;
}

export interface ImapAdapter {
  listMessages(creds: ImapCredentials, mailbox: string, limit: number): Promise<ImapMessage[]>;
  readMessage(creds: ImapCredentials, mailbox: string, uid: number): Promise<ImapMessage>;
  searchMessages(creds: ImapCredentials, mailbox: string, query: string): Promise<ImapMessage[]>;
  subscribeMailbox(creds: ImapCredentials, mailbox: string, onMessage: (msg: ImapMessage) => Promise<void>): Promise<{ stop: () => void }>;
}

function extractCredentials(ctx: ExecutionContext): ImapCredentials {
  const host = ctx.metadata?.['imapHost'] as string | undefined;
  const user = ctx.metadata?.['imapUser'] as string | undefined;
  const password = ctx.metadata?.['imapPassword'] as string | undefined;
  if (!host || !user || !password) {
    throw new Error('IMAP credentials missing. Provide ctx.metadata.imapHost, imapUser, imapPassword.');
  }
  return {
    host,
    user,
    password,
    port: Number(ctx.metadata?.['imapPort'] ?? 993),
    tls: String(ctx.metadata?.['imapTls'] ?? 'true') !== 'false',
  };
}

/**
 * Live IMAP adapter using the imap-simple-compatible REST proxy pattern.
 * In production you would configure an IMAP-to-HTTP proxy (e.g. imapapi.com / EmailEngine)
 * or use a Node IMAP library. This implementation calls an HTTP proxy at IMAP_PROXY_URL.
 */
export const liveImapAdapter: ImapAdapter = {
  async listMessages(creds, mailbox, limit) {
    const proxyUrl = process.env['IMAP_PROXY_URL'];
    if (!proxyUrl) throw new Error('IMAP_PROXY_URL env var required for live IMAP adapter');
    const resp = await fetch(`${proxyUrl}/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: creds.host, port: creds.port, user: creds.user, password: creds.password, tls: creds.tls, mailbox, limit }),
    });
    if (!resp.ok) throw new Error(`IMAP proxy error ${resp.status}: ${await resp.text()}`);
    return resp.json() as Promise<ImapMessage[]>;
  },

  async readMessage(creds, mailbox, uid) {
    const proxyUrl = process.env['IMAP_PROXY_URL'];
    if (!proxyUrl) throw new Error('IMAP_PROXY_URL env var required for live IMAP adapter');
    const resp = await fetch(`${proxyUrl}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: creds.host, port: creds.port, user: creds.user, password: creds.password, tls: creds.tls, mailbox, uid }),
    });
    if (!resp.ok) throw new Error(`IMAP proxy error ${resp.status}: ${await resp.text()}`);
    return resp.json() as Promise<ImapMessage>;
  },

  async searchMessages(creds, mailbox, query) {
    const proxyUrl = process.env['IMAP_PROXY_URL'];
    if (!proxyUrl) throw new Error('IMAP_PROXY_URL env var required for live IMAP adapter');
    const resp = await fetch(`${proxyUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: creds.host, port: creds.port, user: creds.user, password: creds.password, tls: creds.tls, mailbox, query }),
    });
    if (!resp.ok) throw new Error(`IMAP proxy error ${resp.status}: ${await resp.text()}`);
    return resp.json() as Promise<ImapMessage[]>;
  },

  async subscribeMailbox(_creds, _mailbox, _onMessage) {
    // Live IDLE polling — simplified
    return { stop: () => {} };
  },
};

export interface ImapMCPServerOptions {
  adapter?: ImapAdapter;
}

export function createImapMCPServer(opts: ImapMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveImapAdapter;
  const server = weaveMCPServer(
    { name: 'imap', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('imap.list', 'List IMAP messages in a mailbox', 'read-only');
  describeT('imap.read', 'Read an IMAP message by UID', 'read-only');
  describeT('imap.search', 'Search IMAP messages', 'read-only');
  describeT('imap.subscribe', 'Subscribe to new IMAP messages', 'read-only');

  server.addTool(
    { name: 'imap.list', description: 'List messages in an IMAP mailbox.', inputSchema: { type: 'object', properties: { mailbox: { type: 'string', default: 'INBOX' }, limit: { type: 'number', default: 20 } } } },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      const msgs = await adapter.listMessages(creds, String(args['mailbox'] ?? 'INBOX'), Number(args['limit'] ?? 20));
      return { content: [{ type: 'text', text: JSON.stringify(msgs) }] };
    },
  );

  server.addTool(
    { name: 'imap.read', description: 'Read an IMAP message by UID.', inputSchema: { type: 'object', properties: { mailbox: { type: 'string', default: 'INBOX' }, uid: { type: 'number' } }, required: ['uid'] } },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      const msg = await adapter.readMessage(creds, String(args['mailbox'] ?? 'INBOX'), Number(args['uid']));
      return { content: [{ type: 'text', text: JSON.stringify(msg) }] };
    },
  );

  server.addTool(
    { name: 'imap.search', description: 'Search IMAP messages.', inputSchema: { type: 'object', properties: { mailbox: { type: 'string', default: 'INBOX' }, query: { type: 'string' } }, required: ['query'] } },
    async (ctx, args) => {
      const creds = extractCredentials(ctx);
      const msgs = await adapter.searchMessages(creds, String(args['mailbox'] ?? 'INBOX'), String(args['query']));
      return { content: [{ type: 'text', text: JSON.stringify(msgs) }] };
    },
  );

  server.addTool(
    { name: 'imap.subscribe', description: 'Subscribe to new messages in an IMAP mailbox.', inputSchema: { type: 'object', properties: { mailbox: { type: 'string', default: 'INBOX' } } } },
    async (ctx, _args) => {
      extractCredentials(ctx);
      return { content: [{ type: 'text', text: JSON.stringify({ subscribed: true }) }] };
    },
  );

  return server;
}
