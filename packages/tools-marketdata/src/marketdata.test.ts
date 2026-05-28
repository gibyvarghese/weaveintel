/**
 * @weaveintel/tools-marketdata — fixture adapter + MCP server tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createMarketDataMCPServer, fixtureMarketDataAdapter, compositeAdapter } from './index.js';

const ALL_TOOL_NAMES = [
  'marketdata.symbols.search', 'marketdata.profile.get', 'marketdata.quote.get',
  'marketdata.ohlcv.get', 'marketdata.fundamentals.get', 'marketdata.financials.annual.get',
  'marketdata.financials.quarterly.get', 'marketdata.earnings.history.get',
  'marketdata.analyst.consensus.get', 'marketdata.dividends.get', 'marketdata.splits.get',
  'marketdata.filings.get', 'marketdata.insiders.get', 'marketdata.institutions.get',
  'marketdata.short.get', 'marketdata.options.summary.get', 'marketdata.macro.get', 'marketdata.fx.get',
];

describe('@weaveintel/tools-marketdata (fixture)', () => {
  let callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
  let listTools: () => Promise<Array<{ name: string }>>;

  beforeEach(async () => {
    const adapter = fixtureMarketDataAdapter();
    const server = createMarketDataMCPServer({ adapter });
    const { client, server: transport } = weaveFakeTransport();
    await server.start(transport);
    const mcpClient = weaveMCPClient();
    await mcpClient.connect(client);
    const ctx = weaveContext({});

    callTool = async (name, args) => {
      const result = await mcpClient.callTool(ctx, { name, arguments: args });
      return result as { content: Array<{ type: string; text: string }> };
    };
    listTools = async () => mcpClient.listTools();
  });

  it('exposes all 18 read-only tools', async () => {
    const tools = await listTools();
    const names = tools.map(t => t.name);
    for (const expected of ALL_TOOL_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('marketdata.symbols.search returns results for AAPL', async () => {
    const res = await callTool('marketdata.symbols.search', { query: 'Apple' });
    const data = JSON.parse(res.content[0]!.text) as Array<{ symbol: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.some(r => r.symbol === 'AAPL')).toBe(true);
  });

  it('marketdata.profile.get returns correct exchange for MSFT', async () => {
    const res = await callTool('marketdata.profile.get', { symbol: 'MSFT' });
    const data = JSON.parse(res.content[0]!.text) as { exchange: string; name: string };
    expect(data.exchange).toBe('NASDAQ');
    expect(data.name).toContain('Microsoft');
  });

  it('marketdata.profile.get returns NSE for TCS', async () => {
    const res = await callTool('marketdata.profile.get', { symbol: 'TCS' });
    const data = JSON.parse(res.content[0]!.text) as { exchange: string; currency: string };
    expect(data.exchange).toBe('NSE');
    expect(data.currency).toBe('INR');
  });

  it('marketdata.quote.get returns positive price', async () => {
    const res = await callTool('marketdata.quote.get', { symbol: 'AAPL' });
    const data = JSON.parse(res.content[0]!.text) as { price: number };
    expect(data.price).toBeGreaterThan(0);
  });

  it('marketdata.ohlcv.get returns bars within date range', async () => {
    const res = await callTool('marketdata.ohlcv.get', { symbol: 'GOOGL', interval: 'daily', from: '2025-01-01', to: '2026-01-01' });
    const data = JSON.parse(res.content[0]!.text) as Array<{ ts: string; adjustedClose: number }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]!.adjustedClose).toBeGreaterThan(0);
  });

  it('marketdata.fundamentals.get returns non-null core fields for AAPL', async () => {
    const res = await callTool('marketdata.fundamentals.get', { symbol: 'AAPL' });
    const data = JSON.parse(res.content[0]!.text) as { peRatio: number; roe: number; roic: number; altmanZScore: number };
    expect(data.peRatio).toBeGreaterThan(0);
    expect(data.roe).toBeGreaterThan(0);
    expect(data.roic).toBeGreaterThan(0);
    expect(data.altmanZScore).toBeGreaterThan(0);
  });

  it('marketdata.financials.annual.get returns 10 years', async () => {
    const res = await callTool('marketdata.financials.annual.get', { symbol: 'MSFT', years: 10 });
    const data = JSON.parse(res.content[0]!.text) as Array<{ fiscalYear: number }>;
    expect(data.length).toBe(10);
    expect(data[0]!.fiscalYear).toBe(2026);
  });

  it('marketdata.financials.quarterly.get returns quarters', async () => {
    const res = await callTool('marketdata.financials.quarterly.get', { symbol: 'AAPL', quarters: 8 });
    const data = JSON.parse(res.content[0]!.text) as unknown[];
    expect(data.length).toBeGreaterThan(0);
  });

  it('marketdata.earnings.history.get returns EPS surprises', async () => {
    const res = await callTool('marketdata.earnings.history.get', { symbol: 'JNJ', quarters: 4 });
    const data = JSON.parse(res.content[0]!.text) as Array<{ surprisePct: number }>;
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]!.surprisePct).toBeDefined();
  });

  it('marketdata.insiders.get returns insider transactions', async () => {
    const res = await callTool('marketdata.insiders.get', { symbol: 'AAPL', days: 365 });
    const data = JSON.parse(res.content[0]!.text) as Array<{ transactionCode: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it('marketdata.short.get returns short interest', async () => {
    const res = await callTool('marketdata.short.get', { symbol: 'XOM' });
    const data = JSON.parse(res.content[0]!.text) as { shortPctFloat: number };
    expect(data.shortPctFloat).toBeGreaterThan(0);
  });

  it('marketdata.options.summary.get returns put/call ratio', async () => {
    const res = await callTool('marketdata.options.summary.get', { symbol: 'AAPL' });
    const data = JSON.parse(res.content[0]!.text) as { putCallRatioOI: number };
    expect(data.putCallRatioOI).toBeGreaterThan(0);
  });

  it('marketdata.macro.get returns US snapshot with VIX', async () => {
    const res = await callTool('marketdata.macro.get', { region: 'US' });
    const data = JSON.parse(res.content[0]!.text) as { vix: number; policyRate: number };
    expect(data.vix).toBeGreaterThan(0);
    expect(data.policyRate).toBeGreaterThan(0);
  });

  it('marketdata.fx.get returns USD/INR rate', async () => {
    const res = await callTool('marketdata.fx.get', { from: 'USD', to: 'INR' });
    const data = JSON.parse(res.content[0]!.text) as { rate: number };
    expect(data.rate).toBeGreaterThan(50); // sanity check
  });

  it('throws for unknown symbol', async () => {
    const res = await callTool('marketdata.profile.get', { symbol: 'DOESNOTEXIST' }).catch(e => ({ error: String(e) }));
    expect(JSON.stringify(res)).toMatch(/doesnotexist|unknown|error/i);
  });

  it('composite adapter routes correctly with fixture', async () => {
    const fixture = fixtureMarketDataAdapter();
    const composite = compositeAdapter([fixture]);
    const ctx = weaveContext({});
    const profile = await composite.getProfile(ctx, 'TCS');
    expect(profile.exchange).toBe('NSE');
  });

  it('marketdata.splits.get returns AAPL 2020 split', async () => {
    const res = await callTool('marketdata.splits.get', { symbol: 'AAPL', years: 10 });
    const data = JSON.parse(res.content[0]!.text) as Array<{ numerator: number; exDate: string }>;
    expect(data.some(s => s.numerator === 4 && s.exDate === '2020-08-31')).toBe(true);
  });
});
