/**
 * @weaveintel/geneweave — Built-in tools & registry
 *
 * Ships a set of useful built-in tools that agents can use, plus
 * a helper to create a ToolRegistry from selected tool names.
 */

import type { Tool, ToolRegistry } from '@weaveintel/core';
import { weaveTool, weaveToolRegistry } from '@weaveintel/core';
import { createSearchRouter, type SearchProviderConfig } from '@weaveintel/tools-search';
import { createInMemoryTemporalStore, createTimeTools, type TemporalStore } from '@weaveintel/tools-time';

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function buildSearchProviderConfigs(): Record<string, SearchProviderConfig> {
  const tavilyApiKey = process.env['TAVILY_API_KEY'];
  const braveApiKey = process.env['BRAVE_SEARCH_API_KEY'];

  return {
    // Default free provider with no API key requirement.
    duckduckgo: {
      name: 'duckduckgo',
      enabled: envFlag('SEARCH_DUCKDUCKGO_ENABLED', true),
      priority: Number(process.env['SEARCH_DUCKDUCKGO_PRIORITY'] ?? 50),
      options: {
        safesearch: process.env['SEARCH_DUCKDUCKGO_SAFESEARCH'] ?? 'moderate',
        region: process.env['SEARCH_DUCKDUCKGO_REGION'] ?? 'wt-wt',
      },
    },
    tavily: {
      name: 'tavily',
      enabled: envFlag('SEARCH_TAVILY_ENABLED', Boolean(tavilyApiKey)),
      apiKey: tavilyApiKey,
      priority: Number(process.env['SEARCH_TAVILY_PRIORITY'] ?? 30),
      options: {
        depth: process.env['SEARCH_TAVILY_DEPTH'] ?? 'basic',
      },
    },
    brave: {
      name: 'brave',
      enabled: envFlag('SEARCH_BRAVE_ENABLED', Boolean(braveApiKey)),
      apiKey: braveApiKey,
      priority: Number(process.env['SEARCH_BRAVE_PRIORITY'] ?? 40),
    },
  };
}

// ─── Built-in tools ─────────────────────────────────────────

// Each tool below uses weaveTool() from @weaveintel/core to create
// a schema-validated, tagable tool. The ChatEngine’s agent mode picks
// tools from the ToolRegistry to inject into the agent’s ReAct loop.
// In direct mode they are listed in the UI for user reference.─

const calculatorTool = weaveTool({
  name: 'calculator',
  description: 'Evaluate a mathematical expression. Supports +, -, *, /, **, %, parentheses.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'The math expression to evaluate' },
    },
    required: ['expression'],
  },
  execute: async (args: { expression: string }) => {
    try {
      const sanitized = args.expression.replace(/[^0-9+\-*/.()%\s^]/g, '');
      if (!sanitized.trim() || sanitized.length > 200) return { content: 'Invalid expression', isError: true };
      const result = new Function(`"use strict"; return (${sanitized.replace(/\^/g, '**')})`)();
      return String(result);
    } catch (e) {
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  },
  tags: ['math', 'utility'],
});

const defaultTemporalStore = createInMemoryTemporalStore();

function createTimeToolMap(defaultTimezone?: string, temporalStore: TemporalStore = defaultTemporalStore): Record<string, Tool> {
  const timeTools = createTimeTools({ defaultTimezone, store: temporalStore });
  return Object.fromEntries(timeTools.map((tool) => [tool.schema.name, tool]));
}

