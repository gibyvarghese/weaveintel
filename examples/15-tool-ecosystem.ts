/**
 * Example 15 — Tool Ecosystem: Search, Browser, and HTTP Tools
 *
 * Demonstrates:
 *  • Extended tool registry with health tracking and risk classification
 *  • Web search providers (DuckDuckGo, Brave)
 *  • Browser tools — fetch page, extract content, readability
 *  • HTTP endpoint tools with auth and retry
 *  • Bridging tools to MCP definitions
 *  • Agent using the full tool ecosystem with tool-calling loop
 *
 * No API keys needed — uses mock data and fake model for the agent loop.
 *
 * Run: npx tsx examples/15-tool-ecosystem.ts
 */

import {
  weaveToolDescriptor,
  weaveHealthTracker,
  weaveExtendedToolRegistry,
  weaveRunToolTests,
  toolsToMCPDefinitions,
  type ExtendedToolDescriptor,
} from '@weaveintel/tools';

import {
  DuckDuckGoProvider,
  createSearchRouter,
  createSearchTools,
  type SearchResult,
} from '@weaveintel/tools-search';

import {
  fetchPage,
  extractContent,
  createBrowserTools,
  type FetchResult,
} from '@weaveintel/tools-browser';

import {
  httpRequest,
  createHttpTools,
  type HttpResponse,
} from '@weaveintel/tools-http';

import { weaveContext, weaveToolRegistry, weaveTool } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

/* ── 1. Extended Tool Registry ────────────────────────── */

header('1. Extended Tool Registry with Health Tracking');

const healthTracker = weaveHealthTracker();

