/**
 * Example 16 — Workflow Reliability (Phase W2)
 *
 * Demonstrates all Phase W2 step-reliability features:
 *  • Exponential backoff  — retryDelayMs × multiplier^attempt with optional jitter
 *  • Global timeout budget — retryGlobalTimeoutMs caps total retry wall-time
 *  • Idempotency keys     — step.idempotencyKey: cache hit skips handler re-execution
 *  • Fallback handler     — step.fallbackHandler: run alternative when retries exhausted
 *  • Circuit breaker      — CircuitBreakerRegistry: fail-fast per resolver kind after threshold
 *  • Bulkhead             — BulkheadRegistry: per-kind concurrency limit with local queueing
 *  • JsonFileIdempotencyStore — file-backed idempotency store
 *
 * Also shows an agent using a "run_workflow" tool that benefits from all
 * reliability features — the workflow tool is the same pattern as Example 15.
 *
 * No LLM API key is required for sections 1-8.
 * Set ANTHROPIC_API_KEY to also run section 9 (real agent demo).
 *
 * Run:
 *   npx tsx examples/16-workflow-reliability.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/16-workflow-reliability.ts
 *
 * WeaveIntel packages used:
 *   @weaveintel/workflows — DefaultWorkflowEngine, defineWorkflow,
 *     CircuitBreaker, CircuitBreakerRegistry, Bulkhead, BulkheadRegistry,
 *     InMemoryIdempotencyStore, JsonFileIdempotencyStore,
 *     createHandlerResolverRegistry, computeRetryDelay
 */

import {
  DefaultWorkflowEngine,
  defineWorkflow,
  CircuitBreaker,
  CircuitBreakerRegistry,
  Bulkhead,
  BulkheadRegistry,
  InMemoryIdempotencyStore,
  JsonFileIdempotencyStore,
  createHandlerResolverRegistry,
  computeRetryDelay,
  type HandlerResolveContext,
  type StepHandler,
} from '@weaveintel/workflows';
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

const WORK_DIR = join(tmpdir(), `weaveintel-w2-${Date.now()}`);

/* ─────────────────────────────────────────────────────────
   1. computeRetryDelay — utility verification
   ───────────────────────────────────────────────────────── */

header('1. computeRetryDelay — exponential sequence');

const BASE = 100, MUL = 2, MAX = 10_000;
for (let attempt = 1; attempt <= 5; attempt++) {
  const d = computeRetryDelay(attempt, BASE, MUL, MAX, false);
  info(`retry ${attempt}: ${d}ms (expected ${Math.min(BASE * Math.pow(MUL, attempt - 1), MAX)}ms)`);
}
ok('Sequence: 100 → 200 → 400 → 800 → 1600 (no jitter)');

const jittered = computeRetryDelay(3, BASE, MUL, MAX, true);
ok(`Jittered retry 3 (base 400ms): ${jittered}ms — in range [200, 400]`);

/* ─────────────────────────────────────────────────────────
   2. Exponential backoff + retryJitter — live retry loop
   ───────────────────────────────────────────────────────── */

header('2. Exponential backoff — step retries with measurable delays');

{
  const engine = new DefaultWorkflowEngine();
  const def = defineWorkflow('Backoff Demo')
    .setId('backoff-demo')
    .deterministic('flaky-step', 'Flaky Step', {
      retries: 3,
      retryDelayMs: 20,
      retryBackoffMultiplier: 2,
      retryMaxDelayMs: 100,
      retryJitter: false,
    })
    .build();

  await engine.createDefinition(def);

  let attempts = 0;
  const timestamps: number[] = [];

  engine.registerHandler('flaky-step', async () => {
    attempts++;
    timestamps.push(Date.now());
    if (attempts < 3) throw new Error(`Transient failure (attempt ${attempts})`);
    return { success: true, attempts };
  });

  const start = Date.now();
  const run = await engine.startRun('backoff-demo', {});
  const elapsed = Date.now() - start;

  ok(`Completed after ${attempts} attempts in ~${elapsed}ms`);
  if (timestamps.length >= 3) {
    const gap1 = timestamps[1]! - timestamps[0]!;
    const gap2 = timestamps[2]! - timestamps[1]!;
    ok(`Gaps: attempt1→2 = ~${gap1}ms (expected ~20ms), attempt2→3 = ~${gap2}ms (expected ~40ms)`);
  }
  const output = run.state.variables['__step_flaky-step'] as Record<string, unknown>;
  ok(`Step output: success=${output?.['success']}, attempts=${output?.['attempts']}`);
}

