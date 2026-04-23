/**
 * Example 24 — Web Search Provider Ecosystem
 *
 * Demonstrates the full @weaveintel/tools-search package:
 *  • DuckDuckGoProvider with automatic HTML SERP fallback
 *  • Multi-provider SearchRouter with ordered fallback chain
 *  • Fan-out (parallel search across all providers)
 *  • MCP tool exposure via createSearchTools()
 *  • Wiring the router into an agent's tool registry
 *
 * WeaveIntel packages used:
 *   @weaveintel/tools-search — Web search provider ecosystem:
 *     • DuckDuckGoProvider  — No API key required. Hits DuckDuckGo Instant Answer API;
 *                             automatically falls back to HTML SERP parsing when the
 *                             Instant Answer API returns zero results (common for event/
 *                             ticket/tour queries). Parses result__a anchors and decodes
 *                             DuckDuckGo redirect URLs (uddg param) to extract real URLs.
 *     • BraveProvider      — Brave Search API (requires BRAVE_API_KEY). High quality,
 *                             privacy-first results. Good for current news/events.
 *     • TavilyProvider     — Tavily Search API (requires TAVILY_API_KEY). Optimised for
 *                             LLM-augmented research; returns structured summaries.
 *     • ExaProvider        — Exa Search API (requires EXA_API_KEY). Neural semantic
 *                             search over the open web.
 *     • SerperProvider     — Google Search via Serper API (requires SERPER_API_KEY).
 *                             Most comprehensive coverage; mirrors what Google shows.
 *     • JinaProvider       — Jina Reader API. Extracts clean Markdown from any URL —
 *                             ideal for RAG ingestion pipelines.
 *     • SearXNGProvider    — Self-hosted meta-search engine. No API key; requires a
 *                             running SearXNG instance (set SEARXNG_BASE_URL).
 *     • GooglePSEProvider  — Google Programmable Search Engine (requires GOOGLE_PSE_KEY
 *                             and GOOGLE_PSE_CX). Scoped to specific sites/domains.
 *     • BingProvider       — Bing Web Search v7 API (requires BING_API_KEY).
 *     • createSearchRouter — Picks the highest-priority enabled provider and falls back
 *                            to the next one in the chain on error.
 *     • createSearchTools  — Wraps router search as MCP tool definitions (web_search,
 *                            image_search, news_search) that any agent can call.
 *   @weaveintel/core       — ExecutionContext, weaveToolRegistry(), weaveTool()
 *   @weaveintel/agents     — weaveAgent()
 *   @weaveintel/testing    — weaveFakeModel()
 *
 * No API keys needed for DuckDuckGo. Set BRAVE_API_KEY / TAVILY_API_KEY etc. in your
 * .env to enable higher-quality providers.
 *
 * Run: npx tsx examples/24-web-search-providers.ts
 */

import {
  DuckDuckGoProvider,
  BraveProvider,
  TavilyProvider,
  ExaProvider,
  createSearchRouter,
  createSearchTools,
} from '@weaveintel/tools-search';
import {
  weaveContext,
  weaveToolRegistry,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

async function main() {
  // --- 1. Direct provider usage ---
  // Each provider implements the SearchProvider interface: .search(options, config)
  // The DuckDuckGoProvider requires no config (no API key).
  console.log('=== 1. DuckDuckGoProvider with HTML fallback ===');

  const ddg = new DuckDuckGoProvider();

  // A query that the DuckDuckGo Instant Answer API will return empty for,
  // but the HTML SERP page has real results (triggers the automatic fallback).
  const ticketQuery = 'conan gray wishbone world tour auckland 2026';
  const ddgResults = await ddg.search(
    { query: ticketQuery, limit: 5 },
    { name: 'duckduckgo', enabled: true },
  );

  console.log(`Query: "${ticketQuery}"`);
  console.log(`Results (${ddgResults.length}):`);
  for (const r of ddgResults) {
    console.log(`  [${r.title.slice(0, 60)}] → ${r.url}`);
    if (r.snippet) console.log(`    ${r.snippet.slice(0, 120)}`);
  }

  // --- 2. SearchRouter — ordered fallback chain ---
  // createSearchRouter() accepts a `configs` map keyed by provider name.
  // Each config entry specifies: name, enabled, priority, and optional apiKey.
  //   • priority: lower number = tried first
  //   • fallback: true  = if the primary provider errors, the next one is tried
  // This pattern mirrors the geneWeave settings table where admins can enable/disable
  // providers and set their priority without redeploying.
  console.log('\n=== 2. SearchRouter — ordered fallback chain ===');

  const router = createSearchRouter({
    fallback: true,
    configs: {
      // DuckDuckGo is free, use it as the primary fallback with highest priority
      duckduckgo: { name: 'duckduckgo', enabled: true, priority: 10 },
      // Brave/Tavily are higher quality but require API keys.
      // When present they are tried first (lower priority number = earlier).
      ...(process.env['BRAVE_API_KEY']
        ? { brave: { name: 'brave', enabled: true, apiKey: process.env['BRAVE_API_KEY'], priority: 5 } }
        : {}),
      ...(process.env['TAVILY_API_KEY']
        ? { tavily: { name: 'tavily', enabled: true, apiKey: process.env['TAVILY_API_KEY'], priority: 1 } }
        : {}),
    },
  });

  const routerResult = await router.search({ query: 'weaveIntel AI framework', limit: 3 });
  console.log(`Provider used: ${routerResult.provider} (${routerResult.latencyMs}ms)`);
  console.log(`Results (${routerResult.results.length}):`);
  for (const r of routerResult.results) {
    console.log(`  ${r.title.slice(0, 70)}`);
  }
  if (routerResult.error) {
    console.log(`  (provider error, fell back: ${routerResult.error})`);
  }

  // --- 3. Fan-out — parallel search across multiple providers ---
  // When you want results from multiple providers simultaneously (e.g. to merge
  // and de-duplicate, or to compare quality), call each provider directly and
  // await them in parallel.
  console.log('\n=== 3. Fan-out — parallel multi-provider search ===');

  const fanOutProviders = [
    { provider: new DuckDuckGoProvider(), config: { name: 'duckduckgo', enabled: true } },
    ...(process.env['BRAVE_API_KEY']
      ? [{ provider: new BraveProvider(), config: { name: 'brave', enabled: true, apiKey: process.env['BRAVE_API_KEY'] } }]
      : []),
    ...(process.env['TAVILY_API_KEY']
      ? [{ provider: new TavilyProvider(), config: { name: 'tavily', enabled: true, apiKey: process.env['TAVILY_API_KEY'] } }]
      : []),
    ...(process.env['EXA_API_KEY']
      ? [{ provider: new ExaProvider(), config: { name: 'exa', enabled: true, apiKey: process.env['EXA_API_KEY'] } }]
      : []),
  ];

  const fanOutQuery = 'open source AI agent frameworks 2025';
  const fanOutResults = await Promise.allSettled(
    fanOutProviders.map(async ({ provider, config }) => ({
      provider: provider.name,
      results: await provider.search({ query: fanOutQuery, limit: 3 }, config),
    })),
  );

  const allResults: string[] = [];
  for (const outcome of fanOutResults) {
    if (outcome.status === 'fulfilled') {
      console.log(`  [${outcome.value.provider}]: ${outcome.value.results.length} results`);
      for (const r of outcome.value.results) {
        if (!allResults.includes(r.url)) {
          allResults.push(r.url);
        }
      }
    } else {
      console.log(`  [provider]: error — ${(outcome.reason as Error).message}`);
    }
  }
  console.log(`  Unique URLs across all providers: ${allResults.length}`);

  // --- 4. MCP tool exposure via createSearchTools() ---
  // createSearchTools() wraps a SearchRouter as MCP-compliant tool definitions.
  // The tools (web_search, image_search, news_search) can be registered in any
  // @weaveintel/tools-compatible registry and called by agents or served over MCP.
  console.log('\n=== 4. MCP tool exposure ===');

  const searchTools = createSearchTools(router);
  console.log(`MCP tools created: ${searchTools.map((t) => t.schema.name).join(', ')}`);

  // --- 5. Wiring into an agent ---
  // Register the search tools in a ToolRegistry so an agent can call web_search.
  // The agent gets real web results without needing an API key.
  console.log('\n=== 5. Search-augmented agent ===');

  const registry = weaveToolRegistry();
  for (const toolDef of searchTools) {
    registry.register(toolDef);
  }

  const model = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          {
            id: 'c1',
            function: {
              name: 'web_search',
              arguments: JSON.stringify({ query: 'weaveIntel GitHub repo', limit: 3 }),
            },
          },
        ],
      },
      { content: 'I found results for weaveIntel on GitHub. Let me summarise them for you.' },
    ],
  });

  const ctx = weaveContext({ userId: 'search-demo' });
  const agent = weaveAgent({
    model,
    tools: registry,
    maxSteps: 5,
    systemPrompt: 'You are a research assistant. Use web_search to find information.',
  });

  const result = await agent.run(ctx, {
    messages: [{ role: 'user', content: 'Find the weaveIntel GitHub repository.' }],
  });

  console.log(`Agent answer: ${result.messages[result.messages.length - 1]?.content}`);

  // --- Summary ---
  console.log('\n=== Summary ===');
  console.log('Provider hierarchy:');
  console.log('  tavily (priority 1) → brave (priority 5) → duckduckgo (priority 10, always free)');
  console.log('DuckDuckGo HTML fallback:');
  console.log('  Instant Answer API → (if 0 results) → HTML SERP page → result__a parsing');
  console.log('MCP integration:');
  console.log('  createSearchTools(router) → web_search / image_search / news_search tools');
  console.log('  compatible with @weaveintel/mcp-server for cross-agent tool sharing');
}

main().catch(console.error);
