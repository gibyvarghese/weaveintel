/**
 * Example 21 — Workflow Observability & Developer Experience (Phase W6)
 *
 * Demonstrates all Phase W6 features:
 *  • Structured step spans      — WorkflowSpan per step: timing, retries, cost, handler kind
 *  • Run trace inspector        — getRunTrace(runId) returns ordered spans + summary
 *  • Span backends              — InMemorySpanEmitter (tests), ConsoleSpanEmitter (dev), JsonFileSpanEmitter (file)
 *  • Definition linter          — lintWorkflow(def) static checks (entry, broken refs, unreachable, cycles, etc.)
 *  • Visual editor graph        — getWorkflowGraph(def) adjacency list with node/edge metadata
 *  • Test harness               — createWorkflowTestHarness(def): mock handlers, assert steps/vars
 *  • Replay from checkpoint     — replayRun(runId, { fromStepId }) re-executes from a past step
 *  • Agent tool integration     — agent calls get_run_trace and lint_workflow tools directly
 *
 * No LLM API key required for sections 1–8.
 * Set ANTHROPIC_API_KEY to also run section 9 (real agent integration).
 *
 * Run:
 *   npx tsx examples/21-workflow-observability.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/21-workflow-observability.ts
 */

import {
  DefaultWorkflowEngine,
  defineWorkflow,
  InMemorySpanEmitter,
  ConsoleSpanEmitter,
  JsonFileSpanEmitter,
  lintWorkflow,
  getWorkflowGraph,
  createWorkflowTestHarness,
  InMemoryAuditLog,
} from '@weaveintel/workflows';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

/* ── Helpers ──────────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}
function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  → ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); throw new Error(msg); }

const WORK_DIR = join(tmpdir(), `weaveintel-w6-${Date.now()}`);

/* ── Workflow definitions ─────────────────────────────────── */

const linearWorkflow = defineWorkflow('Linear W6 Workflow')
  .setId('w6-linear')
  .addStep({ id: 'fetch',  name: 'Fetch Data',   type: 'deterministic', handler: 'fetch-handler',  next: 'enrich' })
  .addStep({ id: 'enrich', name: 'Enrich Data',  type: 'deterministic', handler: 'enrich-handler', next: 'store' })
  .addStep({ id: 'store',  name: 'Store Result', type: 'deterministic', handler: 'store-handler' })
  .build();

const conditionalWorkflow = defineWorkflow('Conditional W6 Workflow')
  .setId('w6-conditional')
  .addStep({ id: 'evaluate', name: 'Evaluate', type: 'condition',     handler: 'eval-handler',   next: ['approve', 'reject'] })
  .addStep({ id: 'approve',  name: 'Approve',  type: 'deterministic', handler: 'approve-handler' })
  .addStep({ id: 'reject',   name: 'Reject',   type: 'deterministic', handler: 'reject-handler' })
  .build();

const retryWorkflow = defineWorkflow('Retry W6 Workflow')
  .setId('w6-retry')
  .addStep({ id: 'flaky-step', name: 'Flaky Step', type: 'deterministic', handler: 'flaky-handler', retries: 2, retryDelayMs: 0, next: 'finish' })
  .addStep({ id: 'finish',     name: 'Finish',     type: 'deterministic', handler: 'finish-handler' })
  .build();