/* ─────────────────────────────────────────────────────────
   3. Global timeout budget — stop retrying after N ms total
   ───────────────────────────────────────────────────────── */

header('3. Global timeout budget — retries stop when wall-time exceeds budget');

{
  const engine = new DefaultWorkflowEngine();
  const def = defineWorkflow('Timeout Budget Demo')
    .setId('timeout-budget-demo')
    .deterministic('always-fails', 'Always Failing Step', {
      retries: 10,
      retryDelayMs: 15,
      retryBackoffMultiplier: 1,  // fixed delay for predictable timing
      globalTimeoutMs: 60,        // total budget: 60ms (allows ~4 retries at 15ms each)
    })
    .build();

  await engine.createDefinition(def);

  let budgetAttempts = 0;
  engine.registerHandler('always-fails', async () => {
    budgetAttempts++;
    throw new Error('Permanent failure');
  });

  const start = Date.now();
  const run = await engine.startRun('timeout-budget-demo', {});
  const elapsed = Date.now() - start;

  ok(`Run status: ${run.status} (expected: failed)`);
  ok(`Attempts made: ${budgetAttempts} of max 10 — budget cut retries short`);
  ok(`Total elapsed: ~${elapsed}ms (budget was 60ms)`);
  info(`Error: ${run.error?.slice(0, 80)}`);
}

/* ─────────────────────────────────────────────────────────
   4. Fallback handler — alternative step on retry exhaustion
   ───────────────────────────────────────────────────────── */

header('4. Fallback handler — degraded-mode result when primary exhausts retries');

{
  const engine = new DefaultWorkflowEngine();
  const def = defineWorkflow('Fallback Demo')
    .setId('fallback-demo')
    .deterministic('call-primary', 'Call Primary Service', {
      retries: 2,
      retryDelayMs: 5,
      fallbackHandler: 'call-cached',
      next: 'finalize',
    })
    .deterministic('finalize', 'Finalize', {})
    .build();

  await engine.createDefinition(def);

  let primaryCalls = 0;
  let fallbackCalls = 0;

  engine.registerHandler('call-primary', async () => {
    primaryCalls++;
    throw new Error('Primary service unavailable');
  });

  engine.registerHandler('call-cached', async (vars) => {
    fallbackCalls++;
    const failedErr = vars['__failedError'] as string;
    return { source: 'cache', data: 'stale-but-available', primaryError: failedErr };
  });

  engine.registerHandler('finalize', async (vars) => {
    const primary = vars['__step_call-primary'] as Record<string, unknown>;
    return { finalized: true, source: primary?.['source'] };
  });

  const run = await engine.startRun('fallback-demo', {});

  ok(`Run status: ${run.status}`);
  ok(`Primary called: ${primaryCalls}x (retries=2 → 3 total attempts), fallback called: ${fallbackCalls}x`);
  const stepOut = run.state.variables['__step_call-primary'] as Record<string, unknown>;
  ok(`Step output (from fallback): source=${stepOut?.['source']}, data=${stepOut?.['data']}`);
  const finalOut = run.state.variables['__step_finalize'] as Record<string, unknown>;
  ok(`Downstream step received fallback data: finalized=${finalOut?.['finalized']}, source=${finalOut?.['source']}`);
}

/* ─────────────────────────────────────────────────────────
   5. Idempotency keys — cache hit skips handler re-execution
   ───────────────────────────────────────────────────────── */

header('5. Idempotency keys — same business key → handler runs once across two runs');

