import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createSlackMCPServer, type SlackAdapter, type SlackMessage } from './slack.js';

const FIXTURE_MSG: SlackMessage = { ts: '123.456', channel: 'C123', user: 'U123', text: 'hello from slack fixture' };

function fixtureAdapter(): SlackAdapter {
  return {
    async postMessage(_creds, channel, text) { return { ...FIXTURE_MSG, channel, text }; },
    async readChannel() { return { messages: [FIXTURE_MSG] }; },
    async search() { return [FIXTURE_MSG]; },
    async subscribeEvents() { return { stop: () => {} }; },
  };
}

describe('@weaveintel/tools-slack (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createSlackMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    const ctx = weaveContext({ metadata: { slackBotToken: 'xoxb-test' } });
    callTool = async (name, args) => mc.callTool(ctx, { name, arguments: args }) as unknown as Promise<{ content: Array<{ type: string; text: string }> }>;
  });

  it('exposes 4 Slack tools', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createSlackMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    expect((await mc.listTools()).length).toBe(4);
  });

  it('slack.post sends message', async () => {
    const result = await callTool('slack.post', { channel: 'C123', text: 'ping' });
    expect(JSON.parse(result.content[0]!.text).text).toBe('ping');
  });

  it('slack.search returns messages', async () => {
    const result = await callTool('slack.search', { query: 'fixture' });
    expect(JSON.parse(result.content[0]!.text)[0].text).toContain('fixture');
  });

  it('rejects missing token', async () => {
    const { client, server: transport } = weaveFakeTransport();
    const server = createSlackMCPServer({ adapter: fixtureAdapter() });
    await server.start(transport);
    const mc = weaveMCPClient();
    await mc.connect(client);
    await expect(mc.callTool(weaveContext({}), { name: 'slack.post', arguments: { channel: 'C123', text: 'x' } })).rejects.toThrow();
  });
});
