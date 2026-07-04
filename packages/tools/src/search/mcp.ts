/**
 * MCP tool definitions for search providers
 */
import type { Tool, ToolInput, ToolOutput, ExecutionContext } from '@weaveintel/core';
import type { SearchRouter } from './router.js';
import type { SearchOptions } from './types.js';

const SEARCH_PARAMS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'The search query' },
    limit: { type: 'number', description: 'Max results to return (default 10)' },
    language: { type: 'string', description: 'Language code (e.g. en)' },
    region: { type: 'string', description: 'Region code (e.g. us)' },
    safeSearch: { type: 'boolean', description: 'Enable safe search' },
  },
  required: ['query'],
} as const;

function parseSearchInput(args: Record<string, unknown>): SearchOptions {
  return {
    query: String(args['query'] ?? ''),
    limit: args['limit'] != null ? Number(args['limit']) : undefined,
    language: args['language'] != null ? String(args['language']) : undefined,
    region: args['region'] != null ? String(args['region']) : undefined,
    safeSearch: args['safeSearch'] != null ? Boolean(args['safeSearch']) : undefined,
  };
}

/**
 * Create a set of Tool objects for the search router.
 * Returns a meta search.query tool plus one search.<provider> per registered provider.
 */
export function createSearchTools(router: SearchRouter): Tool[] {
  const tools: Tool[] = [];

  // Meta tool — uses the best available provider
  tools.push({
    schema: {
      name: 'search.query',
      description: 'Web search using the best available search provider',
      parameters: SEARCH_PARAMS,
    },
    async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
      const opts = parseSearchInput(input.arguments);
      const result = await router.search(opts);
      return { content: JSON.stringify(result) };
    },
  });

  // Fan-out tool
  tools.push({
    schema: {
      name: 'search.all',
      description: 'Search all enabled providers and merge results',
      parameters: SEARCH_PARAMS,
    },
    async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
      const opts = parseSearchInput(input.arguments);
      const results = await router.searchAll(opts);
      return { content: JSON.stringify(results) };
    },
  });

  // Per-provider tools
  for (const providerName of router.listProviders()) {
    tools.push({
      schema: {
        name: `search.${providerName}`,
        description: `Search using ${providerName} provider`,
        parameters: SEARCH_PARAMS,
      },
      async invoke(_ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
        const opts = parseSearchInput(input.arguments);
        const result = await router.searchWith(providerName, opts);
        return { content: JSON.stringify(result) };
      },
    });
  }

  return tools;
}
