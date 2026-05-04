/**
 * Example 92 — Live-agents Phase 2: DB-backed `ModelResolver` and per-agent overlay.
 *
 * Demonstrates the runtime primitives shipped in
 * `@weaveintel/live-agents-runtime` that wrap any DB-backed routing brain
 * in the `ModelResolver` contract from `@weaveintel/live-agents`:
 *
 *   1. `weaveDbModelResolver({ listCandidates, routeModel, getOrCreateModel })`
 *      — runs the live SmartModelRouter (or any equivalent) on every tick.
 *      Roles map to default task types via `roleTaskMap`. Failures are
 *      swallowed and fall back to `undefined` so the handler can use a
 *      pinned model.
 *
 *   2. `weaveAgentOverlayResolver({ base, getAgentRow, loadPinnedModel,
 *      appendAuditEvent })` — wraps a base resolver with the per-agent
 *      overlay encoded in the `live_agents` row:
 *        • `model_pinned_id` set → bypass routing, load the pinned model.
 *        • `model_capability_json` set → merge into the per-tick
 *          `ctx.capability` so the base resolver routes by capability.
 *        • Neither → delegate untouched.
 *      Every resolution emits an append-only `live_run_events` row of
 *      kind `'model.resolved'` so replays can reproduce the routing.
 *
 * Run:
 *   npx tsx examples/92-live-agents-db-routing.ts
 *
 * Expected output:
 *   - Round-robin routing across two fake providers per tick.
 *   - Pinned overlay bypasses routing and loads the pinned model.
 *   - Audit events printed inline so the routing trail is visible.
 *   - No external services required.
 */

import {
  weaveDbModelResolver,
  weaveAgentOverlayResolver,
  type AgentModelFieldsRowLike,
  type ModelResolvedAuditEvent,
} from '@weaveintel/live-agents-runtime';
import type { Model } from '@weaveintel/core';

// --- Fake model + tiny in-memory DB stand-ins -------------------------------

function fakeModel(id: string): Model {
  return {
    info: { provider: 'fake', modelId: id, capabilities: new Set() },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate() {
      return {
        id: 'r',
        model: id,
        content: `output from ${id}`,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  } as unknown as Model;
}

const HEADER = (label: string) => console.log(`\n=== ${label} ===`);

// --- Demo 1: weaveDbModelResolver round-robins per tick ---------------------

async function demoRoundRobin() {
  HEADER('1) weaveDbModelResolver — round-robin per tick');

  const candidates = [
    { id: 'gpt-4o', provider: 'openai' },
    { id: 'claude-3-5-sonnet', provider: 'anthropic' },
  ];

  // Stand-in routing brain: alternates between the two candidates.
  let counter = 0;
  const resolver = weaveDbModelResolver({
    listCandidates: async () => candidates,
    routeModel: async (cands, hints) => {
      const pick = cands[counter++ % cands.length]!;
      console.log(
        `  [route] taskType=${hints.taskType} prompt=${hints.prompt} → ${pick.provider}/${pick.id}`,
      );
      return { provider: pick.provider, modelId: pick.id };
    },
    getOrCreateModel: async (provider, modelId) => fakeModel(`${provider}/${modelId}`),
    roleTaskMap: { strategist: 'reasoning', validator: 'analysis' },
    log: (msg) => console.log('  [log]', msg),
  });

  for (const role of ['strategist', 'validator', 'strategist'] as const) {
    const m = await resolver.resolve({ role, stepId: counter });
    console.log(`  → resolved ${m ? (m.info as { modelId: string }).modelId : 'undefined'}`);
  }
}

// --- Demo 2: weaveAgentOverlayResolver pinned bypass ------------------------

async function demoPinnedOverlay() {
  HEADER('2) weaveAgentOverlayResolver — pinned id bypasses routing');

  // Base resolver — should NOT be called for the pinned agent.
  const base = weaveDbModelResolver({
    listCandidates: async () => [{ id: 'gpt-4o', provider: 'openai' }],
    routeModel: async () => {
      throw new Error('base.route should not run for a pinned agent');
    },
    getOrCreateModel: async () => fakeModel('routed-fallback'),
  });

  const events: ModelResolvedAuditEvent[] = [];
  const overlay = weaveAgentOverlayResolver({
    base,
    getAgentRow: async (id): Promise<AgentModelFieldsRowLike | null> => {
      if (id === 'agent-pinned') {
        return { model_pinned_id: 'gpt-4o-2024-08-06' };
      }
      if (id === 'agent-capability') {
        return {
          model_capability_json: JSON.stringify({ task: 'tool_use' }),
          model_routing_policy_key: 'low-cost',
        };
      }
      return null;
    },
    loadPinnedModel: async (pinnedId) => fakeModel(`pinned/${pinnedId}`),
    appendAuditEvent: async (evt) => {
      events.push(evt);
    },
    log: (m) => console.log('  [overlay]', m),
  });

  const pinned = await overlay.resolve({
    agentId: 'agent-pinned',
    runId: 'run-123',
    stepId: 1,
  });
  console.log(`  pinned → ${pinned ? (pinned.info as { modelId: string }).modelId : 'undefined'}`);

  const cap = await overlay.resolve({
    agentId: 'agent-capability',
    runId: 'run-123',
    stepId: 2,
  });
  console.log(
    `  capability overlay → ${cap ? (cap.info as { modelId: string }).modelId : 'undefined (base.route threw — overlay swallowed)'}`,
  );

  console.log(`  audit events emitted: ${events.length}`);
  for (const evt of events) {
    console.log(`    [${evt.step_id}] ${evt.summary}`);
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  await demoRoundRobin();
  await demoPinnedOverlay();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
