/**
 * Example 108 — Cost Governor Phase 7 (maxSteps + reasoning effort + tool-output truncation + budget gate).
 *
 * Pure in-memory. No DB, no LLM, no external services.
 *
 * Demonstrates:
 *   1. `decideMaxSteps()` clamping a requested step count to the policy cap.
 *   2. `wrapModelWithStaticReasoningEffort()` stamping `metadata.reasoningEffort` on every call.
 *   3. `weaveToolOutputTruncator()` truncating an oversize tool result to a UTF-8-safe byte cap.
 *   4. `weaveBudgetGate()` throwing `CostCeilingExceededError` when a stub ledger crosses the cap.
 *   5. `weaveCostGovernor(balanced, { costLedger, runIdResolver })` building all four levers from a tier preset.
 *
 * Run: npx tsx examples/108-budget-governor.ts
 */
import {
  weaveCostGovernor,
  decideMaxSteps,
  wrapModelWithStaticReasoningEffort,
  weaveToolOutputTruncator,
  weaveBudgetGate,
  weaveCostLedgerFromBreakdown,
  CostCeilingExceededError,
  resolveCostPolicy,
  type CostLeverContext,
} from '@weaveintel/cost-governor';
import type { Model, ModelRequest, ModelResponse, ExecutionContext } from '@weaveintel/core';

// ── 1. maxStepsCap ────────────────────────────────────────────────────────────
const balanced = resolveCostPolicy({ tier: 'balanced' });
console.log('\n[1] maxStepsCap');
console.log('   balanced cap =', balanced.maxStepsCap);
console.log('   requested 100, clamped to', decideMaxSteps(balanced, 100));
console.log('   requested 10, kept as', decideMaxSteps(balanced, 10));

// ── 2. reasoningEffort wrapper ────────────────────────────────────────────────
const captured: ModelRequest[] = [];
const innerModel: Model = {
  info: { provider: 'stub', modelId: 'stub-1', capabilities: new Set() },
  capabilities: new Set(),
  hasCapability: () => false,
  generate: async (_ctx: ExecutionContext, req: ModelRequest): Promise<ModelResponse> => {
    captured.push(req);
    return { id: 'r-1', content: 'ok', model: 'stub-1', usage: { promptTokens: 0, completionTokens: 0 }, finishReason: 'stop' };
  },
};
const wrapped = wrapModelWithStaticReasoningEffort(innerModel, 'high');
await wrapped.generate(
  { executionId: 'e-1', metadata: {} } as ExecutionContext,
  { messages: [{ role: 'user', content: 'hi' }] },
);
console.log('\n[2] reasoningEffort wrapper');
console.log('   metadata.reasoningEffort =', captured[0]?.metadata?.['reasoningEffort']);

// ── 3. toolOutputTruncation ──────────────────────────────────────────────────
const truncate = weaveToolOutputTruncator({ maxBytesPerTurn: 64, keepLastN: 3 });
const big = 'X'.repeat(200);
const trunc = truncate(big);
console.log('\n[3] tool output truncation');
console.log('   input bytes  =', Buffer.byteLength(big, 'utf8'));
console.log('   output bytes =', Buffer.byteLength(trunc.text, 'utf8'));
console.log('   truncated    =', trunc.truncated);

// ── 4. budget gate ───────────────────────────────────────────────────────────
let stubTotal = 0.5;
const gate = weaveBudgetGate({
  ledger: { total: async () => stubTotal },
  ceilingUsd: 1.0,
  runIdResolver: (c: CostLeverContext) => c.runId ?? null,
  onExceed: ({ runId, total, ceiling }) =>
    console.log(`   [onExceed] run=${runId} total=$${total.toFixed(2)} ceiling=$${ceiling.toFixed(2)}`),
});
console.log('\n[4] budget gate');
const ctx: CostLeverContext = { runId: 'demo-run' };
await gate.check(ctx);
console.log('   total $0.50 ≤ ceiling $1.00 → no throw');
stubTotal = 2.5;
try {
  await gate.check(ctx);
} catch (err) {
  if (err instanceof CostCeilingExceededError) {
    console.log(`   throw caught: runId=${err.runId} costUsd=${err.costUsd} ceilingUsd=${err.ceilingUsd}`);
  } else {
    throw err;
  }
}

// ── 5. weaveCostGovernor end-to-end ──────────────────────────────────────────
const bundle = weaveCostGovernor(
  { tier: 'economy' },
  {
    costLedger: weaveCostLedgerFromBreakdown({
      readBreakdown: async () => ({
        runId: 'demo',
        totalUsd: 5.0, // economy ceiling is $1.5 → exceed
        entryCount: 0,
        byLever: {} as Record<'model' | 'tool' | 'rag' | 'reasoning' | 'cache' | 'other', number>,
        byModel: {},
        bySubject: {},
        byAgent: {},
        tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
        entries: [],
      }),
    }),
    runIdResolver: (c) => c.runId ?? null,
  },
);
console.log('\n[5] weaveCostGovernor(economy) bundle');
console.log('   policy.maxStepsCap         =', bundle.policy.maxStepsCap);
console.log('   policy.reasoningEffort     =', bundle.policy.reasoningEffort);
console.log('   policy.toolOutputTrunc     =', JSON.stringify(bundle.policy.toolOutputTruncation));
console.log('   policy.budgetCeilingUsd    =', bundle.policy.budgetCeilingUsd);
try {
  await bundle.budgetGate.check({ runId: 'demo' });
  console.log('   budgetGate.check → no throw (unexpected)');
} catch (err) {
  if (err instanceof CostCeilingExceededError) {
    console.log(`   budgetGate.check → ceiling exceeded ($${err.costUsd} > $${err.ceilingUsd}) ✓`);
  } else {
    throw err;
  }
}

console.log('\n✅ Phase 7 example complete.\n');
