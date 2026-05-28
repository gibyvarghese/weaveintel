/**
 * @weaveintel/tools-news — MCP server
 * Tools: news.company.get, news.market.get, news.transcripts.get (all 'read-only')
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '@weaveintel/tools';
import type { NewsAdapter } from './adapter.js';
import { fixtureNewsAdapter } from './adapters/fixture.js';

export interface NewsMCPServerOptions {
  adapter?: NewsAdapter;
}

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createNewsMCPServer(opts: NewsMCPServerOptions = {}) {
  const adapter = opts.adapter ?? fixtureNewsAdapter();

  const server = weaveMCPServer(
    { name: 'news', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('news.company.get', 'Get recent news articles for a specific ticker symbol', 'read-only');
  describeT('news.market.get', 'Get market-wide news filtered by topic or region', 'read-only');
  describeT('news.transcripts.get', 'Get earnings call transcripts for a symbol', 'read-only');

  server.addTool({
    name: 'news.company.get',
    description: 'Get news articles for a specific ticker. Returns title, source, sentiment score, and relevance.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        from:   { type: 'string', description: 'ISO date start' },
        to:     { type: 'string', description: 'ISO date end' },
        limit:  { type: 'number', default: 30 },
      },
      required: ['symbol', 'from', 'to'],
    },
  }, async (ctx, args) => {
    return asText(await adapter.getCompanyNews(ctx, {
      symbol: String(args['symbol']), from: String(args['from']), to: String(args['to']),
      limit: args['limit'] !== undefined ? Number(args['limit']) : 30,
    }));
  });

  server.addTool({
    name: 'news.market.get',
    description: 'Get broad market news filtered by topic (e.g. macro, earnings, IPO) or region.',
    inputSchema: {
      type: 'object',
      properties: {
        topics: { type: 'array', items: { type: 'string' } },
        region: { type: 'string', enum: ['US', 'IN', 'EU', 'UK', 'GLOBAL'] },
        limit:  { type: 'number', default: 20 },
      },
    },
  }, async (ctx, args) => {
    return asText(await adapter.getMarketNews(ctx, {
      topics: Array.isArray(args['topics']) ? (args['topics'] as string[]) : undefined,
      region: (args['region'] as 'US' | 'IN' | 'EU' | 'UK' | 'GLOBAL') ?? 'US',
      limit: args['limit'] !== undefined ? Number(args['limit']) : 20,
    }));
  });

  server.addTool({
    name: 'news.transcripts.get',
    description: 'Get earnings call transcripts for a ticker. Returns full text and fiscal period.',
    inputSchema: {
      type: 'object',
      properties: { symbol: { type: 'string' }, quarters: { type: 'number', default: 4 } },
      required: ['symbol'],
    },
  }, async (ctx, args) => {
    return asText(await adapter.getEarningsTranscripts(ctx, String(args['symbol']), Number(args['quarters'] ?? 4)));
  });

  return server;
}