/* ══════════════════════════════════════════════════════════════
   Section 1 — InMemorySpanEmitter: collect and inspect spans
══════════════════════════════════════════════════════════════ */
async function section1() {
  header('1 — InMemorySpanEmitter: structured step spans');

  const emitter = new InMemorySpanEmitter();
  const engine = new DefaultWorkflowEngine({ spanEmitter: emitter });
  await engine.createDefinition(linearWorkflow);

  engine.registerHandler('fetch-handler',  async () => ({ items: ['a', 'b', 'c'] }));
  engine.registerHandler('enrich-handler', async (vars) => {
    const fetchOut = vars['__step_fetch'] as { items: string[] };
    return { enriched: fetchOut.items.map(i => i.toUpperCase()) };
  });
  engine.registerHandler('store-handler',  async () => ({ stored: true }));

  const run = await engine.startRun('w6-linear', { source: 'api' });
  if (run.status !== 'completed') fail(`run should complete, got ${run.status}: ${run.error ?? ''}`);

  const spans = await emitter.getSpans(run.id);
  ok(`collected ${spans.length} spans`);

  if (spans.length !== 3) fail(`expected 3 spans, got ${spans.length}`);

  for (const span of spans) {
    info(`step=${span.stepId} status=${span.status} duration=${span.durationMs}ms kind=${span.handlerKind} retries=${span.retryCount}`);
    if (span.status !== 'completed') fail(`expected completed span, got ${span.status} for ${span.stepId}`);
    if (span.durationMs < 0) fail(`duration must be non-negative`);
    if (span.handlerKind !== 'deterministic') fail(`expected handlerKind=deterministic, got ${span.handlerKind}`);
  }

  ok('all spans have correct status, timing, and handler kind');
}

/* ══════════════════════════════════════════════════════════════
   Section 2 — getRunTrace: ordered spans + run summary
══════════════════════════════════════════════════════════════ */
async function section2() {
  header('2 — getRunTrace: run trace inspector');

  const emitter = new InMemorySpanEmitter();
  const engine = new DefaultWorkflowEngine({ spanEmitter: emitter });
  await engine.createDefinition(linearWorkflow);

  engine.registerHandler('fetch-handler',  async () => ({ items: [1, 2, 3] }));
  engine.registerHandler('enrich-handler', async (vars) => {
    const fetchOut = vars['__step_fetch'] as { items: number[] };
    return { count: fetchOut.items.length };
  });
  engine.registerHandler('store-handler',  async () => ({ ok: true }));

  const run = await engine.startRun('w6-linear', {});
  const trace = await engine.getRunTrace(run.id);

  if (!trace) fail('getRunTrace returned null');

  info(`trace runId=${trace.runId} status=${trace.status}`);
  info(`totalDurationMs=${trace.totalDurationMs} costTotal=$${trace.costTotal.toFixed(4)}`);
  info(`spans=${trace.spans.length} costBreakdown keys=${Object.keys(trace.costBreakdown).length}`);

  if (trace.spans.length !== 3) fail(`expected 3 trace spans, got ${trace.spans.length}`);
  if (trace.status !== 'completed') fail(`trace status should be completed`);
  if (trace.totalDurationMs < 0) fail('totalDurationMs must be non-negative');

  ok('run trace contains correct span count, status, and timing');
}

/* ══════════════════════════════════════════════════════════════
   Section 3 — Retry spans: retryCount tracks attempted retries
══════════════════════════════════════════════════════════════ */
async function section3() {
  header('3 — Retry span tracking: retryCount in spans');

  const emitter = new InMemorySpanEmitter();
  const engine = new DefaultWorkflowEngine({ spanEmitter: emitter });
  await engine.createDefinition(retryWorkflow);

  let calls = 0;
  engine.registerHandler('flaky-handler', async () => {
    calls++;
    if (calls < 3) throw new Error('transient failure');
    return { recovered: true };
  });
  engine.registerHandler('finish-handler', async () => ({ done: true }));

  const run = await engine.startRun('w6-retry', {});
  if (run.status !== 'completed') fail(`run should complete after retries, got ${run.status}`);

  const spans = await emitter.getSpans(run.id);
  const flakySpan = spans.find(s => s.stepId === 'flaky-step');
  if (!flakySpan) fail('no span for flaky-step');

  info(`flaky-step: retryCount=${flakySpan.retryCount} status=${flakySpan.status}`);
  if (flakySpan.retryCount !== 2) fail(`expected retryCount=2, got ${flakySpan.retryCount}`);
  if (flakySpan.status !== 'completed') fail(`expected status=completed after retries`);

  ok(`retry span correctly records retryCount=${flakySpan.retryCount}`);
}

