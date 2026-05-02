/**
 * Example 85 — DB-driven model routing for live agents.
 *
 * Phase 3.5 of the DB-Driven Live-Agents Runtime. Demonstrates the three
 * resolution paths for the new `model_*` columns on `live_agents`:
 *
 *   1. Default       — no columns set → factory.defaultModel() wins.
 *   2. Capability    — `model_capability_json` set → factory.routeByCapability().
 *   3. Pinned        — `model_pinned_id` set → factory.loadPinnedModel(),
 *                      routing is bypassed (replay / reproducibility).
 *
 * Each successful resolution appends an audit row to `live_run_events`
 * (`kind = 'model.resolved'`). We list those at the end so you can see
 * the trail.
 *
 * Re-uses the inbox-triage demo mesh from examples/82-define-mesh-via-db.ts.
 *
 * Run:
 *   npx tsx examples/85-agent-model-routing.ts
 */
import { SQLiteAdapter } from '../apps/geneweave/src/db-sqlite.js';
import { newUUIDv7 } from '../apps/geneweave/src/lib/uuid.js';
import {
  resolveLiveAgentModel,
  clearLiveAgentModelCache,
  type AgentModelFactory,
} from '../apps/geneweave/src/live-agents/agent-model-resolver.js';
import type { Model } from '@weaveintel/core';

/**
 * Tiny stub Model — keeps the example free of provider creds. We only
 * inspect `info.modelId` at the end to confirm the right path was taken.
 */
function fakeModel(label: string): Model {
  return {
    info: {
      providerId: 'fake',
      modelId: label,
      kind: 'chat',
      contextWindow: 8000,
      capabilities: [],
    },
    capabilities: [],
    async generate() {
      return { content: `[${label}] would respond`, finishReason: 'stop' as const, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    },
  } as unknown as Model;
}

async function main(): Promise<void> {
  const db = new SQLiteAdapter('./geneweave.db');
  await db.initialize();

  // ── 1. Locate (or skip with hint) the inbox-triage mesh ──
  const meshDef = await db.getLiveMeshDefinitionByKey('inbox-triage');
  if (!meshDef) {
    console.error('Mesh "inbox-triage" not found. Run examples/82-define-mesh-via-db.ts first.');
    process.exit(1);
  }
  const meshes = await db.listLiveMeshes({ meshDefId: meshDef.id });
  const liveMesh = meshes[0];
  if (!liveMesh) {
    console.error('No provisioned mesh — run example 82 first.');
    process.exit(1);
  }
  const agents = await db.listLiveAgents({ meshId: liveMesh.id });
  const responder = agents.find((a) => a.role_key === 'responder');
  if (!responder) {
    console.error('Responder agent missing — run example 82 first.');
    process.exit(1);
  }

  // ── 2. Open a live_run so the audit events have somewhere to land ──
  const run = await db.createLiveRun({
    id: newUUIDv7(),
    mesh_id: liveMesh.id,
    tenant_id: null,
    run_key: `phase35-demo-${Date.now()}`,
    label: 'Phase 3.5 model routing demo',
    status: 'RUNNING',
    started_at: new Date().toISOString(),
    completed_at: null,
    summary: null,
    context_json: null,
  });
  console.log(`Opened run ${run.id}`);

  // ── 3. A pluggable factory the bridge calls. Real apps wire this
  //      to @weaveintel/routing's SmartModelRouter or to env-keyed
  //      provider clients. For the demo we just label the stub.
  const factory: AgentModelFactory = {
    async loadPinnedModel(modelId) {
      return fakeModel(`pinned/${modelId}`);
    },
    async routeByCapability(spec, key) {
      const task = (spec['task'] as string) ?? 'generic';
      return fakeModel(`routed/${task}${key ? `+${key}` : ''}`);
    },
    async defaultModel() {
      return fakeModel('default/gpt-4o-mini');
    },
  };

  // ── 4a. Path A: no model_* columns set → DEFAULT ──
  console.log('\n── Path A: default ──');
  await db.updateLiveAgent(responder.id, {
    model_capability_json: null,
    model_routing_policy_key: null,
    model_pinned_id: null,
  });
  let row = (await db.getLiveAgent(responder.id))!;
  let resolved = await resolveLiveAgentModel(db, row, factory, { runId: run.id });
  console.log(`  source=${resolved.spec.source} label=${resolved.label} modelId=${resolved.model.info.modelId}`);

  // ── 4b. Path B: capability spec → ROUTED ──
  clearLiveAgentModelCache();
  console.log('\n── Path B: capability ──');
  await db.updateLiveAgent(responder.id, {
    model_capability_json: JSON.stringify({ task: 'reasoning', toolUse: true, minContextTokens: 32000 }),
    model_routing_policy_key: 'cost-optimised',
  });
  row = (await db.getLiveAgent(responder.id))!;
  resolved = await resolveLiveAgentModel(db, row, factory, { runId: run.id });
  console.log(`  source=${resolved.spec.source} label=${resolved.label} modelId=${resolved.model.info.modelId}`);

  // ── 4c. Path C: pinned id → bypass routing ──
  clearLiveAgentModelCache();
  console.log('\n── Path C: pinned ──');
  await db.updateLiveAgent(responder.id, {
    model_pinned_id: 'gpt-4o-2024-08-06',
  });
  row = (await db.getLiveAgent(responder.id))!;
  resolved = await resolveLiveAgentModel(db, row, factory, { runId: run.id });
  console.log(`  source=${resolved.spec.source} label=${resolved.label} modelId=${resolved.model.info.modelId}`);

  // ── 5. Show the audit trail ──
  console.log('\n── live_run_events for this run ──');
  const events = await db.listLiveRunEvents({ runId: run.id });
  for (const ev of events) {
    console.log(`  [${ev.kind}] ${ev.summary}  payload=${ev.payload_json}`);
  }

  // ── 6. Reset overrides so re-runs of example 82 keep clean state ──
  await db.updateLiveAgent(responder.id, {
    model_capability_json: null,
    model_routing_policy_key: null,
    model_pinned_id: null,
  });
  await db.updateLiveRun(run.id, {
    status: 'COMPLETED',
    completed_at: new Date().toISOString(),
    summary: 'Phase 3.5 demo complete',
  });

  await db.close();
  console.log('\nPhase 3.5 demo complete ✔');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
