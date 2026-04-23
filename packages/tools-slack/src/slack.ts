/**
 * @weaveintel/tools-slack — Slack MCP server
 * Uses Slack Web API (https://slack.com/api/). Credentials: ctx.metadata.slackBotToken
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';

export interface SlackCredentials { botToken: string; }

export interface SlackMessage {
  ts: string;
  channel: string;
  user?: string;
  text: string;
  thread_ts?: string;
}

export interface SlackAdapter {
  postMessage(creds: SlackCredentials, channel: string, text: string, threadTs?: string): Promise<SlackMessage>;
  readChannel(creds: SlackCredentials, channel: string, limit: number, cursor?: string): Promise<{ messages: SlackMessage[]; nextCursor?: string }>;
  search(creds: SlackCredentials, query: string, count: number): Promise<SlackMessage[]>;
  subscribeEvents(creds: SlackCredentials, onEvent: (e: SlackMessage) => Promise<void>): Promise<{ stop: () => void }>;
}

function extractCredentials(ctx: ExecutionContext): SlackCredentials {
  const token = ctx.metadata?.['slackBotToken'] as string | undefined;
  if (!token) throw new Error('Slack bot token missing from ctx.metadata.slackBotToken');
  return { botToken: token };
}

async function slackFetch(token: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const resp = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params),
  });
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);
  const data = await resp.json() as Record<string, unknown>;
  if (!data['ok']) throw new Error(`Slack API error: ${data['error'] ?? 'unknown'}`);
  return data;
}

function parseMessage(raw: Record<string, unknown>, channel: string): SlackMessage {
  return {
    ts: raw['ts'] as string,
    channel: (raw['channel'] as string | undefined) ?? channel,
    user: raw['user'] as string | undefined,
    text: raw['text'] as string ?? '',
    thread_ts: raw['thread_ts'] as string | undefined,
  };
}

export const liveSlackAdapter: SlackAdapter = {
  async postMessage(creds, channel, text, threadTs) {
    const params: Record<string, unknown> = { channel, text };
    if (threadTs) params['thread_ts'] = threadTs;
    const data = await slackFetch(creds.botToken, 'chat.postMessage', params);
    return parseMessage(data['message'] as Record<string, unknown>, channel);
  },
  async readChannel(creds, channel, limit, cursor) {
    const params: Record<string, unknown> = { channel, limit };
    if (cursor) params['cursor'] = cursor;
    const data = await slackFetch(creds.botToken, 'conversations.history', params);
    const messages = ((data['messages'] as Array<Record<string, unknown>>) ?? []).map((m) => parseMessage(m, channel));
    const meta = data['response_metadata'] as Record<string, string> | undefined;
    return { messages, nextCursor: meta?.['next_cursor'] || undefined };
  },
  async search(creds, query, count) {
    const data = await slackFetch(creds.botToken, 'search.messages', { query, count });
    const msgs = data['messages'] as Record<string, unknown> | undefined;
    const matches = (msgs?.['matches'] as Array<Record<string, unknown>>) ?? [];
    return matches.map((m) => parseMessage(m, (m['channel'] as Record<string, string>)?.['id'] ?? ''));
  },
  async subscribeEvents() { return { stop: () => {} }; },
};

export interface SlackMCPServerOptions { adapter?: SlackAdapter; }

export function createSlackMCPServer(opts: SlackMCPServerOptions = {}) {
  const adapter = opts.adapter ?? liveSlackAdapter;
  const server = weaveMCPServer(
    { name: 'slack', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('slack.post', 'Post a message to a Slack channel', 'external-side-effect');
  describeT('slack.read-channel', 'Read messages from a Slack channel', 'read-only');
  describeT('slack.search', 'Search Slack messages', 'read-only');
  describeT('slack.subscribe', 'Subscribe to Slack events', 'read-only');

  server.addTool({ name: 'slack.post', description: 'Post a message to a Slack channel or thread.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' }, threadTs: { type: 'string' } }, required: ['channel', 'text'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const msg = await adapter.postMessage(creds, String(args['channel']), String(args['text']), args['threadTs'] as string | undefined);
    return { content: [{ type: 'text', text: JSON.stringify(msg) }] };
  });

  server.addTool({ name: 'slack.read-channel', description: 'Read message history from a Slack channel.', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number', default: 20 }, cursor: { type: 'string' } }, required: ['channel'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const result = await adapter.readChannel(creds, String(args['channel']), Number(args['limit'] ?? 20), args['cursor'] as string | undefined);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.addTool({ name: 'slack.search', description: 'Search Slack messages by query.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, count: { type: 'number', default: 10 } }, required: ['query'] } }, async (ctx, args) => {
    const creds = extractCredentials(ctx);
    const messages = await adapter.search(creds, String(args['query']), Number(args['count'] ?? 10));
    return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
  });

  server.addTool({ name: 'slack.subscribe', description: 'Subscribe to Slack event stream (requires Events API config).', inputSchema: { type: 'object', properties: {} } }, async (ctx) => {
    extractCredentials(ctx);
    return { content: [{ type: 'text', text: JSON.stringify({ subscribed: true }) }] };
  });

  return server;
}