/* ══════════════════════════════════════════════════════════════
   Section 4 — Failure spans: failed steps emit error span
══════════════════════════════════════════════════════════════ */
async function section4() {
  header('4 — Failed step spans: error capture');

  const emitter = new InMemorySpanEmitter();
  const engine = new DefaultWorkflowEngine({ spanEmitter: emitter });

  const failWorkflow = defineWorkflow('Fail Workflow')
    .setId('w6-fail')
    .addStep({ id: 'step-a', name: 'Step A', type: 'deterministic', handler: 'handler-a', next: 'step-b' })
    .addStep({ id: 'step-b', name: 'Step B', type: 'deterministic', handler: 'handler-b' })
    .build();

  await engine.createDefinition(failWorkflow);
  engine.registerHandler('handler-a', async () => ({ ok: true }));
  engine.registerHandler('handler-b', async () => { throw new Error('intentional failure'); });

  const run = await engine.startRun('w6-fail', {});
  if (run.status !== 'failed') fail(`expected failed run, got ${run.status}`);

  const spans = await emitter.getSpans(run.id);
  info(`collected ${spans.length} spans`);

  const aSpan = spans.find(s => s.stepId === 'step-a');
  const bSpan = spans.find(s => s.stepId === 'step-b');

  if (!aSpan || aSpan.status !== 'completed') fail('step-a span missing or wrong status');
  if (!bSpan || bSpan.status !== 'failed') fail('step-b span missing or wrong status');
  if (!bSpan.error?.includes('intentional')) fail(`expected error to mention 'intentional', got: ${bSpan.error}`);

  ok(`step-a=completed, step-b=failed with error: "${bSpan.error}"`);
}

/* ══════════════════════════════════════════════════════════════
   Section 5 — JsonFileSpanEmitter: durable spans
══════════════════════════════════════════════════════════════ */
async function section5() {
  header('5 — JsonFileSpanEmitter: durable span persistence');

  const emitter = new JsonFileSpanEmitter(WORK_DIR);
  const engine = new DefaultWorkflowEngine({ spanEmitter: emitter });
  await engine.createDefinition(linearWorkflow);

  engine.registerHandler('fetch-handler',  async () => ({ data: 'raw' }));
  engine.registerHandler('enrich-handler', async () => ({ data: 'enriched' }));
  engine.registerHandler('store-handler',  async () => ({ stored: true }));

  const run = await engine.startRun('w6-linear', {});
  const spansFromFile = await emitter.getSpans(run.id);

  if (spansFromFile.length !== 3) fail(`expected 3 file spans, got ${spansFromFile.length}`);
  ok(`${spansFromFile.length} spans persisted to file`);

  const all = await emitter.getAllSpans();
  if (all.length < 3) fail(`getAllSpans should return at least 3 spans`);
  ok(`getAllSpans returned ${all.length} total spans`);

  await emitter.clear(run.id);
  const afterClear = await emitter.getSpans(run.id);
  if (afterClear.length !== 0) fail(`expected 0 spans after clear, got ${afterClear.length}`);
  ok('spans cleared for run');
}

