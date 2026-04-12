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
 * WeaveIntel packages used:
 *   @weaveintel/tools — Extended tool management layer:
 *     • weaveToolDescriptor()      — Enriches a tool with risk level, rate limits, and timeout
 *     • weaveHealthTracker()       — Tracks per-tool invocation counts, errors, and latency;
 *                                    implements a circuit breaker pattern (auto-disables tools
 *                                    that exceed error thresholds)
 *     • weaveExtendedToolRegistry()— Registry that integrates descriptors + health tracking
 *     • weaveRunToolTests()        — Runs test suites (input/expectedOutput pairs) against tools
 *     • toolsToMCPDefinitions()    — Converts weaveIntel tools to MCP-compliant tool definitions
 *   @weaveintel/core  — ExecutionContext, weaveTool(), weaveToolRegistry()
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

// weaveToolDescriptor() enriches a tool with operational metadata that the
// extended registry and health tracker use for gating:
//   • riskLevel ('read-only' | 'destructive' | 'financial') — controls approval requirements
//   • rateLimit.perMinute — max invocations/min before throttling
//   • maxExecutionMs      — hard timeout per invocation
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

// weaveHealthTracker() monitors per-tool invocation counts, error counts,
// and average latency within a sliding time window. When errors exceed
// `errorThreshold`, the circuit breaker trips — isCircuitOpen() returns true
// and the tool is auto-disabled until the window resets.
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

// weaveExtendedToolRegistry() extends the base weaveToolRegistry with
// descriptor metadata. registerWithDescriptor() attaches risk level and
// rate limit info; listDescriptors() returns tools with their metadata;
// listByRisk() filters tools by risk classification.
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

console.log(`  Registered tools: ${registry.list().map(t => t.schema.name).join(', ')}`);

const descriptors = registry.listDescriptors();
for (const d of descriptors) {
  console.log(`  ${d.name}: risk=${d.riskLevel}, rate=${d.rateLimit?.perMinute ?? 'unlimited'}/min`);
}

const destructiveTools = registry.listByRisk('destructive');
console.log(`\n  Destructive tools: ${destructiveTools.length > 0 ? destructiveTools.map(t => t.schema.name).join(', ') : '(none in registry)'}`);

/* ── 4. Tool Testing ──────────────────────────────────── */

header('4. Tool Test Suite');

const ctx = weaveContext({ userId: 'tester' });

// weaveRunToolTests() runs a test suite against a tool. Each test case
// specifies input arguments and expected output (substring match). Returns
// per-case results with pass/fail, error message, and duration.
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

// toolsToMCPDefinitions() converts a weaveToolRegistry into an array of
// MCP-compliant tool definitions (name, description, inputSchema). This
// bridges WeaveIntel’s tool system with the Model Context Protocol so
// any weaveIntel tool can be exposed via an MCP server.
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