const weatherTool = weaveToolDescriptor({
  name: 'get_weather',
  description: 'Get current weather for a city',
  version: '1.2.0',
  risk: 'low',
  parameters: {
    type: 'object' as const,
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
  execute: async (args: Record<string, unknown>) => {
    const city = String(args['city'] || 'Unknown');
    return { city, temperature: 22, condition: 'Partly Cloudy', humidity: 65 };
  },
});

const stockTool = weaveToolDescriptor({
  name: 'get_stock_price',
  description: 'Get current stock price by ticker symbol',
  version: '2.0.1',
  risk: 'low',
  parameters: {
    type: 'object' as const,
    properties: { ticker: { type: 'string', description: 'Stock ticker (e.g., AAPL)' } },
    required: ['ticker'],
  },
  execute: async (args: Record<string, unknown>) => {
    const ticker = String(args['ticker'] || 'AAPL');
    const prices: Record<string, number> = { AAPL: 198.50, GOOGL: 175.20, MSFT: 420.80, TSLA: 245.30 };
    return { ticker, price: prices[ticker] || 100.00, currency: 'USD', change: '+1.2%' };
  },
});

const extRegistry = weaveExtendedToolRegistry();
extRegistry.register(weatherTool);
extRegistry.register(stockTool);

// Record health data
healthTracker.recordSuccess('get_weather', 45);
healthTracker.recordSuccess('get_weather', 50);
healthTracker.recordSuccess('get_stock_price', 120);
healthTracker.recordFailure('get_stock_price');
healthTracker.recordSuccess('get_stock_price', 90);

console.log('Registered tools:');
for (const tool of extRegistry.list()) {
  const health = healthTracker.getHealth(tool.name);
  console.log(`  📦 ${tool.name} v${tool.version} [risk: ${tool.risk}] — ${health.successRate.toFixed(0)}% success, avg ${health.avgLatency.toFixed(0)}ms`);
}

/* ── 2. Tool Tests ────────────────────────────────────── */

header('2. Tool Test Harness');

const testCases = [
  { toolName: 'get_weather', input: { city: 'Paris' }, expectedFields: ['city', 'temperature'] },
  { toolName: 'get_stock_price', input: { ticker: 'AAPL' }, expectedFields: ['ticker', 'price'] },
];

const testResults = await weaveRunToolTests(extRegistry, testCases);
for (const result of testResults) {
  const status = result.passed ? '✅' : '❌';
  console.log(`  ${status} ${result.toolName}(${JSON.stringify(result.input)}) — ${result.duration}ms`);
  if (result.output) console.log(`     Output: ${JSON.stringify(result.output)}`);
}

/* ── 3. Search Tools ──────────────────────────────────── */

header('3. Web Search Tools');

// Create search tools (these wrap the providers into weaveIntel Tool interface)
const searchTools = createSearchTools({
  providers: {
    duckduckgo: new DuckDuckGoProvider(),
  },
  defaultProvider: 'duckduckgo',
});

console.log(`Search tools created: ${searchTools.map(t => t.name).join(', ')}`);

// Simulate search results (the actual API call may or may not work without keys)
const mockResults: SearchResult[] = [
  { title: 'TypeScript Handbook', url: 'https://www.typescriptlang.org/docs/handbook', snippet: 'The TypeScript Handbook is a comprehensive guide...' },
  { title: 'TypeScript Deep Dive', url: 'https://basarat.gitbook.io/typescript/', snippet: 'A detailed guide to TypeScript features...' },
  { title: 'TypeScript Tutorial', url: 'https://www.tutorialspoint.com/typescript/', snippet: 'TypeScript is a typed superset of JavaScript...' },
];

console.log('\nSimulated search for "TypeScript generics":');
for (const r of mockResults) {
  console.log(`  🔗 ${r.title}`);
  console.log(`     ${r.url}`);
  console.log(`     ${r.snippet}\n`);
}

/* ── 4. Browser Tools ─────────────────────────────────── */

header('4. Browser Tools — Fetch & Extract');

const browserTools = createBrowserTools();
console.log(`Browser tools created: ${browserTools.map(t => t.name).join(', ')}`);

// Simulate a page fetch result
const mockFetch: FetchResult = {
  url: 'https://example.com/article',
  status: 200,
  headers: { 'content-type': 'text/html' },
  body: '<html><body><article><h1>AI in 2025</h1><p>Artificial intelligence continues to transform...</p></article></body></html>',
};

console.log(`\nFetched: ${mockFetch.url} (status ${mockFetch.status})`);

const extracted = extractContent(mockFetch.body);
console.log(`Extracted content: "${extracted.text.slice(0, 100)}..."`);
console.log(`Title: ${extracted.title || 'N/A'}`);

/* ── 5. HTTP Endpoint Tools ───────────────────────────── */

header('5. HTTP Endpoint Tools');

const httpTools = createHttpTools({
  endpoints: [
    {
      name: 'github_repos',
      description: 'List GitHub repositories for a user',
      method: 'GET',
      urlTemplate: 'https://api.github.com/users/{username}/repos',
      headers: { Accept: 'application/vnd.github.v3+json' },
    },
    {
      name: 'jsonplaceholder_post',
      description: 'Create a post on JSONPlaceholder',
      method: 'POST',
      urlTemplate: 'https://jsonplaceholder.typicode.com/posts',
      headers: { 'Content-Type': 'application/json' },
    },
  ],
});

console.log(`HTTP tools created: ${httpTools.map(t => t.name).join(', ')}`);

// Simulate HTTP response
const mockHttp: HttpResponse = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify([
    { name: 'weaveintel', stars: 42, language: 'TypeScript' },
    { name: 'ai-tools', stars: 18, language: 'Python' },
  ]),
};

console.log(`\nSimulated GET github_repos(gibyvarghese):`);
const repos = JSON.parse(mockHttp.body as string) as Array<Record<string, unknown>>;
repos.forEach(r => console.log(`  📁 ${r['name']} ⭐ ${r['stars']} (${r['language']})`));

/* ── 6. Bridge Tools to MCP ───────────────────────────── */

header('6. Bridge to MCP Definitions');

const toolsForMcp = [weatherTool, stockTool];
const mcpDefs = toolsToMCPDefinitions(toolsForMcp);