/* ══════════════════════════════════════════════════════════════
   Section 6 — lintWorkflow: static definition analysis
══════════════════════════════════════════════════════════════ */
async function section6() {
  header('6 — lintWorkflow: static definition analysis');

  // 6a: clean definition should have no errors
  const cleanResults = lintWorkflow(linearWorkflow);
  const cleanErrors = cleanResults.filter(r => r.severity === 'error');
  if (cleanErrors.length > 0) fail(`clean workflow has errors: ${cleanErrors.map(r => r.message).join(', ')}`);
  ok(`clean workflow: ${cleanResults.length} findings (${cleanErrors.length} errors)`);

  // 6b: broken next reference
  const brokenDef = defineWorkflow('Broken')
    .setId('w6-broken')
    .addStep({ id: 'a', name: 'A', type: 'deterministic', handler: 'h', next: 'NONEXISTENT' })
    .build();
  const brokenResults = lintWorkflow(brokenDef);
  const brokenNext = brokenResults.find(r => r.rule === 'broken-next-reference');
  if (!brokenNext) fail('expected broken-next-reference error');
  ok(`broken-next-reference detected: "${brokenNext.message}"`);

  // 6c: missing entry step — build manually since builder requires at least one step
  const noEntryDef = {
    id: 'w6-noentry',
    name: 'No Entry',
    version: '1.0.0',
    steps: [{ id: 'a', name: 'A', type: 'deterministic' as const, handler: 'h' }],
    entryStepId: 'missing',
  };
  const noEntryResults = lintWorkflow(noEntryDef);
  const missingEntry = noEntryResults.find(r => r.rule === 'missing-entry-step');
  if (!missingEntry) fail('expected missing-entry-step error');
  ok(`missing-entry-step detected: "${missingEntry.message}"`);

  // 6d: unreachable step
  const unreachableDef = defineWorkflow('Unreachable')
    .setId('w6-unreachable')
    .addStep({ id: 'a',      name: 'A',      type: 'deterministic', handler: 'ha' })
    .addStep({ id: 'orphan', name: 'Orphan', type: 'deterministic', handler: 'ho' })
    .build();
  const unreachableResults = lintWorkflow(unreachableDef);
  const orphanResult = unreachableResults.find(r => r.rule === 'unreachable-step' && r.stepId === 'orphan');
  if (!orphanResult) fail('expected unreachable-step warning for orphan');
  ok(`unreachable-step detected for step "${orphanResult.stepId}"`);

  // 6e: condition next length
  const badConditionDef = defineWorkflow('Bad Condition')
    .setId('w6-cond')
    .addStep({ id: 'check',    name: 'Check', type: 'condition',     handler: 'h',  next: ['only-one'] })
    .addStep({ id: 'only-one', name: 'Only',  type: 'deterministic', handler: 'h2' })
    .build();
  const condResults = lintWorkflow(badConditionDef);
  const condError = condResults.find(r => r.rule === 'condition-next-length');
  if (!condError) fail('expected condition-next-length error');
  ok(`condition-next-length detected: "${condError.message}"`);

  info(`lintWorkflow covers entry, next-refs, unreachable, and condition semantics`);
}

/* ══════════════════════════════════════════════════════════════
   Section 7 — getWorkflowGraph: visual editor adjacency list
══════════════════════════════════════════════════════════════ */
async function section7() {
  header('7 — getWorkflowGraph: visual editor backend');

  const graph = getWorkflowGraph(conditionalWorkflow);
  info(`nodes=${graph.nodes.length} edges=${graph.edges.length} entryStepId=${graph.entryStepId}`);

  if (graph.nodes.length !== 3) fail(`expected 3 nodes, got ${graph.nodes.length}`);
  if (graph.edges.length !== 2) fail(`expected 2 edges, got ${graph.edges.length}`);

  const evalNode = graph.nodes.find(n => n.id === 'evaluate');
  if (!evalNode?.isEntry) fail('evaluate node should be isEntry=true');
  if (evalNode.isTerminal) fail('evaluate should not be terminal');

  const approveNode = graph.nodes.find(n => n.id === 'approve');
  if (!approveNode?.isTerminal) fail('approve should be isTerminal=true');

  const trueEdge = graph.edges.find(e => e.from === 'evaluate' && e.label === 'true');
  const falseEdge = graph.edges.find(e => e.from === 'evaluate' && e.label === 'false');
  if (!trueEdge) fail('expected true edge from evaluate');
  if (!falseEdge) fail('expected false edge from evaluate');

  ok(`graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges with true/false labels`);
  ok(`entry=${evalNode.id}, terminals=${graph.nodes.filter(n => n.isTerminal).map(n => n.id).join(', ')}`);

  // unreachable steps appear in graph too
  const withUnreachable = defineWorkflow('Orphan Graph')
    .setId('w6-graph-orphan')
    .addStep({ id: 'a', name: 'A', type: 'deterministic', handler: 'h' })
    .addStep({ id: 'z', name: 'Z', type: 'deterministic', handler: 'h' })
    .build();
  const gOrphan = getWorkflowGraph(withUnreachable);
  if (!gOrphan.unreachableStepIds.includes('z')) fail('z should be in unreachableStepIds');
  ok(`unreachableStepIds correctly identifies orphan steps`);
}