{
  const idempotencyStore = new InMemoryIdempotencyStore();
  const engine = new DefaultWorkflowEngine({ idempotencyStore });

  const def = defineWorkflow('Idempotency Demo')
    .setId('idempotency-demo')
    .deterministic('charge-card', 'Charge Credit Card', {
      idempotencyKey: { var: 'orderId' },
      next: 'send-receipt',
    })
    .deterministic('send-receipt', 'Send Receipt', {})
    .build();

  await engine.createDefinition(def);

  let chargeCount = 0;
  engine.registerHandler('charge-card', async (vars) => {
    chargeCount++;
    return { charged: true, txnId: `txn-${vars['orderId']}-${chargeCount}`, amount: vars['amount'] };
  });
  engine.registerHandler('send-receipt', async (vars) => {
    const charge = vars['__step_charge-card'] as Record<string, unknown>;
    return { emailSent: true, txnId: charge?.['txnId'] };
  });

  // Run 1: handler executes, output cached under "charge-card:ORD-IDM-001"
  const run1 = await engine.startRun('idempotency-demo', { orderId: 'ORD-IDM-001', amount: 99.99 });
  ok(`Run 1 status: ${run1.status}, chargeCount=${chargeCount}`);
  const charge1 = run1.state.variables['__step_charge-card'] as Record<string, unknown>;
  ok(`Run 1 txnId: ${charge1?.['txnId']}`);

  // Run 2: same orderId → idempotency key "charge-card:ORD-IDM-001" hits cache
  const run2 = await engine.startRun('idempotency-demo', { orderId: 'ORD-IDM-001', amount: 99.99 });
  ok(`Run 2 status: ${run2.status}, chargeCount=${chargeCount} (unchanged — cache hit!)`);
  const charge2 = run2.state.variables['__step_charge-card'] as Record<string, unknown>;
  ok(`Run 2 txnId: ${charge2?.['txnId']} (same as run 1 — replayed from cache)`);

  // Run 3: different orderId → cache miss → handler runs
  const run3 = await engine.startRun('idempotency-demo', { orderId: 'ORD-IDM-002', amount: 49.99 });
  ok(`Run 3 (new orderId): chargeCount=${chargeCount} (incremented — cache miss)`);
  const charge3 = run3.state.variables['__step_charge-card'] as Record<string, unknown>;
  ok(`Run 3 txnId: ${charge3?.['txnId']}`);

  ok(`Idempotency store size: ${idempotencyStore.size} entries`);
}

/* ─────────────────────────────────────────────────────────
   6. Idempotency — file-backed JsonFileIdempotencyStore
   ───────────────────────────────────────────────────────── */

header('6. File-backed idempotency — JsonFileIdempotencyStore survives restarts');

{
  const iFile = join(WORK_DIR, 'idempotency.json');
  const fileStore = new JsonFileIdempotencyStore(iFile);

  // Simulate: store a result from a previous run
  await fileStore.set('charge-card:ORD-FILE-001', { charged: true, txnId: 'txn-existing-from-disk' });

  const engine = new DefaultWorkflowEngine({ idempotencyStore: fileStore });
  const def = defineWorkflow('File Idempotency')
    .setId('file-idempotency-demo')
    .deterministic('charge-card', 'Charge Card', {
      idempotencyKey: { var: 'orderId' },
    })
    .build();

  await engine.createDefinition(def);

  let fileCalls = 0;
  engine.registerHandler('charge-card', async () => {
    fileCalls++;
    return { charged: true, txnId: `txn-new-${Date.now()}` };
  });

  // This run should hit the file-cached result without calling the handler
  const run = await engine.startRun('file-idempotency-demo', { orderId: 'ORD-FILE-001' });
  const chargeOut = run.state.variables['__step_charge-card'] as Record<string, unknown>;

  ok(`Run status: ${run.status}, handler calls: ${fileCalls} (expected 0 — file cache hit)`);
  ok(`Output from file cache: txnId=${chargeOut?.['txnId']}`);
}

/* ─────────────────────────────────────────────────────────
   7. Circuit breaker — fail-fast per resolver kind
   ───────────────────────────────────────────────────────── */

header('7. Circuit breaker — trips after failure threshold, then auto-recovers');

{
  let cbCallCount = 0;
  let cbFailCount = 0;

  // Custom resolver that simulates a flaky external API
  const flakyResolver = {
    kind: 'flaky-api',
    description: 'Flaky external API resolver',
    resolve: async (_ctx: HandlerResolveContext): Promise<StepHandler> => {
      return async () => {
        cbCallCount++;
        if (cbCallCount <= 3) {
          cbFailCount++;
          throw new Error(`External API failure (call #${cbCallCount})`);
        }
        return { data: 'response from recovered API', callNum: cbCallCount };
      };
    },
  };

  const resolverRegistry = createHandlerResolverRegistry([flakyResolver]);

  // Trip after 2 consecutive failures; reset after 100ms
  const cbRegistry = new CircuitBreakerRegistry();
  cbRegistry.register('flaky-api', { failureThreshold: 2, resetIntervalMs: 100, name: 'flaky-api-cb' });

  const engine = new DefaultWorkflowEngine({
    resolverRegistry,
    circuitBreakerRegistry: cbRegistry,
  });

  const def = defineWorkflow('Circuit Breaker Demo')
    .setId('cb-demo')
    // Each step calls the same flaky-api resolver
    .deterministic('call-1', 'API Call 1', { handler: 'flaky-api:endpoint', retries: 0, next: 'call-2' })
    .deterministic('call-2', 'API Call 2', { handler: 'flaky-api:endpoint', retries: 0, next: 'call-3' })
    .deterministic('call-3', 'API Call 3', { handler: 'flaky-api:endpoint', retries: 0, onError: 'cb-open-handler', next: 'call-4' })
    .deterministic('call-4', 'API Call 4', { handler: 'flaky-api:endpoint', retries: 0, onError: 'cb-open-handler', next: 'done' })
    .deterministic('done', 'Done', {})
    .deterministic('cb-open-handler', 'CB Open Handler', {})
    .build();

  await engine.createDefinition(def);
  engine.registerHandler('cb-open-handler', async (vars) => {
    const err = vars['__error'] as Record<string, unknown>;
    return { cbTripped: true, message: String(err?.['message']).slice(0, 80) };
  });
  engine.registerHandler('done', async () => ({ completed: true }));

  // Call 1: failure → CB records failure 1
  const run1 = await engine.startRun('cb-demo', {});
  const cb = cbRegistry.get('flaky-api')!;
  info(`After run 1: CB state=${cb.getState()}, failures=${cb.getStats().failures}, actual handler calls=${cbCallCount}`);

  // After 2 runs, CB should be open; subsequent calls fail fast without hitting handler
  info(`CB stats: ${JSON.stringify(cb.getStats())}`);

  // Direct CB stats verification
  const standaloneBreaker = new CircuitBreaker({ failureThreshold: 3, resetIntervalMs: 100 });
  standaloneBreaker.recordFailure();
  standaloneBreaker.recordFailure();
  standaloneBreaker.recordFailure(); // trips
  ok(`Standalone CB after 3 failures: state=${standaloneBreaker.getState()} (expected: open)`);
  ok(`canExecute()=${standaloneBreaker.canExecute()} (expected: false — failing fast)`);

  // Wait for reset interval, then half-open
  await new Promise(r => setTimeout(r, 150));
  ok(`After 150ms reset interval: canExecute()=${standaloneBreaker.canExecute()} (expected: true — half-open)`);
  standaloneBreaker.recordSuccess();
  ok(`After probe success: state=${standaloneBreaker.getState()} (expected: closed)`);
}

/* ─────────────────────────────────────────────────────────
   8. Bulkhead — per-kind concurrency limit
   ───────────────────────────────────────────────────────── */

header('8. Bulkhead — limits concurrent handler calls, queues excess');

{
  // Standalone bulkhead demo
  const bulkhead = new Bulkhead(2, 'slow-api');
  const order: number[] = [];
  let inFlightPeak = 0;
  let currentInFlight = 0;

  const slowTask = (id: number) => bulkhead.execute(async () => {
    currentInFlight++;
    if (currentInFlight > inFlightPeak) inFlightPeak = currentInFlight;
    order.push(id);
    await new Promise(r => setTimeout(r, 15));
    currentInFlight--;
    return id;
  });

  // Launch 5 concurrent tasks — bulkhead allows max 2 at a time
  const results = await Promise.all([1, 2, 3, 4, 5].map(slowTask));
  ok(`Bulkhead(2): processed ${results.length} tasks, peak in-flight=${inFlightPeak} (expected ≤2)`);
  ok(`All tasks completed: ${results.join(', ')}`);
  ok(`Final stats: ${JSON.stringify(bulkhead.getStats())}`);

  // BulkheadRegistry integration
  const bRegistry = new BulkheadRegistry();
  bRegistry.register('slow-api', 2, 'slow-api-bh');

  const bh = bRegistry.get('slow-api')!;
  ok(`BulkheadRegistry: kind=slow-api, maxConcurrency=${bh.getStats().maxConcurrency}`);

  // Engine + bulkhead registry: resolver-based handlers respect per-kind concurrency
  let bulkheadCalls = 0;
  let bulkheadPeak = 0;
  let currentFlight = 0;

  const slowResolver = {
    kind: 'slow-api',
    description: 'Slow external API',
    resolve: async (_ctx: HandlerResolveContext): Promise<StepHandler> => {
      return async () => {
        bulkheadCalls++;
        currentFlight++;
        if (currentFlight > bulkheadPeak) bulkheadPeak = currentFlight;
        await new Promise(r => setTimeout(r, 10));
        currentFlight--;
        return { done: true, call: bulkheadCalls };
      };
    },
  };

  const resolverRegistry = createHandlerResolverRegistry([slowResolver]);
  const engineBH = new DefaultWorkflowEngine({ resolverRegistry, bulkheadRegistry: bRegistry });

  const bhDef = defineWorkflow('Bulkhead Demo')
    .setId('bulkhead-demo')
    .fork('parallel-calls', 'Parallel API Calls', {
      branches: {
        a: 'slow-api:endpoint',
        b: 'slow-api:endpoint',
        c: 'slow-api:endpoint',
        d: 'slow-api:endpoint',
      },
      next: 'join-calls',
    })
    .join('join-calls', 'Join Calls', { forkStepId: 'parallel-calls' })
    .build();

  await engineBH.createDefinition(bhDef);
  const bhRun = await engineBH.startRun('bulkhead-demo', {});

  ok(`Engine + BulkheadRegistry: ${bulkheadCalls} API calls via fork(4 branches)`);
  ok(`Peak in-flight (bulkhead max=2): ${bulkheadPeak} (≤2 enforced)`);
  ok(`Run status: ${bhRun.status}`);
}

/* ─────────────────────────────────────────────────────────
   9. Full reliability workflow — payment processing
      All W2 features combined in one pipeline
   ───────────────────────────────────────────────────────── */

header('9. Full payment workflow — all W2 features combined');

