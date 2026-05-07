/**
 * Example 100 — Mesh ↔ Workflow binding (Phase 4 of the DB-driven Capability Plan)
 *
 * Demonstrates `outputContract` + `ContractEmitter` + `MeshContractSourceAdapter`
 * end-to-end with no DB and no LLM.
 *
 * Pipeline:
 *   1. Workflow A declares `outputContract: { kind: 'order.fulfilled', bodyMap: {...} }`.
 *   2. On completion the engine builds an EmittedContract via `buildEmittedContract`
 *      and forwards it to a custom in-memory `ContractEmitter` that re-emits on a
 *      Node EventEmitter bus.
 *   3. `MeshContractSourceAdapter` (in `@weaveintel/triggers`) listens on the bus
 *      and feeds the dispatcher.
 *   4. A trigger filtered on `payload.kind == 'order.fulfilled'` fires Workflow B
 *      (via the workflow target adapter) using projected `inputMap`.
 *
 * Net effect: a workflow output becomes a typed event that drives the next
 * workflow, without any glue code wiring them together — only DB-shaped rows.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  DefaultWorkflowEngine,
  createNoopResolver,
  HandlerResolverRegistry,
  type ContractEmitter,
  type EmittedContract,
} from '@weaveintel/workflows';
import {
  createTriggerDispatcher,
  InMemoryTriggerStore,
  MeshContractSourceAdapter,
  CallbackTargetAdapter,
  type Trigger,
} from '@weaveintel/triggers';
import type { WorkflowDefinition } from '@weaveintel/core';

// ──────────────────────────────────────────────────────────
// Custom in-memory ContractEmitter that publishes to an EventEmitter bus.
// (In geneweave this role is played by DbContractEmitter, which also
// persists to the mesh_contracts table.)
// ──────────────────────────────────────────────────────────
class BusContractEmitter implements ContractEmitter {
  constructor(private readonly bus: EventEmitter, private readonly eventName = 'contract_emitted') {}
  async emit(contract: EmittedContract): Promise<void> {
    const id = randomUUID();
    console.log('[emitter] kind=%s id=%s body=%j', contract.kind, id, contract.body);
    this.bus.emit(this.eventName, { id, kind: contract.kind, body: contract.body, meta: contract.meta });
  }
}

async function main() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  // ── 1. Workflow engine + two definitions ────────────────
  const resolverRegistry = new HandlerResolverRegistry();
  resolverRegistry.register(createNoopResolver());

  const emitter = new BusContractEmitter(bus);
  const engine = new DefaultWorkflowEngine({
    contractEmitter: emitter,
    resolverRegistry,
  });

  // Workflow A: produces an "order.fulfilled" output contract.
  const wfA: WorkflowDefinition = {
    id: 'wf-fulfill-order',
    name: 'Fulfill Order',
    version: '1.0.0',
    description: 'Stub fulfillment workflow that emits a contract on completion.',
    entryStepId: 's1',
    steps: [
      { id: 's1', name: 'noop', type: 'deterministic', handler: 'noop' },
    ],
    outputContract: {
      kind: 'order.fulfilled',
      bodyMap: { orderId: 'orderId', amount: 'amount' },
      metadata: { source: 'wf-fulfill-order' },
    },
  };

  // Workflow B: triggered by Workflow A's contract.
  const wfB: WorkflowDefinition = {
    id: 'wf-send-receipt',
    name: 'Send Receipt',
    version: '1.0.0',
    description: 'Stub workflow downstream of order.fulfilled.',
    entryStepId: 's1',
    steps: [
      { id: 's1', name: 'noop', type: 'deterministic', handler: 'noop' },
    ],
  };

  await engine.createDefinition(wfA);
  await engine.createDefinition(wfB);

  // ── 2. Triggers: mesh contract source → workflow target ─
  const triggerStore = new InMemoryTriggerStore();
  const workflowTarget = new CallbackTargetAdapter('workflow', async (target, input) => {
    const wfId = String(target.config['workflowDefId']);
    console.log('[trigger->workflow] starting %s with input=%j', wfId, input);
    const run = await engine.startRun(wfId, input as Record<string, unknown>);
    return { ref: `run:${run.id}` };
  });

  await triggerStore.save({
    id: 't-on-order-fulfilled',
    key: 'on-order-fulfilled',
    enabled: true,
    source: { kind: 'contract_emitted', config: {} },
    filter: { expression: { '==': [{ var: 'payload.kind' }, 'order.fulfilled'] } },
    target: { kind: 'workflow', config: { workflowDefId: 'wf-send-receipt' } },
    inputMap: { orderId: 'payload.body.orderId', amount: 'payload.body.amount' },
  } satisfies Trigger);

  const dispatcher = createTriggerDispatcher({
    store: triggerStore,
    sourceAdapters: [new MeshContractSourceAdapter(bus)],
    targetAdapters: [workflowTarget],
  });
  await dispatcher.start();

  // ── 3. Run Workflow A and observe the cascade ───────────
  console.log('--- Starting Workflow A ---');
  const runA = await engine.startRun('wf-fulfill-order', { orderId: 'O-42', amount: 19.95 });
  console.log('[wfA] status=%s id=%s', runA.status, runA.id);

  // Allow the dispatcher and downstream workflow to settle.
  await new Promise((r) => setTimeout(r, 50));

  const invocations = await triggerStore.listInvocations();
  console.log('--- Trigger invocations ---');
  for (const inv of invocations) {
    console.log('  status=%s targetRef=%s sourceKind=%s', inv.status, inv.targetRef ?? '-', inv.sourceKind);
  }

  await dispatcher.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