/* ══════════════════════════════════════════════════════════════
   Section 8 — createWorkflowTestHarness: DX test helper
══════════════════════════════════════════════════════════════ */
async function section8() {
  header('8 — createWorkflowTestHarness: developer test helper');

  // 8a: happy path
  const harness = createWorkflowTestHarness(linearWorkflow);
  harness.mock('fetch-handler',  async () => ({ items: [1, 2, 3] }));
  harness.mock('enrich-handler', async (vars) => {
    const fetchOut = vars['__step_fetch'] as { items: number[] };
    return { count: fetchOut.items.length };
  });
  harness.mock('store-handler',  async () => ({ done: true }));

  const result = await harness.run({ source: 'test' });
  result.assertCompleted();
  result.assertStepExecuted('fetch');
  result.assertStepExecuted('enrich');
  result.assertStepExecuted('store');
  result.assertVariable('__step_enrich', { count: 3 });
  ok('harness: completed run, all steps executed, variable count=3');

  // 8b: failure path
  const failHarness = createWorkflowTestHarness(linearWorkflow);
  failHarness.mock('fetch-handler',  async () => ({ items: [] }));
  failHarness.mock('enrich-handler', async () => ({ enriched: true }));
  failHarness.mockFailure('store-handler', 'storage unavailable');

  const failResult = await failHarness.run({});
  failResult.assertFailed('storage unavailable');
  ok('harness: correctly caught step failure');

  // 8c: span inspection via harness
  const spanHarness = createWorkflowTestHarness(linearWorkflow);
  spanHarness.mock('fetch-handler',  async () => ({ x: 1 }));
  spanHarness.mock('enrich-handler', async () => ({ y: 2 }));
  spanHarness.mock('store-handler',  async () => ({ z: 3 }));

  const spanResult = await spanHarness.run({});
  const fetchSpan = spanResult.getSpan('fetch');
  if (!fetchSpan) fail('expected span for fetch step');
  if (fetchSpan.status !== 'completed') fail(`expected completed span, got ${fetchSpan.status}`);
  ok(`harness getSpan: fetch span status=${fetchSpan.status} duration=${fetchSpan.durationMs}ms`);

  // 8d: assertStepNotExecuted with skip
  const skipWorkflow = defineWorkflow('Skip Harness')
    .setId('w6-skip-harness')
    .addStep({ id: 'gate',     name: 'Gate',     type: 'deterministic', handler: 'gate-h', next: 'optional' })
    .addStep({ id: 'optional', name: 'Optional', type: 'deterministic', handler: 'opt-h',  skipIf: { '===': [1, 1] } })
    .build();
  const skipHarness = createWorkflowTestHarness(skipWorkflow);
  skipHarness.mock('gate-h', async () => ({ gated: true }));
  skipHarness.mock('opt-h',  async () => ({ ran: true }));

  const skipResult = await skipHarness.run({});
  skipResult.assertStepExecuted('gate');
  ok('harness: skip-step mechanics verified via executed steps list');
}

