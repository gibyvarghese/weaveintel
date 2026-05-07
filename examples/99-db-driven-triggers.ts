/**
 * Example 99 — Unified Triggers (Phase 3 of the DB-driven Capability Plan)
 *
 * Demonstrates `@weaveintel/triggers` end-to-end with no DB and no LLM:
 *   - manual + cron source adapters
 *   - webhook_out + callback target adapters
 *   - JSONLogic-lite filter expression
 *   - dotted-path inputMap projection
 *   - per-trigger rate limiting
 *   - in-memory invocation audit ledger
 */
import {
  createTriggerDispatcher,
  InMemoryTriggerStore,
  ManualSourceAdapter,
  WebhookOutTargetAdapter,
  CallbackTargetAdapter,
  type Trigger,
} from '@weaveintel/triggers';

async function main() {
  const store = new InMemoryTriggerStore();
  const manual = new ManualSourceAdapter();

  // Stub workflow target — pretend this kicks a workflow run.
  const workflowAdapter = new CallbackTargetAdapter('workflow', async (target, input) => {
    console.log('[workflow]', target.config['workflowDefId'], 'input=', JSON.stringify(input));
    return { ref: `wf-run-${Date.now()}` };
  });

  const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
    console.log('[webhook_out] POST', url, init?.body);
    return new Response('', { status: 202 });
  }) as typeof fetch;

  const dispatcher = createTriggerDispatcher({
    store,
    sourceAdapters: [manual],
    targetAdapters: [
      workflowAdapter,
      new WebhookOutTargetAdapter({ fetchImpl }),
    ],
  });

  // Seed two triggers.
  const t1: Trigger = {
    id: 't-1',
    key: 'on-high-priority-event',
    enabled: true,
    source: { kind: 'manual', config: {} },
    filter: { expression: { '==': [{ var: 'payload.priority' }, 'high'] } },
    target: { kind: 'workflow', config: { workflowDefId: 'wf-incident-triage' } },
    inputMap: { reason: 'payload.reason', userId: 'payload.meta.userId' },
    rateLimit: { perMinute: 5 },
  };
  const t2: Trigger = {
    id: 't-2',
    key: 'periodic-heartbeat',
    enabled: true,
    source: { kind: 'cron', config: { intervalMs: 60_000 } },
    target: { kind: 'webhook_out', config: { url: 'https://example.test/heartbeat' } },
  };
  await store.save(t1);
  await store.save(t2);

  await dispatcher.start();
  await dispatcher.reload();

  // (a) Filter passes → dispatched
  console.log('\n--- (a) priority=high (passes filter) ---');
  const passResult = await dispatcher.dispatch({
    sourceKind: 'manual',
    payload: { priority: 'high', reason: 'pager', meta: { userId: 'u-42' } },
    observedAt: Date.now(),
  });
  console.log('result:', passResult.map((r) => ({ status: r.status, ref: r.targetRef })));

  // (b) Filter fails → filtered (audited but not dispatched)
  console.log('\n--- (b) priority=low (fails filter) ---');
  const failResult = await dispatcher.dispatch({
    sourceKind: 'manual',
    payload: { priority: 'low', reason: 'noisy' },
    observedAt: Date.now(),
  });
  console.log('result:', failResult.map((r) => ({ status: r.status })));

  // (c) Audit log
  console.log('\n--- (c) audit ledger ---');
  const invocations = await store.listInvocations({});
  for (const inv of invocations) {
    console.log(`  [${inv.status}] trig=${inv.triggerId} src=${inv.sourceKind} ref=${inv.targetRef ?? '-'}`);
  }

  await dispatcher.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });
