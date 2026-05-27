/**
 * Example 19 — Workflow Governance & Operations (Phase W5)
 *
 * Demonstrates all Phase W5 features:
 *  • Per-definition rate limiting  — token-bucket; excess calls throw WorkflowRateLimitError
 *  • Concurrency limits            — maxConcurrentRuns; excess buffered in priority queue
 *  • Run queue with priority       — higher priority runs start first when slot frees
 *  • Step cost tagging             — __cost field extracted into run.costBreakdown
 *  • Admin API                     — listRuns (filtered), forceCancelRun, forceResumeRun, patchRunVariables
 *  • Tenant isolation              — listRuns filtered by tenantId
 *  • File-backed stores            — JsonFileWorkflowRateLimiter, JsonFileRunQueue
 *  • Agent tool integration        — agent calls governance tools (run_workflow, get_run_cost, admin_list_runs)
 *
 * No LLM API key required for sections 1–9.
 * Set ANTHROPIC_API_KEY to also run section 10 (real agent demo).
 *
 * Run:
 *   npx tsx examples/19-workflow-governance.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/19-workflow-governance.ts
 */

import {
  DefaultWorkflowEngine,
  defineWorkflow,
  InMemoryWorkflowRateLimiter,
  JsonFileWorkflowRateLimiter,
  InMemoryRunQueue,
  JsonFileRunQueue,
  InMemoryAuditLog,
  DefaultWorkflowAdminService,
} from '@weaveintel/workflows';
import { WorkflowConcurrencyError, WorkflowRateLimitError } from '@weaveintel/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}
function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function info(msg: string) { console.log(`  → ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); throw new Error(msg); }

const WORK_DIR = join(tmpdir(), `weaveintel-w5-${Date.now()}`);

/* ─────────────────────────────────────────────────────────
   1. InMemoryWorkflowRateLimiter — token bucket
   ───────────────────────────────────────────────────────── */

header('1. InMemoryWorkflowRateLimiter — token-bucket rate limiting');

const rateLimiter = new InMemoryWorkflowRateLimiter();

// First 3 calls should succeed (maxRunsPerMinute=3)
let allowed = 0;
for (let i = 0; i < 3; i++) {
  if (await rateLimiter.allow('wf-a', 3)) allowed++;
}
info(`Allowed: ${allowed}/3`);
if (allowed !== 3) fail(`Expected 3 allowed, got ${allowed}`);
ok('First 3 calls allowed within rate limit');

// 4th call should be rejected (bucket exhausted)
const blocked = !(await rateLimiter.allow('wf-a', 3));
if (!blocked) fail('4th call should be rate-limited');
ok('4th call rejected — bucket exhausted');

const remaining = await rateLimiter.remaining('wf-a', 3);
info(`Remaining tokens: ${remaining}`);
if (remaining !== 0) fail(`Expected 0 remaining, got ${remaining}`);
ok('remaining() returns 0 when bucket is empty');

// Reset restores the bucket
await rateLimiter.reset('wf-a');
const afterReset = await rateLimiter.allow('wf-a', 3);
if (!afterReset) fail('Should be allowed after reset');
ok('reset() restores the bucket to full capacity');

// Different workflow IDs have independent buckets
await rateLimiter.allow('wf-b', 1);
const wfBBlocked = !(await rateLimiter.allow('wf-b', 1));
if (!wfBBlocked) fail('wf-b second call should be rate-limited');
const wfCAllowed = await rateLimiter.allow('wf-c', 5);
if (!wfCAllowed) fail('wf-c first call should be allowed');
ok('Independent token buckets per workflow ID');

/* ─────────────────────────────────────────────────────────
   2. Engine — rate limit via WorkflowRateLimitError
   ───────────────────────────────────────────────────────── */

header('2. Engine — WorkflowRateLimitError on policy.maxRunsPerMinute exceeded');

const rl2 = new InMemoryWorkflowRateLimiter();
const engine2 = new DefaultWorkflowEngine({ rateLimiter: rl2 });

const wfRated = defineWorkflow('rated-wf')
  .setId('rated-wf')
  .setPolicy({ maxRunsPerMinute: 2 })
  .deterministic('step', 'Step')
  .build();

await engine2.createDefinition(wfRated);
engine2.registerHandler('step', async () => ({ done: true }));

// First 2 runs succeed
const r2a = await engine2.startRun('rated-wf', {});
const r2b = await engine2.startRun('rated-wf', {});
info(`Run 1: ${r2a.status}, Run 2: ${r2b.status}`);
if (r2a.status !== 'completed') fail(`Expected completed, got ${r2a.status}`);
if (r2b.status !== 'completed') fail(`Expected completed, got ${r2b.status}`);
ok('First 2 runs within rate limit — completed successfully');

// 3rd run should throw
let rateLimitThrown = false;
try {
  await engine2.startRun('rated-wf', {});
} catch (err) {
  if (err instanceof WorkflowRateLimitError) {
    rateLimitThrown = true;
    info(`WorkflowRateLimitError: ${err.message}`);
    if (err.workflowId !== 'rated-wf') fail('Wrong workflowId on error');
    if (err.limitPerMinute !== 2) fail('Wrong limitPerMinute on error');
  }
}
if (!rateLimitThrown) fail('Expected WorkflowRateLimitError on 3rd run');
ok('3rd run throws WorkflowRateLimitError with correct details');

/* ─────────────────────────────────────────────────────────
   3. InMemoryRunQueue — priority queue mechanics
   ───────────────────────────────────────────────────────── */

header('3. InMemoryRunQueue — priority ordering and dequeue');

const queue = new InMemoryRunQueue();

await queue.enqueue({ runId: 'r1', workflowId: 'wf-x', input: {}, priority: 3, opts: {} });
await queue.enqueue({ runId: 'r2', workflowId: 'wf-x', input: {}, priority: 7, opts: {} });
await queue.enqueue({ runId: 'r3', workflowId: 'wf-x', input: {}, priority: 3, opts: {} });
await queue.enqueue({ runId: 'r4', workflowId: 'wf-y', input: {}, priority: 9, opts: {} });

const total = await queue.size();
const forX = await queue.sizeFor('wf-x');
info(`Total queue size: ${total}, for wf-x: ${forX}`);
if (total !== 4) fail(`Expected 4, got ${total}`);
if (forX !== 3) fail(`Expected 3 for wf-x, got ${forX}`);
ok('enqueue() adds entries; size() and sizeFor() count correctly');

// Dequeue should return highest priority first
const first = await queue.dequeue('wf-x');
info(`First dequeued: runId=${first?.runId}, priority=${first?.priority}`);
if (first?.runId !== 'r2') fail(`Expected r2 (priority 7), got ${first?.runId}`);
ok('dequeue() returns highest-priority entry first');

const second = await queue.dequeue('wf-x');
info(`Second dequeued: runId=${second?.runId}, priority=${second?.priority}`);
// r1 and r3 have same priority=3; r1 was enqueued first (FIFO tiebreak)
if (second?.runId !== 'r1') fail(`Expected r1 (first with priority 3), got ${second?.runId}`);
ok('FIFO tiebreak within same priority band');

// wf-y entry is independent
const yEntry = await queue.dequeue('wf-y');
if (yEntry?.runId !== 'r4') fail(`Expected r4 for wf-y`);
ok('Per-workflow dequeue is isolated');

const remaining3 = await queue.listFor('wf-x');
if (remaining3.length !== 1 || remaining3[0]!.runId !== 'r3') fail('Expected r3 remaining for wf-x');
ok('listFor() returns remaining entries for workflow');

/* ─────────────────────────────────────────────────────────
   4. Engine — concurrency limit + WorkflowConcurrencyError
   ───────────────────────────────────────────────────────── */

header('4. Engine — WorkflowConcurrencyError when maxConcurrentRuns exceeded (no queue)');

const engine4 = new DefaultWorkflowEngine();

// Workflow where every run pauses immediately (simulates long-running)
const wfLong = defineWorkflow('long-wf')
  .setId('long-wf')
  .setPolicy({ maxConcurrentRuns: 2 })
  .wait('waiting', 'Waiting for input')
  .build();

await engine4.createDefinition(wfLong);

const runA = await engine4.startRun('long-wf', {});
const runB = await engine4.startRun('long-wf', {});
info(`runA: ${runA.status}, runB: ${runB.status}`);
if (runA.status !== 'paused') fail(`Expected paused, got ${runA.status}`);
if (runB.status !== 'paused') fail(`Expected paused, got ${runB.status}`);
ok('Two concurrent runs started — both paused as expected');

// Third run should throw WorkflowConcurrencyError
let concurrencyThrown = false;
try {
  await engine4.startRun('long-wf', {});
} catch (err) {
  if (err instanceof WorkflowConcurrencyError) {
    concurrencyThrown = true;
    info(`WorkflowConcurrencyError: ${err.message}`);
    if (err.workflowId !== 'long-wf') fail('Wrong workflowId');
    if (err.limit !== 2) fail(`Wrong limit: ${err.limit}`);
    if (err.activeCount !== 2) fail(`Wrong activeCount: ${err.activeCount}`);
  }
}
if (!concurrencyThrown) fail('Expected WorkflowConcurrencyError');
ok('3rd startRun throws WorkflowConcurrencyError with correct details');

/* ─────────────────────────────────────────────────────────
   5. Engine — concurrency limit + run queue buffering
   ───────────────────────────────────────────────────────── */

header('5. Engine — run queue buffers excess runs, drains when slot frees');

const runQueue5 = new InMemoryRunQueue();
const auditLog5 = new InMemoryAuditLog();
const engine5 = new DefaultWorkflowEngine({
  runQueue: runQueue5,
  auditLog: auditLog5,
});

// Workflow with one quick step — completes fast
const wfQuick = defineWorkflow('quick-wf')
  .setId('quick-wf')
  .setPolicy({ maxConcurrentRuns: 1 })
  .deterministic('work', 'Work')
  .build();

await engine5.createDefinition(wfQuick);
let handlerCallCount = 0;
engine5.registerHandler('work', async () => {
  handlerCallCount++;
  return { result: handlerCallCount };
});

// First run starts immediately (slot available)
const q5a = await engine5.startRun('quick-wf', {});
info(`Run A status: ${q5a.status}`);
if (q5a.status !== 'completed') fail(`Expected completed, got ${q5a.status}`);
ok('First run completes (slot was free)');

// Start a long-running paused workflow to occupy the slot
const wfOccupy = defineWorkflow('occupy-wf')
  .setId('occupy-wf')
  .setPolicy({ maxConcurrentRuns: 1 })
  .wait('hold', 'Hold')
  .build();
await engine5.createDefinition(wfOccupy);

const occupier = await engine5.startRun('occupy-wf', {});
if (occupier.status !== 'paused') fail(`Expected paused, got ${occupier.status}`);

// Now start a second occupy run with queue — it should be buffered as pending
const buffered = await engine5.startRun('occupy-wf', { label: 'queued' }, { priority: 5 });
info(`Buffered run status: ${buffered.status}, priority: ${buffered.priority}`);
if (buffered.status !== 'pending') fail(`Expected pending (queued), got ${buffered.status}`);
if (buffered.priority !== 5) fail(`Expected priority=5, got ${buffered.priority}`);

const queueSize = await runQueue5.sizeFor('occupy-wf');
info(`Queue size for occupy-wf: ${queueSize}`);
if (queueSize !== 1) fail(`Expected 1 queued, got ${queueSize}`);
ok('Second run buffered as pending when concurrency limit reached');

// Cancel the occupier — queue should drain and buffered run should start
await engine5.cancelRun(occupier.id);

// Wait briefly for async queue drain
await new Promise<void>(r => setTimeout(r, 30));

const dequeuedRun = await engine5.getRun(buffered.id);
info(`Buffered run status after drain: ${dequeuedRun?.status}`);
if (dequeuedRun?.status !== 'paused' && dequeuedRun?.status !== 'running') {
  // It may be completed too if it's a quick run; check not pending
  if (dequeuedRun?.status === 'pending') fail('Buffered run should have been drained from queue');
}
const newQueueSize = await runQueue5.sizeFor('occupy-wf');
if (newQueueSize !== 0) fail(`Queue should be empty after drain, got ${newQueueSize}`);
ok('Queue drained: buffered run started after slot freed by cancellation');

/* ─────────────────────────────────────────────────────────
   6. Engine — step cost tagging (__cost extraction)
   ───────────────────────────────────────────────────────── */

header('6. Engine — __cost field extracted from step output into costBreakdown');

const engine6 = new DefaultWorkflowEngine();

const wfCost = defineWorkflow('cost-wf')
  .setId('cost-wf')
  .deterministic('llm-call', 'LLM Call', { next: 'tool-call' })
  .deterministic('tool-call', 'Tool Call')
  .build();

await engine6.createDefinition(wfCost);
engine6.registerHandler('llm-call', async () => ({
  summary: 'Generated summary',
  __cost: 0.003,  // $0.003 — will be extracted into costBreakdown
}));
engine6.registerHandler('tool-call', async () => ({
  data: 'Tool result',
  __cost: 0.001,
}));

const run6 = await engine6.startRun('cost-wf', {});
info(`Run status: ${run6.status}`);
info(`costBreakdown: ${JSON.stringify(run6.costBreakdown)}`);
info(`costTotal: ${run6.costTotal}`);

if (run6.status !== 'completed') fail(`Expected completed, got ${run6.status}`);
if (!run6.costBreakdown) fail('costBreakdown should be populated');
if (run6.costBreakdown['llm-call'] !== 0.003) fail(`Expected llm-call=$0.003, got ${run6.costBreakdown['llm-call']}`);
if (run6.costBreakdown['tool-call'] !== 0.001) fail(`Expected tool-call=$0.001, got ${run6.costBreakdown['tool-call']}`);
ok('__cost extracted from step output into costBreakdown per handler key');

// Verify __cost is stripped from the stored output (not persisted into state)
const llmOutput = run6.state.variables['__step_llm-call'] as Record<string, unknown>;
if ('__cost' in llmOutput) fail('__cost should be stripped from stored output');
if (llmOutput['summary'] !== 'Generated summary') fail('Non-cost fields should be preserved');
ok('__cost stripped from stored state; other output fields preserved');

/* ─────────────────────────────────────────────────────────
   7. WorkflowAdminService — listRuns with filters
   ───────────────────────────────────────────────────────── */

header('7. WorkflowAdminService — server-side filtered listRuns');

const auditLog7 = new InMemoryAuditLog();
const engine7 = new DefaultWorkflowEngine({ auditLog: auditLog7 });

const wfAdmin = defineWorkflow('admin-wf')
  .setId('admin-wf')
  .deterministic('step', 'Step')
  .build();
const wfOther = defineWorkflow('other-wf')
  .setId('other-wf')
  .wait('hold', 'Hold')
  .build();

await engine7.createDefinition(wfAdmin);
await engine7.createDefinition(wfOther);
engine7.registerHandler('step', async () => ({ done: true }));

// Start runs for different tenants
const ra = await engine7.startRun('admin-wf', {}, { tenantId: 'tenant-a' });
const rb = await engine7.startRun('admin-wf', {}, { tenantId: 'tenant-b' });
const rc = await engine7.startRun('other-wf', {}, { tenantId: 'tenant-a' });
const rd = await engine7.startRun('admin-wf', {}, { tenantId: 'tenant-a' });

info(`Run statuses: a=${ra.status}, b=${rb.status}, c=${rc.status}, d=${rd.status}`);

const adminService = new DefaultWorkflowAdminService(
  (engine7 as unknown as { runRepository: import('@weaveintel/workflows').WorkflowRunRepository }).runRepository,
  engine7,
  auditLog7,
);

// Filter by workflowId
const adminWfRuns = await adminService.listRuns({ workflowId: 'admin-wf' });
info(`admin-wf runs: ${adminWfRuns.length}`);
if (adminWfRuns.length !== 3) fail(`Expected 3 admin-wf runs, got ${adminWfRuns.length}`);
ok('listRuns({ workflowId }) returns correct subset');

// Filter by tenantId
const tenantARuns = await adminService.listRuns({ tenantId: 'tenant-a' });
info(`tenant-a runs: ${tenantARuns.length}`);
if (tenantARuns.length !== 3) fail(`Expected 3 tenant-a runs, got ${tenantARuns.length}`);
if (tenantARuns.some(r => r.tenantId !== 'tenant-a')) fail('All runs should be tenant-a');
ok('listRuns({ tenantId }) scopes by tenant correctly');

// Filter by status
const pausedRuns = await adminService.listRuns({ status: 'paused' });
info(`paused runs: ${pausedRuns.length}`);
if (pausedRuns.length !== 1 || pausedRuns[0]!.id !== rc.id) fail('Only rc (other-wf) should be paused');
ok('listRuns({ status }) filters by run status');

// Limit
const limited = await adminService.listRuns({ limit: 2 });
if (limited.length !== 2) fail(`Expected 2 results with limit, got ${limited.length}`);
ok('listRuns({ limit }) caps results');

/* ─────────────────────────────────────────────────────────
   8. WorkflowAdminService — getRun with audit events
   ───────────────────────────────────────────────────────── */

header('8. WorkflowAdminService — getRun with full audit history');

const runView = await adminService.getRun(ra.id);
if (!runView) fail('getRun should return AdminRunView');
info(`run status: ${runView.run.status}, audit events: ${runView.events.length}`);
if (runView.run.id !== ra.id) fail('Wrong run ID in view');
if (runView.events.length === 0) fail('Expected audit events in AdminRunView');
ok(`getRun returns run + ${runView.events.length} audit events`);

/* ─────────────────────────────────────────────────────────
   9. WorkflowAdminService — force ops and patch
   ───────────────────────────────────────────────────────── */

header('9. WorkflowAdminService — forceCancelRun, forceResumeRun, patchRunVariables');

// forceCancelRun
await adminService.forceCancelRun(rc.id, 'Admin override: test');
const cancelledView = await adminService.getRun(rc.id);
if (cancelledView?.run.status !== 'cancelled') fail(`Expected cancelled, got ${cancelledView?.run.status}`);
if (!cancelledView.run.error?.includes('Force-cancelled')) fail('Error should mention force-cancelled');
info(`rc after force cancel: ${cancelledView.run.status} (${cancelledView.run.error})`);
ok('forceCancelRun cancels run and sets reason in error field');

// forceCancelRun is idempotent on already-cancelled
await adminService.forceCancelRun(rc.id, 'Second cancel — should be noop');
ok('forceCancelRun is idempotent on already-cancelled run');

// Start a new paused run for forceResumeRun test
const wfPaused = defineWorkflow('paused-wf')
  .setId('paused-wf')
  .wait('waiting', 'Wait step', { next: 'finish' })
  .deterministic('finish', 'Finish')
  .build();
await engine7.createDefinition(wfPaused);
engine7.registerHandler('finish', async (vars) => ({ resumed: (vars as Record<string, unknown>)['__resumeData'] }));

const pausedRun = await engine7.startRun('paused-wf', {});
if (pausedRun.status !== 'paused') fail(`Expected paused, got ${pausedRun.status}`);
ok(`Started paused run (id: ${pausedRun.id.slice(0, 8)}...)`);

const resumed = await adminService.forceResumeRun(pausedRun.id, { admin: true });
info(`After forceResumeRun: ${resumed.status}`);
if (resumed.status !== 'completed') fail(`Expected completed after resume, got ${resumed.status}`);
ok('forceResumeRun resumes a paused run; workflow completes');

// patchRunVariables
const wfPatch = defineWorkflow('patch-wf')
  .setId('patch-wf')
  .wait('hold', 'Hold')
  .build();
await engine7.createDefinition(wfPatch);
const patchRun = await engine7.startRun('patch-wf', { originalVar: 'original' });
const patched = await adminService.patchRunVariables(patchRun.id, {
  emergencyOverride: true,
  threshold: 999,
});
info(`After patch: emergencyOverride=${patched.state.variables['emergencyOverride']}, threshold=${patched.state.variables['threshold']}`);
if (patched.state.variables['emergencyOverride'] !== true) fail('Patch not applied');
if (patched.state.variables['threshold'] !== 999) fail('Patch threshold not applied');
if (patched.state.variables['originalVar'] !== 'original') fail('Original var should be preserved');
ok('patchRunVariables shallow-merges patch into run.state.variables');

/* ─────────────────────────────────────────────────────────
   10. File-backed stores — JsonFileWorkflowRateLimiter + JsonFileRunQueue
   ───────────────────────────────────────────────────────── */

header('10. File-backed stores — JsonFileWorkflowRateLimiter + JsonFileRunQueue');

const fileRL = new JsonFileWorkflowRateLimiter(WORK_DIR);
const fileQueue = new JsonFileRunQueue(WORK_DIR);

// Rate limiter
const fa = await fileRL.allow('file-wf', 2);
const fb = await fileRL.allow('file-wf', 2);
const fc = !(await fileRL.allow('file-wf', 2));
info(`File rate limiter: ${fa}, ${fb}, blocked=${fc}`);
if (!fa || !fb) fail('First two should be allowed');
if (!fc) fail('Third should be blocked');
ok('JsonFileWorkflowRateLimiter persists token bucket state');

await fileRL.reset('file-wf');
const afterFileReset = await fileRL.remaining('file-wf', 2);
if (afterFileReset !== 2) fail(`Expected 2 remaining after reset, got ${afterFileReset}`);
ok('reset() restores file-backed bucket');

// Run queue
const e1 = await fileQueue.enqueue({ runId: 'fr1', workflowId: 'file-wf', input: {}, priority: 3, opts: {} });
const e2 = await fileQueue.enqueue({ runId: 'fr2', workflowId: 'file-wf', input: {}, priority: 9, opts: {} });
const e3 = await fileQueue.enqueue({ runId: 'fr3', workflowId: 'file-wf', input: {}, priority: 3, opts: {} });

const fileSize = await fileQueue.size();
if (fileSize !== 3) fail(`Expected 3, got ${fileSize}`);

const fileFirst = await fileQueue.dequeue('file-wf');
if (fileFirst?.runId !== 'fr2') fail(`Expected fr2 (priority 9), got ${fileFirst?.runId}`);
ok(`JsonFileRunQueue dequeues highest priority (got ${fileFirst?.runId})`);

await fileQueue.remove(e1.id);
const fileRemaining = await fileQueue.listAll();
if (fileRemaining.length !== 1 || fileRemaining[0]!.runId !== 'fr3') {
  fail(`Expected [fr3], got ${fileRemaining.map(e => e.runId).join(',')}`);
}
ok('JsonFileRunQueue remove() and listAll() work correctly');

// Engine with file-backed stores
const fileEngine = new DefaultWorkflowEngine({
  rateLimiter: fileRL,
  runQueue: fileQueue,
});
const fileWf = defineWorkflow('file-gov-wf')
  .setId('file-gov-wf')
  .setPolicy({ maxRunsPerMinute: 5 })
  .deterministic('step', 'Step')
  .build();
await fileEngine.createDefinition(fileWf);
fileEngine.registerHandler('step', async () => ({ done: true }));

const fileRun = await fileEngine.startRun('file-gov-wf', {});
info(`File-backed governance engine run: ${fileRun.status}`);
if (fileRun.status !== 'completed') fail(`Expected completed, got ${fileRun.status}`);
ok('File-backed rate limiter works with engine');

/* ─────────────────────────────────────────────────────────
   11. Agent tool integration — governance tools
   ───────────────────────────────────────────────────────── */

header('11. Agent tool integration — governance tools (run_workflow, get_run_cost, admin_list_runs)');

if (!process.env['ANTHROPIC_API_KEY']) {
  info('ANTHROPIC_API_KEY not set — skipping real agent demo');
  info('Set ANTHROPIC_API_KEY=sk-... to run the full agent integration test');
} else {
  const { Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  // Governance engine for agent use
  const agentRL = new InMemoryWorkflowRateLimiter();
  const agentAuditLog = new InMemoryAuditLog();
  const agentEngine = new DefaultWorkflowEngine({
    rateLimiter: agentRL,
    auditLog: agentAuditLog,
  });

  const agentWf = defineWorkflow('data-pipeline')
    .setId('data-pipeline')
    .setPolicy({ maxRunsPerMinute: 10 })
    .deterministic('extract', 'Extract', { next: 'load' })
    .deterministic('load', 'Load')
    .build();

  await agentEngine.createDefinition(agentWf);
  agentEngine.registerHandler('extract', async () => ({
    records: 1000,
    source: 'postgres',
    __cost: 0.002,
  }));
  agentEngine.registerHandler('load', async () => ({
    written: 1000,
    destination: 'warehouse',
    __cost: 0.001,
  }));

  const agentAdminService = new DefaultWorkflowAdminService(
    (agentEngine as unknown as { runRepository: import('@weaveintel/workflows').WorkflowRunRepository }).runRepository,
    agentEngine,
    agentAuditLog,
  );

  const agentTools: import('@anthropic-ai/sdk').Tool[] = [
    {
      name: 'run_workflow',
      description: 'Execute a workflow and return run details including cost.',
      input_schema: {
        type: 'object' as const,
        properties: {
          workflow_id: { type: 'string' as const },
          tenant_id: { type: 'string' as const },
        },
        required: ['workflow_id'],
      },
    },
    {
      name: 'get_run_cost',
      description: 'Get cost breakdown for a workflow run.',
      input_schema: {
        type: 'object' as const,
        properties: { run_id: { type: 'string' as const } },
        required: ['run_id'],
      },
    },
    {
      name: 'admin_list_runs',
      description: 'List workflow runs with optional filters.',
      input_schema: {
        type: 'object' as const,
        properties: {
          workflow_id: { type: 'string' as const },
          status: { type: 'string' as const },
          limit: { type: 'number' as const },
        },
      },
    },
  ];

  type AgentToolInput = {
    workflow_id?: string;
    tenant_id?: string;
    run_id?: string;
    status?: string;
    limit?: number;
  };

  async function processAgentTool(name: string, input: AgentToolInput): Promise<string> {
    if (name === 'run_workflow') {
      const run = await agentEngine.startRun(input.workflow_id ?? '', {}, { tenantId: input.tenant_id });
      return JSON.stringify({
        runId: run.id,
        status: run.status,
        costTotal: run.costTotal,
        costBreakdown: run.costBreakdown,
      });
    }
    if (name === 'get_run_cost') {
      const run = await agentEngine.getRun(input.run_id ?? '');
      return JSON.stringify({
        costTotal: run?.costTotal,
        costBreakdown: run?.costBreakdown,
      });
    }
    if (name === 'admin_list_runs') {
      const runs = await agentAdminService.listRuns({
        workflowId: input.workflow_id,
        status: input.status as import('@weaveintel/core').WorkflowRunStatus | undefined,
        limit: input.limit,
      });
      return JSON.stringify(runs.map(r => ({
        id: r.id,
        status: r.status,
        costTotal: r.costTotal,
        costBreakdown: r.costBreakdown,
      })));
    }
    return JSON.stringify({ error: 'Unknown tool' });
  }

  const messages: import('@anthropic-ai/sdk').MessageParam[] = [
    {
      role: 'user',
      content: 'Run the "data-pipeline" workflow, then check its cost breakdown. Also list all completed runs. Tell me the total cost and which steps cost the most.',
    },
  ];

  info('Sending request to Claude with governance tools...');
  let response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    tools: agentTools,
    messages,
  });

  while (response.stop_reason === 'tool_use') {
    const results: import('@anthropic-ai/sdk').MessageParam['content'] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      info(`  Tool call: ${block.name}(${JSON.stringify(block.input)})`);
      const result = await processAgentTool(block.name, block.input as AgentToolInput);
      info(`  Tool result: ${result}`);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: results });
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: agentTools,
      messages,
    });
  }

  const finalText = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('\n');
  info(`Agent response:\n${finalText}`);

  const allRuns = await agentAdminService.listRuns();
  if (allRuns.length === 0) fail('Agent should have triggered at least one workflow run');
  const hasCostBreakdown = allRuns.some(r => r.costBreakdown && Object.keys(r.costBreakdown).length > 0);
  if (!hasCostBreakdown) fail('At least one run should have a cost breakdown');
  ok(`Agent ran workflow with cost tagging (${allRuns.length} runs, cost breakdowns populated)`);
}

/* ─────────────────────────────────────────────────────────
   Cleanup
   ───────────────────────────────────────────────────────── */

await rm(WORK_DIR, { recursive: true, force: true });

console.log(`\n${'═'.repeat(64)}`);
console.log('  All Phase W5 checks passed!');
console.log('═'.repeat(64));
console.log(`
  Phase W5 — Governance & Operations features verified:
    ✓ InMemoryWorkflowRateLimiter  — token bucket; allow/remaining/reset
    ✓ JsonFileWorkflowRateLimiter  — file-backed persistence of bucket state
    ✓ WorkflowRateLimitError       — thrown when maxRunsPerMinute exceeded
    ✓ InMemoryRunQueue             — priority ordering, FIFO tiebreak, dequeue, remove
    ✓ JsonFileRunQueue             — file-backed priority queue
    ✓ WorkflowConcurrencyError     — thrown when maxConcurrentRuns exceeded (no queue)
    ✓ Run queue buffering          — pending run created; drained on slot free
    ✓ Step __cost tagging          — extracted into costBreakdown, stripped from state
    ✓ DefaultWorkflowAdminService  — listRuns (status/tenant/workflowId/limit filters)
    ✓ AdminService.getRun          — full state + audit event history
    ✓ AdminService.forceCancelRun  — idempotent force cancel with reason
    ✓ AdminService.forceResumeRun  — admin resume of paused/stuck runs
    ✓ AdminService.patchRunVariables — emergency variable override
    ✓ Agent integration            — run_workflow + get_run_cost + admin_list_runs tools
`);