const webSearchTool = weaveTool({
  name: 'web_search',
  description: 'Search the web using configured providers (DuckDuckGo, Tavily, Brave).',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      limit: { type: 'number', description: 'Maximum number of results (default: 5, max: 10)' },
      provider: { type: 'string', description: 'Optional provider override (duckduckgo|tavily|brave)' },
      language: { type: 'string', description: 'Optional language hint (e.g. en)' },
      safeSearch: { type: 'boolean', description: 'Optional safesearch preference' },
    },
    required: ['query'],
  },
  execute: async (args: { query: string; limit?: number; provider?: string; language?: string; safeSearch?: boolean }) => {
    const configs = buildSearchProviderConfigs();
    const hasEnabledProvider = Object.values(configs).some((cfg) => cfg.enabled);
    if (!hasEnabledProvider) {
      return JSON.stringify({
        query: args.query,
        provider: 'none',
        error: 'No search providers are enabled. Enable at least one provider via environment variables.',
        results: [],
      }, null, 2);
    }

    const router = createSearchRouter({ configs, fallback: true });
    const limit = Math.max(1, Math.min(10, Number(args.limit ?? 5)));

    const routed = args.provider
      ? await router.searchWith(args.provider, {
          query: args.query,
          limit,
          language: args.language,
          safeSearch: args.safeSearch,
        })
      : await router.search({
          query: args.query,
          limit,
          language: args.language,
          safeSearch: args.safeSearch,
        });

    return JSON.stringify({
      query: args.query,
      provider: routed.provider,
      latencyMs: routed.latencyMs,
      error: routed.error,
      resultCount: routed.results.length,
      results: routed.results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        source: result.source,
        publishedAt: result.publishedAt,
        score: result.score,
      })),
    }, null, 2);
  },
  tags: ['search', 'external'],
});

const jsonFormatterTool = weaveTool({
  name: 'json_format',
  description: 'Parse and pretty-print a JSON string.',
  parameters: {
    type: 'object',
    properties: {
      json: { type: 'string', description: 'The JSON string to format' },
      indent: { type: 'number', description: 'Indentation spaces (default: 2)' },
    },
    required: ['json'],
  },
  execute: async (args: { json: string; indent?: number }) => {
    try {
      const parsed = JSON.parse(args.json);
      return JSON.stringify(parsed, null, args.indent ?? 2);
    } catch (e) {
      return { content: `Invalid JSON: ${(e as Error).message}`, isError: true };
    }
  },
  tags: ['utility', 'formatting'],
});

const textAnalysisTool = weaveTool({
  name: 'text_analysis',
  description: 'Analyze text: word count, character count, sentence count, reading time.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to analyze' },
    },
    required: ['text'],
  },
  execute: async (args: { text: string }) => {
    const words = args.text.split(/\s+/).filter(Boolean).length;
    const chars = args.text.length;
    const sentences = args.text.split(/[.!?]+/).filter(Boolean).length;
    const readingTime = Math.ceil(words / 200);
    return JSON.stringify({ words, characters: chars, sentences, readingTimeMinutes: readingTime }, null, 2);
  },
  tags: ['utility', 'text'],
});

// ─── Tool catalog ───────────────────────────────────────────

// BUILTIN_TOOLS is an index of all shipped tools keyed by name.
// createToolRegistry() uses weaveToolRegistry() from @weaveintel/core,
// pre-loads selected built-in tools, and optionally adds custom tools.
// This is how the ChatEngine builds the per-chat tool set.─

export const BUILTIN_TOOLS: Record<string, Tool> = {
  calculator: calculatorTool,
  ...createTimeToolMap(),
  web_search: webSearchTool,
  json_format: jsonFormatterTool,
  text_analysis: textAnalysisTool,
};

export interface ToolRegistryOptions {
  defaultTimezone?: string;
  temporalStore?: TemporalStore;
}

/**
 * Create a ToolRegistry pre-loaded with the selected built-in tools
 * plus any custom tools provided.
 */
export function createToolRegistry(toolNames: string[], customTools?: Tool[], opts?: ToolRegistryOptions): ToolRegistry {
  const registry = weaveToolRegistry();
  const scopedTools: Record<string, Tool> = {
    ...BUILTIN_TOOLS,
    ...createTimeToolMap(opts?.defaultTimezone, opts?.temporalStore ?? defaultTemporalStore),
  };
  for (const name of toolNames) {
    const tool = scopedTools[name];
    if (tool) registry.register(tool);
  }
  if (customTools) {
    for (const tool of customTools) {
      registry.register(tool);
    }
  }
  return registry;
}

/** Info about all available built-in tools */
export function getAvailableTools(): Array<{ name: string; description: string; tags: string[] }> {
  return Object.values(BUILTIN_TOOLS).map((t) => ({
    name: t.schema.name,
    description: t.schema.description,
    tags: [...(t.schema.tags ?? [])],
  }));
}
