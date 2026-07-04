import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createImapMCPServer, type ImapAdapter, type ImapMessage } from './imap.js';

const FIXTURE_MSG: ImapMessage = {
  uid: 1, messageId: '<msg1@example.com>', from: 'sender@example.com', to: ['alice@example.com'],
  subject: 'IMAP Test', date: '2025-01-01T00:00:00Z', body: 'Test body', flags: ['\\Seen'], mailbox: 'INBOX',
};

function fixtureAdapter(): ImapAdapter {
  return {
    async listMessages() { return [FIXTURE_MSG]; },
    async readMessage() { return FIXTURE_MSG; },
    async searchMessages() { return [FIXTURE_MSG]; },
    async subscribeMailbox() { return { stop: () => {} }; },
  };
}

const CTX_METADATA = { imapHost: 'imap.example.com', imapUser: 'alice', imapPassword: 'secret' };

describe('@weaveintel/tools-imap (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createImapMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({ metadata: CTX_METADATA });
    callTool = async (name, args) => mcpClient.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 4 IMAP tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createImapMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    const tools = await mc.listTools();
    expect(tools.length).toBe(4);
    expect(tools.map((t) => t.name)).toContain('imap.list');
  });

  it('imap.list returns messages', async () => {
    const result = await callTool('imap.list', { mailbox: 'INBOX' });
    const msgs = JSON.parse(result.content[0]!.text);
    expect(msgs[0].subject).toBe('IMAP Test');
  });

  it('imap.search returns results', async () => {
    const result = await callTool('imap.search', { query: 'Test' });
    expect(JSON.parse(result.content[0]!.text)[0].uid).toBe(1);
  });

  it('rejects missing credentials', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createImapMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    await expect(mc.callTool(weaveContext({}), { name: 'imap.list', arguments: {} })).rejects.toThrow();
  });
});
