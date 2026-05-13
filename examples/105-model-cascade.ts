/**
 * Example 105 — Cost Governor Phase 4: Model Cascade
 *
 * Demonstrates the L1 (model cascade) lever from `@weaveintel/cost-governor`:
 *   • `RunCostStateTracker` — per-run signal accumulator (tool failures,
 *     JSON parse failures, current step kind, intel score).
 *   • `decideCascadeModel(...)` — pure decision: `cheap` by default,
 *     `expensive` when an escalation rule fires.
 *   • `weaveModelCascadeResolver(...)` — runtime wrapper that swaps in
 *     the right model for each tick. Falls through to `base` whenever
 *     config/loadModel error → cascade is never load-bearing.
 *   • `wrapAuditEmitterWithCascadeTracker(...)` — drop-in audit emitter
 *     wrapper that increments the tracker on `error` outcomes so a real
 *     deployment automatically sees tool-failure escalations.
 *
 * Pure in-memory. No DB, no LLM, no external services.
 */

import {
  RunCostStateTracker,
  decideCascadeModel,
  evaluateEscalationRule,
  weaveModelCascadeResolver,
  wrapAuditEmitterWithCascadeTracker,
  type ModelResolverLike,
} from '@weaveintel/cost-governor';
import type { CapabilityId, ExecutionContext, Model, ModelInfo, ModelRequest, ModelResponse, ToolAuditEvent } from '@weaveintel/core';
import type { ToolAuditEmitter } from '@weaveintel/tools';

// ─── Stub model factory ─────────────────────────────────────
function fakeModel(id: string): Model {
  const caps: ReadonlySet<CapabilityId> = new Set();
  const info: ModelInfo = { provider: 'openai', modelId: id, capabilities: caps };
  return {
    info,
    capabilities: caps,
    hasCapability: () => false,
    async generate(_ctx: ExecutionContext, _req: ModelRequest): Promise<ModelResponse> {
      return {
        id: 'r-' + id,
        content: id,
        finishReason: 'stop',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: id,
      };
    },
  };
}

const cheapRef = { provider: 'openai', modelId: 'gpt-4o-mini' };
const expensiveRef = { provider: 'openai', modelId: 'gpt-4o' };

const config = {
  cheap: cheapRef,
  expensive: expensiveRef,
  escalateOn: [
    { kind: 'tool_call_failed_count', threshold: 2 } as const,
    { kind: 'json_parse_failed_count', threshold: 2 } as const,
    { kind: 'step_kind', stepKinds: ['final_answer', 'submit'] } as const,
  ],
};

console.log('═══ 1. evaluateEscalationRule (pure predicate) ═══');
console.log('  toolFails=1, threshold=2 → fires?', evaluateEscalationRule(
  { kind: 'tool_call_failed_count', threshold: 2 },
  { toolCallFailedCount: 1, jsonParseFailedCount: 0, resolveCount: 0 },
));
console.log('  toolFails=2, threshold=2 → fires?', evaluateEscalationRule(
  { kind: 'tool_call_failed_count', threshold: 2 },
  { toolCallFailedCount: 2, jsonParseFailedCount: 0, resolveCount: 0 },
));

console.log('\n═══ 2. decideCascadeModel (pure decision) ═══');
const fresh = { toolCallFailedCount: 0, jsonParseFailedCount: 0, resolveCount: 0 };
console.log('  fresh state             →', decideCascadeModel(config, fresh, {}));
console.log('  after 2 tool failures   →', decideCascadeModel(config, { ...fresh, toolCallFailedCount: 2 }, {}));
console.log('  expensive step kind     →', decideCascadeModel(config, fresh, { stepKind: 'submit' }));
console.log('  no config (pass-through)→', decideCascadeModel(undefined, fresh, {}));

console.log('\n═══ 3. RunCostStateTracker (per-run accumulator) ═══');
const tracker = new RunCostStateTracker();
tracker.recordToolCall('agent-A', { ok: true });
tracker.recordToolCall('agent-A', { ok: false });
tracker.recordToolCall('agent-A', { ok: false });
console.log('  agent-A state:', tracker.get('agent-A'));
console.log('  tracker size:', tracker.size());

console.log('\n═══ 4. weaveModelCascadeResolver (runtime wiring) ═══');
const baseResolver: ModelResolverLike = { resolve: () => fakeModel('base-default') };
const cascade = weaveModelCascadeResolver({
  base: baseResolver,
  resolveConfig: () => config,
  loadModel: (ref) => fakeModel(ref.modelId),
  tracker,
  log: (msg) => console.log('  [cascade]', msg),
});

const m1 = await cascade.resolve({ runId: 'agent-B' });
console.log('  fresh agent-B           → modelId =', m1?.info.modelId);

tracker.recordToolCall('agent-B', { ok: false });
tracker.recordToolCall('agent-B', { ok: false });
const m2 = await cascade.resolve({ runId: 'agent-B' });
console.log('  agent-B after 2 failures→ modelId =', m2?.info.modelId);

const m3 = await cascade.resolve({ runId: 'agent-C', stepKind: 'submit' });
console.log('  agent-C on submit step  → modelId =', m3?.info.modelId);

console.log('\n═══ 5. wrapAuditEmitterWithCascadeTracker (closing the loop) ═══');
const baseEmitter: ToolAuditEmitter = {
  emit: async (e) => console.log('  [audit] persisted:', e.toolName, e.outcome),
};
const wrappedEmitter = wrapAuditEmitterWithCascadeTracker(baseEmitter, tracker, {
  resolveRunId: (e) => e.chatId ?? null,
});

const failEvent: ToolAuditEvent = {
  toolName: 'web_search',
  chatId: 'agent-D',
  outcome: 'error',
  createdAt: new Date().toISOString(),
};
await wrappedEmitter.emit(failEvent);
await wrappedEmitter.emit({ ...failEvent, createdAt: new Date().toISOString() });

console.log('  agent-D state after 2 audited failures:', tracker.get('agent-D'));
const m4 = await cascade.resolve({ runId: 'agent-D' });
console.log('  agent-D resolves to     → modelId =', m4?.info.modelId, '(escalated by audit signal)');

console.log('\n═══ 6. Graceful degradation (cascade never load-bearing) ═══');
const breakingCascade = weaveModelCascadeResolver({
  base: baseResolver,
  resolveConfig: () => { throw new Error('DB down'); },
  loadModel: (ref) => fakeModel(ref.modelId),
});
const m5 = await breakingCascade.resolve({ runId: 'agent-E' });
console.log('  resolveConfig throws    → falls back to base modelId =', m5?.info.modelId);

console.log('\n✓ Phase 4 (model cascade) demo complete.');