console.log('MCP tool definitions:');
for (const def of mcpDefs) {
  console.log(`  🔧 ${def.name}: ${def.description}`);
  console.log(`     Schema: ${JSON.stringify(def.inputSchema).slice(0, 80)}...`);
}

/* ── 7. Agent with Full Tool Ecosystem ────────────────── */

header('7. Agent Using Tool Ecosystem');

const ctx = weaveContext({ userId: 'demo', timeout: 30_000 });

// Create a unified tool registry for the agent
const agentTools = weaveToolRegistry();
agentTools.register(
  weaveTool({
    name: 'web_search',
    description: 'Search the web for information',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
    execute: async (args) => JSON.stringify(mockResults),
  }),
);
agentTools.register(
  weaveTool({
    name: 'get_weather',
    description: 'Get current weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
    execute: async (args) => JSON.stringify({ city: args['city'], temp: 22, condition: 'Sunny' }),
  }),
);
agentTools.register(
  weaveTool({
    name: 'get_stock',
    description: 'Get stock price by ticker',
    parameters: {
      type: 'object',
      properties: { ticker: { type: 'string', description: 'Ticker symbol' } },
      required: ['ticker'],
    },
    execute: async (args) => JSON.stringify({ ticker: args['ticker'], price: 198.50, change: '+1.2%' }),
  }),
);
agentTools.register(
  weaveTool({
    name: 'fetch_page',
    description: 'Fetch and extract content from a URL',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
    },
    execute: async (args) => JSON.stringify({ title: 'AI in 2025', content: 'AI continues to transform industries...' }),
  }),
);

// Fake model that simulates a multi-step research task
const model = weaveFakeModel({
  responses: [
    // Step 1: Agent decides to search
    JSON.stringify({
      content: null,
      toolCalls: [{ id: 'tc1', name: 'web_search', arguments: '{"query":"latest AI trends 2025"}' }],
    }),
    // Step 2: Agent fetches a page from search results
    JSON.stringify({
      content: null,
      toolCalls: [{ id: 'tc2', name: 'fetch_page', arguments: '{"url":"https://example.com/article"}' }],
    }),
    // Step 3: Agent also checks weather and stocks
    JSON.stringify({
      content: null,
      toolCalls: [
        { id: 'tc3', name: 'get_weather', arguments: '{"city":"San Francisco"}' },
        { id: 'tc4', name: 'get_stock', arguments: '{"ticker":"AAPL"}' },
      ],
    }),
    // Step 4: Agent synthesizes final answer
    'Based on my research:\n\n1. **AI Trends**: AI continues to transform industries with advances in reasoning and multi-agent systems.\n2. **Weather**: San Francisco is 22°C and Sunny.\n3. **Markets**: AAPL is trading at $198.50 (+1.2%).\n\nThe intersection of AI and financial markets is particularly exciting, with new models capable of real-time analysis.',
  ],
});

const agent = weaveAgent({
  model,
  tools: agentTools,
  systemPrompt: 'You are a research assistant with access to web search, page fetching, weather, and stock tools. Use multiple tools to answer comprehensively.',
  maxSteps: 5,
});

console.log('Running agent: "Give me a briefing on AI trends, SF weather, and AAPL stock"\n');

const result = await agent.run(
  { messages: [{ role: 'user', content: 'Give me a briefing on AI trends, SF weather, and AAPL stock' }] },
  ctx,
);

console.log(`Steps taken: ${result.steps?.length || 'N/A'}`);
console.log(`\nAgent response:\n${result.content}`);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Extended tool registry with versioning and risk classification');
console.log('✅ Health tracking for tool reliability monitoring');
console.log('✅ Tool test harness for validation');
console.log('✅ Web search tools (DuckDuckGo provider)');
console.log('✅ Browser tools (fetch, extract, readability)');
console.log('✅ HTTP endpoint tools (REST API integration)');
console.log('✅ MCP tool bridge for protocol interop');
console.log('✅ Agent using 4 tools in a multi-step research workflow');
