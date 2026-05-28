import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createAltDataMCPServer, fixtureAltDataAdapter } from './index.js';

describe('@weaveintel/tools-altdata (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

  beforeEach(async () => {
    const server = createAltDataMCPServer({ adapter: fixtureAltDataAdapter() });
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

  it('altdata.trends.get returns weekly data points', async () => {
    const res = await callTool('altdata.trends.get', { query: 'Apple', weeks: 4 });
    const data = JSON.parse(res.content[0]!.text) as Array<{ week: string; index: number }>;
    expect(data.length).toBe(4);
    expect(data[0]!.index).toBeGreaterThan(0);
    expect(data[0]!.index).toBeLessThanOrEqual(100);
  });

  it('altdata.esg.get returns MSFT scores', async () => {
    const res = await callTool('altdata.esg.get', { symbol: 'MSFT' });
    const data = JSON.parse(res.content[0]!.text) as { environmental: number; composite: number };
    expect(data.environmental).toBeGreaterThan(50);
    expect(data.composite).toBeGreaterThan(50);
  });

  it('altdata.esg.get returns null for unknown symbol', async () => {
    const res = await callTool('altdata.esg.get', { symbol: 'ZZZZZ' });
    const data = JSON.parse(res.content[0]!.text);
    expect(data).toBeNull();
  });

  it('altdata.supplychain.get returns AAPL suppliers', async () => {
    const res = await callTool('altdata.supplychain.get', { symbol: 'AAPL' });
    const data = JSON.parse(res.content[0]!.text) as { topSuppliers: string[]; geographicRevenue: Record<string, number> };
    expect(data.topSuppliers).toContain('TSMC');
    expect(data.geographicRevenue['Americas']).toBeGreaterThan(0);
  });
});
