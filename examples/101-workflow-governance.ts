/**
 * Example 101 — Workflow Governance / Durability / Replay (Phase 5)
 *
 * Demonstrates the four primitives of Phase 5 of the DB-Driven Capability Plan:
 *
 *   1. Input schema validation        — `validateWorkflowInput`
 *   2. Cost ceiling enforcement        — `InMemoryCostMeter` + `policy.costCeiling`
 *                                         + `workflow:cost_exceeded` event
 *   3. Replay determinism              — `WorkflowReplayRecorder`
 *                                         + `createReplayRegistry`
 *   4. Capability policy precedence    — `CapabilityPolicyBinding`
 *                                         + `resolveCapabilityBinding`
 *
 * Pure in-process. No DB, no LLM, no external services.
 */

import {
  DefaultWorkflowEngine,
  HandlerResolverRegistry,
  createNoopResolver,
  createScriptResolver,
  validateWorkflowInput,
  WorkflowInputValidationError,
  InMemoryCostMeter,
  WorkflowReplayRecorder,
  createReplayRegistry,
  InMemoryWorkflowRunRepository,
  type WorkflowRunRepository,
} from '@weaveintel/workflows';
import {
  resolveCapabilityBinding,
  type CapabilityPolicyBinding,
  type WorkflowDefinition,
  type WorkflowPolicy,
  type WorkflowRun,
  type EventBus,
} from '@weaveintel/core';

// ────────────────────────────────────────────────────────────
// 1. Input validation
// ────────────────────────────────────────────────────────────
console.log('\n[1] Input schema validation');
const schema = {
  type: 'object',
  required: ['orderId', 'amount'],
  properties: {
    orderId: { type: 'string', minLength: 3 },
    amount: { type: 'number', minimum: 0, maximum: 10_000 },
    currency: { enum: ['USD', 'EUR'] },
  },
};

const bad = validateWorkflowInput({ orderId: 'X', amount: -1, currency: 'JPY' }, schema);
console.log('  bad input → valid=', bad.valid, ', errors:', bad.errors.map(e => `${e.path}: ${e.message}`));

const good = validateWorkflowInput({ orderId: 'O-100', amount: 42.5, currency: 'USD' }, schema);
console.log('  good input → valid=', good.valid);

// ────────────────────────────────────────────────────────────
// 2. Cost ceiling — engine halts and emits workflow:cost_exceeded
// ────────────────────────────────────────────────────────────
console.log('\n[2] Cost ceiling');

class RunIdCapturingRepo implements WorkflowRunRepository {
  inner = new InMemoryWorkflowRunRepository();
  firstId: string | null = null;
  async save(run: WorkflowRun): Promise<void> { if (!this.firstId) this.firstId = run.id; return this.inner.save(run); }
  get(id: string) { return this.inner.get(id); }
  list(workflowId?: string) { return this.inner.list(workflowId); }
  delete(id: string) { return this.inner.delete(id); }
}

const meter = new InMemoryCostMeter();
const repo = new RunIdCapturingRepo();
const events: Array<{ type: string; data?: unknown }> = [];
const reg = new HandlerResolverRegistry();
reg.register({
  kind: 'noop',
  resolve: async () => async () => {
    if (repo.firstId) meter.record(repo.firstId, { costUsd: 0.30, source: 'sim:llm' });
    return {};
  },
});

const policy: WorkflowPolicy = { costCeiling: 0.50 };
const engine2 = new DefaultWorkflowEngine({
  resolverRegistry: reg,
  costMeter: meter,
  defaultPolicy: policy,
  runRepository: repo,
  bus: {
    emit: (e: { type: string; data?: unknown }) => { events.push(e); return 0; },
    on: () => () => {}, onAll: () => () => {}, onMatch: () => () => {},
  } as unknown as EventBus,
});

const wf2: WorkflowDefinition = {
  id: 'wf-cost', name: 'Cost demo', version: '1.0.0', entryStepId: 's1',
  steps: [
    { id: 's1', name: 'A', type: 'deterministic', handler: 'noop', next: 's2' },
    { id: 's2', name: 'B', type: 'deterministic', handler: 'noop' },
  ],
};
await engine2.createDefinition(wf2);
const run2 = await engine2.startRun('wf-cost', {});
console.log('  status=', run2.status, 'costTotal=$', run2.costTotal, 'error=', run2.error);
console.log('  events:', events.filter(e => e.type === 'workflow:cost_exceeded').map(e => e.type));

// ────────────────────────────────────────────────────────────
// 3. Replay — record once, replay deterministically
// ────────────────────────────────────────────────────────────
console.log('\n[3] Replay');
const wf3: WorkflowDefinition = {
  id: 'wf-replay', name: 'Replay demo', version: '1.0.0', entryStepId: 's1',
  steps: [
    { id: 's1', name: 'Pick price', type: 'deterministic', handler: 'script', config: { script: 'return { price: Math.floor(Math.random() * 1000) };' }, next: 's2' },
    { id: 's2', name: 'Mark complete', type: 'deterministic', handler: 'noop' },
  ],
};