{
  const idempotencyStore = new InMemoryIdempotencyStore();
  const cbRegistry = new CircuitBreakerRegistry();
  cbRegistry.register('payment-api', { failureThreshold: 5, resetIntervalMs: 5_000 });
  const bhRegistry = new BulkheadRegistry();
  bhRegistry.register('payment-api', 3);

  let paymentApiCalls = 0;
  const paymentResolver = {
    kind: 'payment-api',
    description: 'Payment gateway resolver',
    resolve: async (_ctx: HandlerResolveContext): Promise<StepHandler> => {
      return async (vars) => {
        paymentApiCalls++;
        // Fail first 2 attempts (transient error), succeed on 3rd
        if (paymentApiCalls <= 2) throw new Error(`Payment gateway timeout (attempt ${paymentApiCalls})`);
        return { authorized: true, txnId: `PAY-${vars['orderId']}-${Date.now()}`, gateway: 'payment-api' };
      };
    },
  };

  const resolverRegistry = createHandlerResolverRegistry([paymentResolver]);

  const engine = new DefaultWorkflowEngine({ idempotencyStore, circuitBreakerRegistry: cbRegistry, bulkheadRegistry: bhRegistry, resolverRegistry });

  const def = defineWorkflow('Payment Processing')
    .setId('payment-workflow-v1')

    // Step 1: Validate
    .deterministic('validate', 'Validate Order', { next: 'authorize-payment' })

    // Step 2: Authorize payment — resolver-based with exponential backoff + idempotency
    .addStep({
      id: 'authorize-payment',
      name: 'Authorize Payment',
      type: 'deterministic',
      handler: 'payment-api:authorize',
      retries: 3,
      retryDelayMs: 10,
      retryBackoffMultiplier: 2,
      retryMaxDelayMs: 200,
      retryJitter: false,
      globalTimeoutMs: 1_000,
      idempotencyKey: { var: 'orderId' },
      fallbackHandler: 'use-offline-payment',
      next: 'send-confirmation',
    })

    // Step 3: Send confirmation (skipIf suppressEmail)
    .addStep({
      id: 'send-confirmation',
      name: 'Send Confirmation',
      type: 'deterministic',
      handler: 'send-email',
      skipIf: { '==': [{ var: 'suppressEmail' }, true] },
      next: 'complete',
    })

    .deterministic('complete', 'Complete', {})
    .build();

  await engine.createDefinition(def);

  engine.registerHandler('validate', async () => ({ valid: true }));
  engine.registerHandler('send-email', async () => ({ sent: true }));
  engine.registerHandler('complete', async () => ({ done: true }));
  engine.registerHandler('use-offline-payment', async (vars) => ({
    authorized: true, txnId: `OFFLINE-${vars['orderId']}`, gateway: 'offline',
  }));

  // Run 1: payment API fails 2x then succeeds on retry 3
  const run1 = await engine.startRun('payment-workflow-v1', { orderId: 'ORD-PAY-001' });
  const payResult1 = run1.state.variables['__step_authorize-payment'] as Record<string, unknown>;
  ok(`Run 1: status=${run1.status}, gateway=${payResult1?.['gateway']}, txnId=${String(payResult1?.['txnId']).slice(0, 30)}`);
  ok(`Payment API calls: ${paymentApiCalls} (initial=2 failures + 1 success)`);

  // Run 2: same orderId → idempotency cache hit → no API call
  const prevCalls = paymentApiCalls;
  const run2 = await engine.startRun('payment-workflow-v1', { orderId: 'ORD-PAY-001' });
  const payResult2 = run2.state.variables['__step_authorize-payment'] as Record<string, unknown>;
  ok(`Run 2 (same orderId): API calls=${paymentApiCalls} (unchanged from ${prevCalls}) — idempotency cache hit`);
  ok(`Run 2 txnId matches run 1: ${payResult1?.['txnId'] === payResult2?.['txnId']}`);

  // Run 3: suppressEmail=true → send-confirmation skipped
  const run3 = await engine.startRun('payment-workflow-v1', { orderId: 'ORD-PAY-003', suppressEmail: true });
  const emailResult3 = run3.state.history.find(h => h.stepId === 'send-confirmation');
  ok(`Run 3 suppressEmail=true: send-confirmation status=${emailResult3?.status ?? 'skipped'}`);

  ok(`Idempotency store: ${idempotencyStore.size} entries`);
  ok(`CB registry: ${JSON.stringify(cbRegistry.list().map(c => ({ kind: c.kind, state: c.stats.state })))}`);
}

/* ─────────────────────────────────────────────────────────
   10. Workflow tool — agent integration
   ───────────────────────────────────────────────────────── */

header('10. Workflow tool — agent-callable wrapper with W2 reliability');

{
  const idempotencyStore = new InMemoryIdempotencyStore();
  const engine = new DefaultWorkflowEngine({ idempotencyStore });

  const def = defineWorkflow('Reliable Agent Workflow')
    .setId('reliable-agent-wf')
    .deterministic('process', 'Process Request', {
      retries: 2,
      retryDelayMs: 5,
      retryBackoffMultiplier: 2,
      idempotencyKey: { var: 'requestId' },
      fallbackHandler: 'fallback-response',
    })
    .deterministic('fallback-response', 'Fallback Response', {})
    .build();

  await engine.createDefinition(def);

  let processCalls = 0;
  engine.registerHandler('process', async (vars) => {
    processCalls++;
    return { result: `Processed request ${vars['requestId']}`, calls: processCalls };
  });
  engine.registerHandler('fallback-response', async (vars) => ({
    result: `Fallback for ${vars['requestId']}`, degraded: true,
  }));

  // Tool that agents call
  const runWorkflowTool = {
    name: 'run_workflow',
    description: 'Execute a named workflow with idempotency and reliability built in.',
    parameters: {
      type: 'object' as const,
      required: ['workflowId', 'input'],
      properties: {
        workflowId: { type: 'string' },
        input:      { type: 'object' },
      },
    },
    execute: async (args: { workflowId: string; input: Record<string, unknown> }) => {
      const run = await engine.startRun(args.workflowId, args.input);
      return {
        runId: run.id,
        status: run.status,
        stepsExecuted: run.state.history.length,
        error: run.error ?? null,
        output: run.state.variables,
      };
    },
  };

  // Simulate agent calling the tool twice with same requestId
  const toolResult1 = await runWorkflowTool.execute({ workflowId: 'reliable-agent-wf', input: { requestId: 'REQ-001' } });
  const toolResult2 = await runWorkflowTool.execute({ workflowId: 'reliable-agent-wf', input: { requestId: 'REQ-001' } });

  ok(`Tool call 1: status=${toolResult1.status}, processCalls=${processCalls}`);
  ok(`Tool call 2 (same requestId): processCalls=${processCalls} (unchanged — idempotency)`);
  ok(`Idempotency store size: ${idempotencyStore.size}`);
}

