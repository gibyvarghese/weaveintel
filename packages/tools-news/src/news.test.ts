import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createNewsMCPServer, fixtureNewsAdapter } from './index.js';

describe('@weaveintel/tools-news (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const server = createNewsMCPServer({ adapter: fixtureNewsAdapter() });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({});
    callTool = async (name, args) => {
      const result = await mcpClient.callTool(ctx, { name, arguments: args });
      return result as { content: Array<{ type: string; text: string }> };
    };
  });

  it('news.company.get returns AAPL articles', async () => {
    const res = await callTool('news.company.get', { symbol: 'AAPL', from: '2026-01-01', to: '2026-06-01' });
    const data = JSON.parse(res.content[0]!.text) as Array<{ symbols: string[] }>;
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]!.symbols).toContain('AAPL');
  });

  it('news.market.get returns articles', async () => {
    const res = await callTool('news.market.get', { topics: ['macro'], limit: 5 });
    const data = JSON.parse(res.content[0]!.text) as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('news.transcripts.get returns transcript text', async () => {
    const res = await callTool('news.transcripts.get', { symbol: 'MSFT', quarters: 2 });
    const data = JSON.parse(res.content[0]!.text) as Array<{ text: string; fiscalPeriod: string }>;
    expect(data.length).toBe(2);
    expect(data[0]!.text.length).toBeGreaterThan(50);
  });
});