const recorder = new WorkflowReplayRecorder();
const reg3 = new HandlerResolverRegistry();
reg3.register(createNoopResolver());
reg3.register(createScriptResolver());

// First, capture a real run.
class CapturingRepo implements WorkflowRunRepository {
  inner = new InMemoryWorkflowRunRepository();
  runId: string | null = null;
  async save(run: WorkflowRun) { if (!this.runId) this.runId = run.id; return this.inner.save(run); }
  get(id: string) { return this.inner.get(id); }
  list(workflowId?: string) { return this.inner.list(workflowId); }
  delete(id: string) { return this.inner.delete(id); }
}
const captureRepo = new CapturingRepo();
// Wrap registry to record outputs as they happen.
const recordingReg = new HandlerResolverRegistry();
for (const r of reg3.list()) {
  recordingReg.register({
    kind: r.kind,
    resolve: async (ctx) => {
      const inner = await r.resolve(ctx);
      return async (vars, cfg) => {
        const out = await inner(vars, cfg);
        if (captureRepo.runId) {
          recorder.record(captureRepo.runId, {
            stepId: ctx.step.id,
            handler: ctx.step.handler ?? ctx.step.id,
            kind: r.kind,
            ...(cfg !== undefined ? { config: cfg } : {}),
            variables: vars,
            output: out,
          });
        }
        return out;
      };
    },
  });
}
const engine3 = new DefaultWorkflowEngine({ resolverRegistry: recordingReg, runRepository: captureRepo });
await engine3.createDefinition(wf3);
const live = await engine3.startRun('wf-replay', {});
const trace = recorder.trace(captureRepo.runId!, 'wf-replay');
console.log('  live run price=', live.state.history[0]?.output);
console.log('  trace ordinals=', trace.steps.map(s => s.ordinal));

// Now replay using the captured trace.
const replayReg = createReplayRegistry(trace);
const engine3b = new DefaultWorkflowEngine({ resolverRegistry: replayReg });
await engine3b.createDefinition(wf3);
const replayed = await engine3b.startRun('wf-replay', {});
console.log('  replayed price=', replayed.state.history[0]?.output);
console.log('  deterministic match=', JSON.stringify(replayed.state.history[0]?.output) === JSON.stringify(live.state.history[0]?.output));

// ────────────────────────────────────────────────────────────
// 4. Capability policy precedence — agent (100) > mesh (50) > workflow (10)
// ────────────────────────────────────────────────────────────
console.log('\n[4] Capability policy precedence');
const bindings: CapabilityPolicyBinding[] = [
  { id: 'b1', bindingKind: 'workflow', bindingRef: 'wf-checkout', policyKind: 'tool_policy', policyRef: 'baseline', precedence: 10 },
  { id: 'b2', bindingKind: 'mesh',     bindingRef: 'mesh-ops',    policyKind: 'tool_policy', policyRef: 'tighter',  precedence: 50 },
  { id: 'b3', bindingKind: 'agent',    bindingRef: 'agent-x',     policyKind: 'tool_policy', policyRef: 'strict',   precedence: 100 },
];

const wfMatch = resolveCapabilityBinding(bindings, 'workflow', 'wf-checkout', 'tool_policy');
const meshMatch = resolveCapabilityBinding(bindings, 'mesh', 'mesh-ops', 'tool_policy');
const agentMatch = resolveCapabilityBinding(bindings, 'agent', 'agent-x', 'tool_policy');
console.log('  workflow → policyRef=', wfMatch?.policyRef, 'precedence=', wfMatch?.precedence);
console.log('  mesh     → policyRef=', meshMatch?.policyRef, 'precedence=', meshMatch?.precedence);
console.log('  agent    → policyRef=', agentMatch?.policyRef, 'precedence=', agentMatch?.precedence);
console.log('  no match → ', resolveCapabilityBinding(bindings, 'agent', 'unknown', 'tool_policy'));

// ────────────────────────────────────────────────────────────
// engine.startRun rejects invalid input automatically
// ────────────────────────────────────────────────────────────
console.log('\n[5] Engine input validation gate');
const engine5 = new DefaultWorkflowEngine({ resolverRegistry: reg });
await engine5.createDefinition({
  id: 'wf-validated', name: 'V', version: '1.0.0', entryStepId: 's1',
  steps: [{ id: 's1', name: 'S', type: 'deterministic', handler: 'noop' }],
  inputSchema: { type: 'object', required: ['orderId'] },
});
try {
  await engine5.startRun('wf-validated', {});
  console.log('  unexpected: did not throw');
} catch (e) {
  console.log('  threw=', e instanceof WorkflowInputValidationError, 'message=', (e as Error).message);
}

console.log('\n✓ Phase 5 example complete\n');
