/**
 * @weaveintel/tools-gmail — fixture tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createGmailMCPServer, type GmailAdapter, type GmailMessage } from './gmail.js';

// ─── Fixture adapter ────────────────────────────────────────

const FIXTURE_MESSAGE: GmailMessage = {
  id: 'msg-1',
  threadId: 'thread-1',
  from: 'sender@example.com',
  to: ['alice@example.com'],
  subject: 'Hello from fixture',
  snippet: 'Hello world',
  body: 'Hello world, this is a test email.',
  labelIds: ['INBOX'],
  internalDate: '1700000000000',
};

function fixtureAdapter(): GmailAdapter {
  return {
    async listMessages() { return [FIXTURE_MESSAGE]; },
    async readMessage(_creds, messageId) {
      if (messageId === 'msg-1') return FIXTURE_MESSAGE;
      throw new Error(`Unknown message: ${messageId}`);
    },
    async searchMessages() { return [FIXTURE_MESSAGE]; },
    async sendMessage() {
      return { messageId: 'sent-1', threadId: 'thread-sent-1' };
    },
    async labelMessage() {},
    async listThread() { return [FIXTURE_MESSAGE]; },
    async subscribeInbox() { return { stop: () => {} }; },
  };
}

// ─── Tests ────────────────────────────────────────────────────

describe('@weaveintel/tools-gmail (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const adapter = fixtureAdapter();
    const server = createGmailMCPServer({ adapter });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({ metadata: { gmailAccessToken: 'test-token', gmailUserId: 'me' } });

    callTool = async (name, args) => {
      const result = await mcpClient.callTool(ctx, { name, arguments: args });
      return result as { content: Array<{ type: string; text: string }> };
    };
  });

  it('lists tools including gmail.list, gmail.send etc.', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const adapter = fixtureAdapter();
    const server = createGmailMCPServer({ adapter });
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const tools = await mcpClient.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('gmail.list');
    expect(names).toContain('gmail.read');
    expect(names).toContain('gmail.search');
    expect(names).toContain('gmail.send');
    expect(names).toContain('gmail.label');
    expect(names).toContain('gmail.thread');
    expect(names).toContain('gmail.subscribe');
  });

  it('gmail.list returns messages', async () => {
    const result = await callTool('gmail.list', { label: 'INBOX', maxResults: 5 });
    expect(result.content[0]!.type).toBe('text');
    const messages = JSON.parse(result.content[0]!.text);
    expect(Array.isArray(messages)).toBe(true);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].subject).toBe('Hello from fixture');
  });

  it('gmail.read returns a message', async () => {
    const result = await callTool('gmail.read', { messageId: 'msg-1' });
    const msg = JSON.parse(result.content[0]!.text);
    expect(msg.id).toBe('msg-1');
    expect(msg.from).toBe('sender@example.com');
  });

  it('gmail.search returns matching messages', async () => {
    const result = await callTool('gmail.search', { query: 'from:sender@example.com' });
    const messages = JSON.parse(result.content[0]!.text);
    expect(messages[0].subject).toBe('Hello from fixture');
  });

  it('gmail.send sends an email and returns messageId', async () => {
    const result = await callTool('gmail.send', { to: ['bob@example.com'], subject: 'Test', body: 'Hello Bob' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.messageId).toBe('sent-1');
  });

  it('gmail.label applies labels', async () => {
    const result = await callTool('gmail.label', { messageId: 'msg-1', addLabels: ['STARRED'], removeLabels: [] });
    expect(result.content[0]!.text).toContain('Labels updated');
  });

  it('gmail.thread lists thread messages', async () => {
    const result = await callTool('gmail.thread', { threadId: 'thread-1' });
    const messages = JSON.parse(result.content[0]!.text);
    expect(messages[0].threadId).toBe('thread-1');
  });

  it('gmail.subscribe returns subscribed status', async () => {
    const result = await callTool('gmail.subscribe', { label: 'INBOX' });
    const data = JSON.parse(result.content[0]!.text);
    expect(data.subscribed).toBe(true);
  });

  it('returns error when access token missing', async () => {
    const adapter = fixtureAdapter();
    const server = createGmailMCPServer({ adapter });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctxNoToken = weaveContext({});
    await expect(mcpClient.callTool(ctxNoToken, { name: 'gmail.list', arguments: {} })).rejects.toThrow();
  });
});

// ─── Live-sandbox tests (env-gated) ──────────────────────────

describe('@weaveintel/tools-gmail (live-sandbox)', () => {
  if (!process.env['TEST_LIVE_SANDBOX'] || !process.env['GMAIL_ACCESS_TOKEN']) {
    it.skip('skipped — set TEST_LIVE_SANDBOX=1 and GMAIL_ACCESS_TOKEN to run', () => {});
    return;
  }

  it('lists inbox messages from real Gmail account', async () => {
    const { liveGmailAdapter } = await import('./gmail.js');
    const creds = { accessToken: process.env['GMAIL_ACCESS_TOKEN']!, userId: 'me' };
    const messages = await liveGmailAdapter.listMessages(creds, 'INBOX', 5);
    expect(Array.isArray(messages)).toBe(true);
  });
});