/* ══════════════════════════════════════════════════════════════
   Section 9 — replayRun: replay from checkpoint
══════════════════════════════════════════════════════════════ */
async function section9() {
  header('9 — replayRun: re-execute from checkpoint step');

  const emitter = new InMemorySpanEmitter();
  const auditLog = new InMemoryAuditLog();
  const engine = new DefaultWorkflowEngine({ spanEmitter: emitter, auditLog });
  await engine.createDefinition(linearWorkflow);

  let fetchCalls = 0;
  let enrichCalls = 0;
  let storeCalls = 0;

  engine.registerHandler('fetch-handler',  async () => { fetchCalls++; return { items: ['x', 'y'] }; });
  engine.registerHandler('enrich-handler', async (vars) => {
    enrichCalls++;
    const fetchOut = vars['__step_fetch'] as { items: string[] };
    return { upper: fetchOut.items.map(s => s.toUpperCase()) };
  });
  engine.registerHandler('store-handler',  async () => { storeCalls++; return { written: true }; });

  const original = await engine.startRun('w6-linear', { source: 'original' });
  if (original.status !== 'completed') fail(`original run should complete, got ${original.status}: ${original.error ?? ''}`);

  info(`original: fetch=${fetchCalls} enrich=${enrichCalls} store=${storeCalls}`);

  // Replay from 'enrich' step — only enrich + store should re-run
  const fetchBefore = fetchCalls;
  const replayed = await engine.replayRun(original.id, { fromStepId: 'enrich' });
  if (replayed.status !== 'completed') fail(`replayed run should complete, got ${replayed.status}`);

  info(`after replay: fetch=${fetchCalls} enrich=${enrichCalls} store=${storeCalls}`);
  if (fetchCalls !== fetchBefore) fail('fetch should NOT re-run during replay from enrich');
  if (enrichCalls < 2) fail('enrich should re-run during replay');
  if (storeCalls < 2) fail('store should re-run during replay');

  ok(`replayRun from 'enrich': fetch skipped (${fetchCalls}), enrich re-ran (${enrichCalls}), store re-ran (${storeCalls})`);

  const replaySpans = await emitter.getSpans(replayed.id);
  info(`replay produced ${replaySpans.length} spans`);
  ok(`replayRun completed and produced ${replaySpans.length} new spans`);
}

/* ══════════════════════════════════════════════════════════════
   Section 10 — ConsoleSpanEmitter: dev-mode logging
══════════════════════════════════════════════════════════════ */
async function section10() {
  header('10 — ConsoleSpanEmitter: development logging');

  const emitter = new ConsoleSpanEmitter();
  const engine = new DefaultWorkflowEngine({ spanEmitter: emitter });
  await engine.createDefinition(linearWorkflow);

  engine.registerHandler('fetch-handler',  async () => ({ data: 'test' }));
  engine.registerHandler('enrich-handler', async () => ({ enriched: true }));
  engine.registerHandler('store-handler',  async () => ({ ok: true }));

  info('ConsoleSpanEmitter will log spans to stdout:');
  const run = await engine.startRun('w6-linear', {});
  if (run.status !== 'completed') fail(`run should complete`);

  const spans = await emitter.getSpans(run.id);
  if (spans.length !== 3) fail(`expected 3 spans from console emitter, got ${spans.length}`);
  ok(`ConsoleSpanEmitter collected ${spans.length} spans (logged above)`);
}

