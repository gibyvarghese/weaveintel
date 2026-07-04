/**
 * @weaveintel/tools-altdata — MCP server
 * Tools: altdata.trends.get, altdata.esg.get, altdata.supplychain.get (all 'read-only')
 * If none configured, equity-scoring downgrades alt_signals weight to 0.
 */

import { weaveContext, type ExecutionContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveToolDescriptor as describeT } from '../index.js';
import type { AltDataAdapter } from './adapter.js';
import { fixtureAltDataAdapter } from './adapters/fixture.js';

export interface AltDataMCPServerOptions {
  adapter?: AltDataAdapter;
}

function asText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

export function createAltDataMCPServer(opts: AltDataMCPServerOptions = {}) {
  const adapter = opts.adapter ?? fixtureAltDataAdapter();

  const server = weaveMCPServer(
    { name: 'altdata', version: '0.1.0' },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  describeT('altdata.trends.get', 'Get Google Trends relative search interest (0-100) by week for a brand or symbol query', 'read-only');
  describeT('altdata.esg.get', 'Get ESG scores (environmental, social, governance, composite) for a symbol', 'read-only');
  describeT('altdata.supplychain.get', 'Get supply chain exposure: top suppliers, customers, and geographic revenue breakdown', 'read-only');

  server.addTool({
    name: 'altdata.trends.get',
    description: 'Get relative Google Trends search interest (0-100) by week for a brand or company name query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Brand or company name to search' },
        weeks: { type: 'number', description: 'Number of weeks of history', default: 52 },
      },
      required: ['query'],
    },
  }, async (ctx, args) => {
    return asText(await adapter.getGoogleTrends(ctx, String(args['query']), Number(args['weeks'] ?? 52)));
  });

  server.addTool({
    name: 'altdata.esg.get',
    description: 'Get ESG scores for a ticker. Returns environmental, social, governance, and composite scores (0-100).',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getEsgScores(ctx, String(args['symbol'])));
  });

  server.addTool({
    name: 'altdata.supplychain.get',
    description: 'Get supply chain exposure: top suppliers, top customers, and geographic revenue split.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  }, async (ctx, args) => {
    return asText(await adapter.getSupplyChainExposure(ctx, String(args['symbol'])));
  });

  return server;
}
