/**
 * Example 15 — Tool Ecosystem
 *
 * Demonstrates:
 *  • Extended tool descriptors with risk levels and rate limits
 *  • Extended tool registry with health tracking
 *  • Tool health monitoring (invocations, errors, circuit breaker)
 *  • Running tool test suites
 *  • Converting tools to MCP definitions
 *
 * No API keys needed — uses deterministic in-memory primitives.
 *
 * Run: npx tsx examples/15-tool-ecosystem.ts
 */

import {
  weaveToolDescriptor,
  weaveHealthTracker,
  weaveRunToolTests,
  weaveExtendedToolRegistry,
  toolsToMCPDefinitions,
} from '@weaveintel/tools';

import {
  weaveContext,
  weaveTool,
  weaveToolRegistry,
} from '@weaveintel/core';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function main() {

/* ── 1. Extended Tool Descriptors ─────────────────────── */

header('1. Extended Tool Descriptors');

const searchDescriptor = weaveToolDescriptor(
  'web_search',
  'Search the web for information',
  'read-only',
  { rateLimit: { perMinute: 30 }, maxExecutionMs: 5000 },
);

const deleteDescriptor = weaveToolDescriptor(
  'delete_record',
  'Delete a database record',
  'destructive',
  { rateLimit: { perMinute: 5 }, maxExecutionMs: 10000 },
);

const payDescriptor = weaveToolDescriptor(
  'process_payment',
  'Process a financial transaction',
  'financial',
  { rateLimit: { perMinute: 10 }, maxExecutionMs: 15000 },
);

for (const d of [searchDescriptor, deleteDescriptor, payDescriptor]) {
  console.log(`  ${d.name} — risk: ${d.riskLevel}, rate: ${d.rateLimit?.perMinute}/min, timeout: ${d.maxExecutionMs}ms`);
}

/* ── 2. Health Tracking ───────────────────────────────── */

header('2. Tool Health Tracking');

const healthTracker = weaveHealthTracker({ errorThreshold: 3, windowMs: 60_000 });

// Simulate tool invocations
const invocations = [
  { tool: 'web_search', latency: 200, error: false },
  { tool: 'web_search', latency: 350, error: false },
  { tool: 'web_search', latency: 180, error: false },
  { tool: 'delete_record', latency: 100, error: false },
  { tool: 'delete_record', latency: 5000, error: true },
  { tool: 'delete_record', latency: 4500, error: true },
  { tool: 'delete_record', latency: 4800, error: true },
  { tool: 'process_payment', latency: 800, error: false },
  { tool: 'process_payment', latency: 950, error: false },
];

for (const inv of invocations) {
  healthTracker.record(inv.tool, inv.latency, inv.error);
}

const allStats = healthTracker.getAll();
for (const s of allStats) {
  const circuitEmoji = s.circuitOpen ? '🔴 OPEN' : '🟢 CLOSED';
  console.log(`  ${s.toolName}: ${s.invocations} calls, ${s.errors} errors, avg ${s.avgLatencyMs.toFixed(0)}ms — circuit: ${circuitEmoji}`);
}

console.log(`\n  Circuit open for delete_record? ${healthTracker.isCircuitOpen('delete_record')}`);

/* ── 3. Extended Tool Registry ────────────────────────── */

header('3. Extended Tool Registry');

const registry = weaveExtendedToolRegistry();

const searchTool = weaveTool({
  name: 'web_search',
  description: 'Search the web',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async (args) => `Results for: ${(args as { query: string }).query}`,
});

const calcTool = weaveTool({
  name: 'calculator',
  description: 'Evaluate math expressions',
  parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] },
  execute: async (args) => String(eval((args as { expr: string }).expr)),
});

registry.registerWithDescriptor(searchTool, searchDescriptor);
registry.register(calcTool);

console.log(`  Registered tools: ${registry.list().map(t => t.name).join(', ')}`);

const descriptors = registry.listDescriptors();
for (const d of descriptors) {
  console.log(`  ${d.name}: risk=${d.riskLevel}, rate=${d.rateLimit?.perMinute ?? 'unlimited'}/min`);
}

const destructiveTools = registry.listByRisk('destructive');
console.log(`\n  Destructive tools: ${destructiveTools.length > 0 ? destructiveTools.map(t => t.name).join(', ') : '(none in registry)'}`);

/* ── 4. Tool Testing ──────────────────────────────────── */

header('4. Tool Test Suite');

const ctx = weaveContext({ userId: 'tester' });

const testResults = await weaveRunToolTests(searchTool, ctx, [
  { name: 'basic search', input: { name: 'web_search', arguments: { query: 'TypeScript' } }, expectedContent: 'Results for: TypeScript' },
  { name: 'empty query', input: { name: 'web_search', arguments: { query: '' } }, expectedContent: 'Results for: ' },
  { name: 'special chars', input: { name: 'web_search', arguments: { query: 'hello world & more' } }, expectedContent: 'Results for: hello world & more' },
]);

for (const r of testResults) {
  const emoji = r.passed ? '✅' : '❌';
  console.log(`  ${emoji} ${r.case}: ${r.passed ? 'PASS' : 'FAIL'}${r.error ? ' — ' + r.error : ''} (${r.durationMs}ms)`);
}

/* ── 5. MCP Conversion ────────────────────────────────── */

header('5. Tools → MCP Definitions');

const basicRegistry = weaveToolRegistry();
basicRegistry.register(searchTool);
basicRegistry.register(calcTool);

const mcpDefs = toolsToMCPDefinitions(basicRegistry);
for (const def of mcpDefs) {
  console.log(`  MCP Tool: ${def.name}`);
  console.log(`    Description: ${def.description}`);
  console.log(`    Schema: ${JSON.stringify(def.inputSchema).slice(0, 80)}...`);
}

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Extended tool descriptors with risk levels and rate limits');
console.log('✅ Health tracking with circuit breaker detection');
console.log('✅ Extended registry with descriptor metadata');
console.log('✅ Tool test suite execution');
console.log('✅ MCP definition conversion');
}

main().catch(console.error);
