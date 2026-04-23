import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createOutlookMCPServer, type OutlookAdapter, type OutlookMessage } from './outlook.js';

const FIXTURE_MSG: OutlookMessage = {
  id: 'msg-1', conversationId: 'conv-1', from: 'sender@example.com', to: ['alice@example.com'],
  subject: 'Hello Outlook', bodyPreview: 'Hi there', body: 'Hi there, this is Outlook.',
  categories: [], receivedDateTime: '2025-01-01T00:00:00Z', isRead: false,
};

function fixtureAdapter(): OutlookAdapter {
  return {
    async listMessages() { return [FIXTURE_MSG]; },
    async readMessage() { return FIXTURE_MSG; },
    async searchMessages() { return [FIXTURE_MSG]; },
    async sendMessage() { return { messageId: 'sent-1' }; },
    async categorizeMessage() {},
    async listConversation() { return [FIXTURE_MSG]; },
    async subscribeInbox() { return { stop: () => {} }; },
  };
}

describe('@weaveintel/tools-outlook (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createOutlookMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({ metadata: { outlookAccessToken: 'test-token' } });
    callTool = async (name, args) => mcpClient.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 7 Outlook tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createOutlookMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const tools = await mcpClient.listTools();
    expect(tools.map((t) => t.name)).toContain('outlook.send');
    expect(tools.length).toBe(7);
  });

  it('outlook.list returns messages', async () => {
    const result = await callTool('outlook.list', { folder: 'inbox' });
    const msgs = JSON.parse(result.content[0]!.text);
    expect(msgs[0].subject).toBe('Hello Outlook');
  });

  it('outlook.send returns messageId', async () => {
    const result = await callTool('outlook.send', { to: ['bob@example.com'], subject: 'Hi', body: 'Test' });
    expect(JSON.parse(result.content[0]!.text).messageId).toBe('sent-1');
  });

  it('outlook.search returns results', async () => {
    const result = await callTool('outlook.search', { query: 'Hello' });
    const msgs = JSON.parse(result.content[0]!.text);
    expect(msgs[0].id).toBe('msg-1');
  });

  it('rejects missing token', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createOutlookMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    await expect(mc.callTool(weaveContext({}), { name: 'outlook.list', arguments: {} })).rejects.toThrow();
  });
});