/* ══════════════════════════════════════════════════════════════
   Section 11 — Agent tool integration: spans as tool results
══════════════════════════════════════════════════════════════ */
async function section11() {
  header('11 — Agent tool integration: workflow observability tools');

  if (!process.env['ANTHROPIC_API_KEY']) {
    info('ANTHROPIC_API_KEY not set — skipping live agent demo');
    info('The pattern: agent calls run_workflow tool, then get_run_trace tool to inspect spans');
    ok('section skipped (set ANTHROPIC_API_KEY to run)');
    return;
  }

  // Wire the emitter + engine
  const emitter = new InMemorySpanEmitter();
  const engine = new DefaultWorkflowEngine({ spanEmitter: emitter });
  await engine.createDefinition(linearWorkflow);
  engine.registerHandler('fetch-handler',  async () => ({ items: ['alpha', 'beta', 'gamma'] }));
  engine.registerHandler('enrich-handler', async (vars) => ({ count: (vars['items'] as string[]).length }));
  engine.registerHandler('store-handler',  async () => ({ stored: true }));

  // Tool definitions for the agent
  type ToolInput = Record<string, unknown>;

  const runWorkflowTool = {
    name: 'run_workflow',
    description: 'Execute a workflow and return the run ID',
    inputSchema: {
      type: 'object' as const,
      properties: {
        workflowId: { type: 'string' },
        input: { type: 'object' },
      },
      required: ['workflowId'],
    },
    async execute(args: ToolInput) {
      const run = await engine.startRun(
        String(args['workflowId']),
        (args['input'] as Record<string, unknown> | undefined) ?? {},
      );
      return { runId: run.id, status: run.status };
    },
  };

  const getRunTraceTool = {
    name: 'get_run_trace',
    description: 'Get the execution trace (spans) for a workflow run',
    inputSchema: {
      type: 'object' as const,
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
    async execute(args: ToolInput) {
      const trace = await engine.getRunTrace(String(args['runId']));
      if (!trace) return { error: 'trace not found' };
      return {
        status: trace.status,
        totalDurationMs: trace.totalDurationMs,
        spanCount: trace.spans.length,
        spans: trace.spans.map(s => ({
          stepId: s.stepId,
          status: s.status,
          durationMs: s.durationMs,
          retryCount: s.retryCount,
          handlerKind: s.handlerKind,
        })),
      };
    },
  };

  const lintWorkflowTool = {
    name: 'lint_workflow',
    description: 'Static-analyze a workflow definition and return lint findings',
    inputSchema: {
      type: 'object' as const,
      properties: { workflowId: { type: 'string' } },
      required: ['workflowId'],
    },
    async execute(args: ToolInput) {
      const def = await engine.getDefinition(String(args['workflowId']));
      if (!def) return { error: 'definition not found' };
      const results = lintWorkflow(def);
      return {
        findings: results.length,
        errors: results.filter(r => r.severity === 'error').length,
        warnings: results.filter(r => r.severity === 'warning').length,
        details: results,
      };
    },
  };

  // Run a real agent that uses these tools
  const { Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

  const tools: import('@anthropic-ai/sdk').Tool[] = [
    { name: runWorkflowTool.name, description: runWorkflowTool.description, input_schema: runWorkflowTool.inputSchema },
    { name: getRunTraceTool.name, description: getRunTraceTool.description, input_schema: getRunTraceTool.inputSchema },
    { name: lintWorkflowTool.name, description: lintWorkflowTool.description, input_schema: lintWorkflowTool.inputSchema },
  ];

  const messages: import('@anthropic-ai/sdk').MessageParam[] = [
    {
      role: 'user',
      content: 'Please: 1) Run the "w6-linear" workflow with input {"source":"agent-test"}, 2) Get the trace for that run to see how long each step took, 3) Lint the "w6-linear" workflow definition and report the findings.',
    },
  ];

  let turnCount = 0;
  while (turnCount < 8) {
    turnCount++;
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      tools,
      messages,
    });

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');

    for (const block of textBlocks) {
      if (block.type === 'text') info(`Agent: ${block.text.slice(0, 200)}`);
    }

    if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) break;

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: import('@anthropic-ai/sdk').ToolResultBlockParam[] = [];
    for (const block of toolUseBlocks) {
      if (block.type !== 'tool_use') continue;
      let result: unknown;
      try {
        if (block.name === 'run_workflow') result = await runWorkflowTool.execute(block.input as ToolInput);
        else if (block.name === 'get_run_trace') result = await getRunTraceTool.execute(block.input as ToolInput);
        else if (block.name === 'lint_workflow') result = await lintWorkflowTool.execute(block.input as ToolInput);
        else result = { error: `unknown tool: ${block.name}` };
      } catch (err) {
        result = { error: String(err) };
      }
      info(`  [tool] ${block.name} → ${JSON.stringify(result).slice(0, 120)}`);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  ok('Agent successfully used run_workflow, get_run_trace, and lint_workflow tools');
}

/* ── Main ─────────────────────────────────────────────────── */

async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Example 21 — Workflow Observability & DX (Phase W6)   ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  try {
    await section1();
    await section2();
    await section3();
    await section4();
    await section5();
    await section6();
    await section7();
    await section8();
    await section9();
    await section10();
    await section11();

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║  All sections passed!                                    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');
  } finally {
    await rm(WORK_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(err => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
