/**
 * @weaveintel/tools-marketdata — MCP server
 *
 * Exposes all MarketDataAdapter methods as read-only MCP tools.
 * Credentials arrive at runtime via _meta.executionContext.metadata.
 * No secrets are stored in this package.
 *
 * Tools (all 'read-only'):
 *   marketdata.symbols.search
 *   marketdata.profile.get
 *   marketdata.quote.get
 *   marketdata.ohlcv.get
 *   marketdata.fundamentals.get
 *   marketdata.financials.annual.get
 *   marketdata.financials.quarterly.get
 *   marketdata.earnings.history.get
 *   marketdata.analyst.consensus.get
 *   marketdata.dividends.get
 *   marketdata.splits.get
 *   marketdata.filings.get
 *   marketdata.insiders.get
 *   marketdata.institutions.get
 *   marketdata.short.get
 *   marketdata.options.summary.get
 *   marketdata.macro.get
 *   marketdata.fx.get
 */

import { weaveContext } from '@weaveintel/core';
import type { ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';
import type { MarketDataAdapter } from './adapter.js';
import { fixtureMarketDataAdapter } from './adapters/fixture.js';
import type { MacroSnapshot } from './types.js';

export interface MarketDataMCPServerOptions {
  adapter?: MarketDataAdapter;
}

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createMarketDataMCPServer(opts: MarketDataMCPServerOptions = {}) {
  const adapter = opts.adapter ?? fixtureMarketDataAdapter();

  const server = weaveMCPServer(
    { name: 'marketdata', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  // Register risk descriptors
  const TOOLS: ReadonlyArray<[string, string]> = [
    ['marketdata.symbols.search',            'Search for ticker symbols by name or keyword'],
    ['marketdata.profile.get',               'Get company profile: exchange, sector, shares outstanding, fiscal year end'],
    ['marketdata.quote.get',                 'Get real-time or delayed quote: price, volume, change'],
    ['marketdata.ohlcv.get',                 'Get OHLCV bars (daily/weekly/monthly) with split-and-dividend-adjusted close'],
    ['marketdata.fundamentals.get',          'Get latest fundamentals snapshot: valuation, margins, quality scores, safety metrics'],
    ['marketdata.financials.annual.get',     'Get annual income statement, cash flow, and balance sheet (up to 10 years)'],
    ['marketdata.financials.quarterly.get',  'Get quarterly financials (up to 12 quarters)'],
    ['marketdata.earnings.history.get',      'Get EPS/revenue surprise history with guidance tone'],
    ['marketdata.analyst.consensus.get',     'Get analyst buy/hold/sell counts, target prices, EPS revisions'],
    ['marketdata.dividends.get',             'Get dividend history with ex-date and payment amount'],
    ['marketdata.splits.get',                'Get stock split history'],
    ['marketdata.filings.get',               'Get SEC/regulatory filing references (10-K, 10-Q, 8-K, Form 4, 13F)'],
    ['marketdata.insiders.get',              'Get insider buy/sell transactions (Form 4) for the last N days'],
    ['marketdata.institutions.get',          'Get institutional 13F holdings with QoQ share change'],
    ['marketdata.short.get',                 'Get short interest: short %, days-to-cover, cost-to-borrow'],
    ['marketdata.options.summary.get',       'Get options market summary: put/call ratio, IV30, IV rank, skew'],
    ['marketdata.macro.get',                 'Get macro snapshot for a region: policy rate, CPI, GDP, yield curve, VIX'],
    ['marketdata.fx.get',                    'Get FX rate between two ISO 4217 currency codes'],
  ];
  for (const [name, desc] of TOOLS) describeT(name, desc, 'read-only');

  server.addTool({
    name: 'marketdata.symbols.search',
    description: 'Search for ticker symbols by name or keyword. Returns up to 10 matches.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Company name or partial ticker' } }, required: ['query'] },
  }, async (ctx, args) => {
    return asText(await adapter.searchSymbols(ctx, String(args['query'] ?? '')));
  });

  server.addTool({
    name: 'marketdata.profile.get',
    description: 'Get company profile for a ticker symbol.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getProfile(ctx, String(args['symbol'])));
  });

  server.addTool({
    name: 'marketdata.quote.get',
    description: 'Get latest price quote for a ticker.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getQuote(ctx, String(args['symbol'])));
  });

  server.addTool({
    name: 'marketdata.ohlcv.get',
    description: 'Get historical OHLCV bars with adjusted close.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol:   { type: 'string' },
        interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        from:     { type: 'string', description: 'ISO date e.g. 2025-01-01' },
        to:       { type: 'string', description: 'ISO date e.g. 2026-01-01' },
      },
      required: ['symbol', 'interval', 'from', 'to'],
    },
  }, async (ctx, args) => {
    return asText(await adapter.getOHLCV(ctx, String(args['symbol']), {
      interval: (args['interval'] as 'daily' | 'weekly' | 'monthly') ?? 'daily',
      from: String(args['from']), to: String(args['to']),
    }));
  });

  server.addTool({
    name: 'marketdata.fundamentals.get',
    description: 'Get latest fundamentals snapshot including valuation, profitability, safety, and quality scores.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getFundamentals(ctx, String(args['symbol'])));
  });

  server.addTool({
    name: 'marketdata.financials.annual.get',
    description: 'Get annual income statement, cash flow, and balance sheet history.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, years: { type: 'number', description: 'Number of years (max 10)', default: 10 } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getAnnualFinancials(ctx, String(args['symbol']), Number(args['years'] ?? 10)));
  });

  server.addTool({
    name: 'marketdata.financials.quarterly.get',
    description: 'Get quarterly financial statements.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, quarters: { type: 'number', default: 8 } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getQuarterlyFinancials(ctx, String(args['symbol']), Number(args['quarters'] ?? 8)));
  });

  server.addTool({
    name: 'marketdata.earnings.history.get',
    description: 'Get EPS and revenue surprise history with guidance tone.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, quarters: { type: 'number', default: 8 } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getEarningsHistory(ctx, String(args['symbol']), Number(args['quarters'] ?? 8)));
  });

  server.addTool({
    name: 'marketdata.analyst.consensus.get',
    description: 'Get analyst ratings consensus, price targets, and EPS revision trends.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getAnalystConsensus(ctx, String(args['symbol'])));
  });

  server.addTool({
    name: 'marketdata.dividends.get',
    description: 'Get dividend payment history.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, years: { type: 'number', default: 5 } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getDividends(ctx, String(args['symbol']), Number(args['years'] ?? 5)));
  });

  server.addTool({
    name: 'marketdata.splits.get',
    description: 'Get stock split history.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, years: { type: 'number', default: 10 } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getSplits(ctx, String(args['symbol']), Number(args['years'] ?? 10)));
  });

  server.addTool({
    name: 'marketdata.filings.get',
    description: 'Get SEC/regulatory filing references (10-K, 10-Q, 8-K, Form 4, 13F).',
    inputSchema: {
      type: 'object',
      properties: {
        symbol:    { type: 'string' },
        formTypes: { type: 'array', items: { type: 'string' }, description: 'Form type filter e.g. ["10-K","4"]' },
      },
      required: ['symbol'],
    },
  }, async (ctx, args) => {
    const formTypes = Array.isArray(args['formTypes']) ? (args['formTypes'] as string[]) : undefined;
    return asText(await adapter.getSECFilings(ctx, String(args['symbol']), formTypes));
  });

  server.addTool({
    name: 'marketdata.insiders.get',
    description: 'Get insider buy/sell transactions (Form 4) for the last N days.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, days: { type: 'number', default: 180 } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getInsiderTransactions(ctx, String(args['symbol']), Number(args['days'] ?? 180)));
  });

  server.addTool({
    name: 'marketdata.institutions.get',
    description: 'Get institutional 13F holdings with QoQ share change.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getInstitutionalHoldings(ctx, String(args['symbol'])));
  });

  server.addTool({
    name: 'marketdata.short.get',
    description: 'Get short interest: short %, days-to-cover, cost-to-borrow.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getShortInterest(ctx, String(args['symbol'])));
  });

  server.addTool({
    name: 'marketdata.options.summary.get',
    description: 'Get options market summary: put/call ratio, implied volatility 30d, IV rank, 25-delta skew.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getOptionsSummary(ctx, String(args['symbol'])));
  });

  server.addTool({
    name: 'marketdata.macro.get',
    description: 'Get macro snapshot for a region (US, IN, EU, UK, GLOBAL).',
    inputSchema: {
      type: 'object',
      properties: { region: { type: 'string', enum: ['US', 'IN', 'EU', 'UK', 'GLOBAL'] } },
      required: ['region'],
    },
  }, async (ctx, args) => {
    return asText(await adapter.getMacroSnapshot(ctx, (args['region'] as MacroSnapshot['region']) ?? 'US'));
  });

  server.addTool({
    name: 'marketdata.fx.get',
    description: 'Get current FX rate between two ISO 4217 currency codes.',
    inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  }, async (ctx, args) => {
    return asText(await adapter.getFxRate(ctx, String(args['from']), String(args['to'])));
  });

  return server;
}
