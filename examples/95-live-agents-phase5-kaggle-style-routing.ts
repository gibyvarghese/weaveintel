/**
 * Example 95 — Live-agents Phase 5: kaggle-style boot with single-resolver
 * model routing (no `plannerModel`, no `resolveModelForRole` callback).
 *
 * Phase 5 (per LLM_FIRST_CLASS_CAPABILITY_PLAN.md) deleted the bespoke
 * kaggle plumbing — `buildPlannerModel()` and the `resolveModelForRole`
 * shim closure — leaving a single canonical routing path through
 * `weaveDbModelResolver`. This example shows the simplified boot pattern
 * any new long-running supervisor should adopt:
 *
 *   1. Construct exactly ONE `weaveDbModelResolver` per supervisor.
 *   2. Pass it to handler factories as `modelResolver: ModelResolver`.
 *   3. Handlers rebuild their inner ReAct loop per tick with whatever
 *      model the resolver picks — no per-role wrappers.
 *
 * What this example demonstrates:
 *   - One resolver instance routes for multiple roles (strategist,
 *     validator, observer) via `roleTaskMap`.
 *   - Per-tick rotation: the same resolver picks a different model on
 *     each call when candidates rotate (round-robin in this stub).
 *   - Failure isolation: when routing returns `undefined`, the handler
 *     can fall back to a pinned `plannerModel` (kept for parity with
 *     `weaveAgent`'s pinned `model` slot).
 *
 * Run:
 *   npx tsx examples/95-live-agents-phase5-kaggle-style-routing.ts
 *
 * No external services or DB required — the example uses stub adapters.
 */

import { weaveLiveAgent } from '@weaveintel/live-agents';
import { weaveDbModelResolver } from '@weaveintel/live-agents-runtime';
import type { Model, ModelResponse } from '@weaveintel/core';

// ─────────────────────────────────────────────────────────────────────
// Stub model factory (would normally be `getOrCreateModel` from chat-runtime).
// Each call returns a distinct Model object that echoes its identity in
// completions so we can see which model was picked per tick.
// ─────────────────────────────────────────────────────────────────────
function makeStubModel(provider: string, modelId: string): Model {
  const model: Model = {
    async complete(): Promise<ModelResponse> {
      return {
        content: `(${provider}/${modelId}) FINAL ANSWER: complete`,
        finishReason: 'stop',
      };
    },
  } as Model;
  Object.defineProperty(model, 'id', {
    value: `${provider}/${modelId}`,
    enumerable: true,
  });
  return model;
}

// ─────────────────────────────────────────────────────────────────────
// Stub candidate enumerator (would be `listAvailableModelsForRouting`).
// Returns two providers; the routing brain picks one per call.
// ─────────────────────────────────────────────────────────────────────
const candidates = [
  { provider: 'openai', modelId: 'gpt-4o' },
  { provider: 'anthropic', modelId: 'claude-sonnet' },
];

// ─────────────────────────────────────────────────────────────────────
// Stub routing brain (would be `routeModel(db, ...)` from chat-routing-utils).
// Round-robin selection so we see the resolver rotate per tick.
// ─────────────────────────────────────────────────────────────────────
let pick = 0;
async function stubRouteModel(
  cands: Array<{ provider: string; modelId: string }>,
  hints: { taskType?: string; prompt?: string },
): Promise<{ provider: string; modelId: string; taskKey?: string } | null> {
  if (cands.length === 0) return null;
  const choice = cands[pick % cands.length];
  pick++;
  console.log(
    `   ↳ stubRouteModel(taskType=${hints.taskType ?? '-'} prompt=${hints.prompt ?? '-'}) → ${choice.provider}/${choice.modelId}`,
  );
  return { ...choice, taskKey: hints.taskType };
}

// ─────────────────────────────────────────────────────────────────────
// THE PHASE 5 PATTERN — one resolver shared across all roles.
// In real kaggle code (`heartbeat-runner.ts`) this is the only routing
// construct: no `buildPlannerModel`, no `resolveModelForRole` shim.
// ─────────────────────────────────────────────────────────────────────
const dbModelResolver = weaveDbModelResolver({
  listCandidates: async () => candidates,
  routeModel: stubRouteModel,
  getOrCreateModel: async (provider, modelId) => makeStubModel(provider, modelId),
  roleTaskMap: {
    strategist: 'reasoning',
    validator: 'analysis',
    observer: 'analysis',
  },
  log: (msg) => console.log('[resolver]', msg),
});

// ─────────────────────────────────────────────────────────────────────
// Build a `weaveLiveAgent` that consumes the resolver. NO pinned model
// is supplied — the resolver provides one per tick. (For tests or
// single-model deployments you can also pass `model:` for a pinned
// fallback; `modelResolver` wins when both are set and returns a value.)
// ─────────────────────────────────────────────────────────────────────
const { handler, definition } = weaveLiveAgent({
  name: 'phase5-strategist',
  role: 'strategist',
  modelResolver: dbModelResolver,
  systemPrompt: 'You are a Kaggle strategist. Plan a Titanic submission.',
});

console.log('Built agent:', definition.name);
console.log(
  'Capabilities:',
  Object.entries(definition.capabilities)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(', '),
);

// ─────────────────────────────────────────────────────────────────────
// Simulate three ticks. The resolver rotates picks per call — same
// pattern the kaggle heartbeat exhibits in production when one provider
// rate-limits and SmartModelRouter switches on the next tick.
// ─────────────────────────────────────────────────────────────────────
async function runTicks() {
  for (let tick = 1; tick <= 3; tick++) {
    console.log(`\n── tick ${tick} ──`);
    const routed = await dbModelResolver.resolve({
      role: 'strategist',
      capability: { task: 'reasoning' },
    });
    if (routed) {
      const id = (routed as unknown as { id?: string }).id ?? 'unknown';
      console.log(`tick ${tick} — routed model: ${id}`);
    } else {
      console.log(`tick ${tick} — routing returned undefined (handler would fall back)`);
    }
  }

  // Reference the handler so the import is non-trivial; in a real boot
  // it would be passed to `createActionExecutor({ taskHandlers })`.
  console.log(`\nHandler ready (typeof = ${typeof handler}).`);
  console.log('\nDone — same pattern used by kaggle/heartbeat-runner.ts after Phase 5.');
}

runTicks().catch((err) => {
  console.error(err);
  process.exit(1);
});