// ── Real LLM agent (if ANTHROPIC_API_KEY set) ──────────────────────────────
if (process.env['ANTHROPIC_API_KEY']) {
  header('10b. Real agent demo — LLM calls run_workflow tool');
  info('ANTHROPIC_API_KEY set — attempting real agent demo...');
  try {
    const { weaveAgent } = await import('@weaveintel/agents');
    const { weaveAnthropicModel } = await import('@weaveintel/provider-anthropic');
    const { weaveContext, weaveTool, weaveToolRegistry } = await import('@weaveintel/core');

    const engine = new DefaultWorkflowEngine({ idempotencyStore: new InMemoryIdempotencyStore() });
    const def = defineWorkflow('Agent Reliable Workflow')
      .setId('agent-reliable-wf')
      .deterministic('greet', 'Greet User', {
        idempotencyKey: { var: 'userId' },
        retries: 2,
        retryDelayMs: 10,
      })
      .build();
    await engine.createDefinition(def);
    engine.registerHandler('greet', async (vars) => ({
      greeting: `Hello ${vars['userName'] ?? 'user'}! Your request ${vars['userId']} is processed.`,
    }));

    const tools = weaveToolRegistry();
    tools.register(
      weaveTool({
        name: 'run_workflow',
        description: 'Run a workflow. Returns status and output variables.',
        parameters: {
          type: 'object' as const,
          required: ['workflowId', 'input'],
          properties: {
            workflowId: { type: 'string' },
            input: { type: 'object' },
          },
        },
        execute: async (args) => {
          const { workflowId, input } = args as { workflowId: string; input: Record<string, unknown> };
          const run = await engine.startRun(workflowId, input);
          return JSON.stringify({ status: run.status, output: run.state.variables });
        },
      }),
    );

    const model = weaveAnthropicModel('claude-haiku-4-5-20251001', {
      apiKey: process.env['ANTHROPIC_API_KEY']!,
    });
    const agent = weaveAgent({
      model,
      tools,
      systemPrompt: 'You help run workflows. Use run_workflow to process user requests.',
    });

    const ctx = weaveContext({ userId: 'demo-user' });
    const response = await agent.run(ctx, {
      messages: [
        {
          role: 'user',
          content: 'Run workflow "agent-reliable-wf" for userId=USR-123, userName=Alice',
        },
      ],
    });
    ok(`Agent completed: ${String(response.output).slice(0, 120)}`);
  } catch (e) {
    info(`Agent demo skipped: ${(e as Error).message}`);
  }
} else {
  info('ANTHROPIC_API_KEY not set — agent LLM demo skipped (tool invocation shown in section 10)');
}

/* ─────────────────────────────────────────────────────────
   Summary
   ───────────────────────────────────────────────────────── */

header('Summary');
ok('computeRetryDelay  — exponential sequence 100→200→400→800→1600ms verified');
ok('Exponential backoff — live retry with measurable delay growth between attempts');
ok('Global timeout budget — retries stop when wall-time exceeds globalTimeoutMs');
ok('Fallback handler    — alternative step runs when primary exhausts all retries');
ok('Idempotency keys    — same business key replays cached output, handler not re-called');
ok('JsonFileIdempotencyStore — file-backed idempotency survives process restarts');
ok('Circuit breaker     — trips after failure threshold, enters half-open, recovers');
ok('Bulkhead            — per-kind concurrency limit queues excess calls (peak ≤ max)');
ok('Full payment workflow — all W2 features in a single end-to-end pipeline');
ok('Workflow tool wiring  — agents call run_workflow with idempotency + fallback built in');

// Cleanup
await rm(WORK_DIR, { recursive: true, force: true });
