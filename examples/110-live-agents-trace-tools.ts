/**
 * Example 110 — Live-Agents Trace Tools (Phase 9, Lazy Trace Retrieval)
 *
 * Demonstrates the `@weaveintel/live-agents-trace-tools` package and the
 * extended `prepare_config_json.tools` recipe shape end-to-end, with
 * pure in-memory readers (no DB, no LLM, no external services).
 *
 * What this example shows:
 *   1. The 5 tools registered by `createLiveTraceTools(...)`:
 *        - live_get_run_timeline
 *        - live_get_failed_attempts
 *        - live_get_recent_events
 *        - live_get_event_details
 *        - live_get_step_artifact
 *   2. Run-isolation: every tool is closure-bound to ONE runId resolved
 *      at prepare-time. Cross-run lookups return a structured error.
 *   3. The recipe-driven injection path: a `prepare_config_json` of
 *      `{ "tools": { "traceTools": "$auto" } }` flows through
 *      `dbPrepareFromConfig` and the runtime calls
 *      `traceToolsFactory({ runId, agentId, meshId })` to materialise
 *      the registry per tick.
 *   4. The merge path: `{ "tools": { "auto": true, "traceTools": "$auto" } }`
 *      produces a fresh registry containing both ctx.tools AND the
 *      trace tools.
 *   5. Graceful pass-through: when the factory returns null or throws,
 *      the trace tools are simply omitted (never load-bearing).
 *
 * Run: `npx tsx examples/110-live-agents-trace-tools.ts`
 */

import {
  createLiveTraceTools,
  type LiveRunEventLike,
  type LiveRunEventReader,
  type LiveRunStepLike,
  type LiveRunStepReader,
} from '@weaveintel/live-agents-trace-tools';
import {
  dbPrepareFromConfig,
  parsePrepareConfig,
} from '@weaveintel/live-agents-runtime';
import { weaveContext, weaveToolRegistry } from '@weaveintel/core';

// ─── In-memory fixture (stand-in for live_run_events / live_run_steps) ──
const fixtureEvents: LiveRunEventLike[] = [
  { id: 'e1', run_id: 'run-A', step_id: 's1', kind: 'tick.started', agent_id: 'a1', tool_key: null, summary: 'tick begin', payload_json: null, created_at: '2025-01-01T00:00:00Z' },
  { id: 'e2', run_id: 'run-A', step_id: 's1', kind: 'tool.called', agent_id: 'a1', tool_key: 'web_search', summary: 'searched: foo', payload_json: '{"q":"foo"}', created_at: '2025-01-01T00:00:01Z' },
  { id: 'e3', run_id: 'run-A', step_id: 's1', kind: 'tool.errored', agent_id: 'a1', tool_key: 'web_search', summary: 'rate-limited', payload_json: '{"err":"429"}', created_at: '2025-01-01T00:00:02Z' },
  { id: 'e4', run_id: 'run-A', step_id: 's2', kind: 'tick.completed', agent_id: 'a1', tool_key: null, summary: 'tick end', payload_json: null, created_at: '2025-01-01T00:00:03Z' },
  // Cross-run event the tools must NOT return:
  { id: 'e99', run_id: 'run-OTHER', step_id: null, kind: 'tick.started', agent_id: 'a2', tool_key: null, summary: 'other run', payload_json: null, created_at: '2025-01-01T00:00:04Z' },
];

const fixtureSteps: LiveRunStepLike[] = [
  { id: 's1', run_id: 'run-A', mesh_id: 'mesh-1', agent_id: 'a1', role_key: 'planner', status: 'COMPLETED', started_at: '2025-01-01T00:00:00Z', completed_at: '2025-01-01T00:00:02Z', summary: 'planning step', payload_json: '{"plan":"do X"}', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:02Z' },
  { id: 's2', run_id: 'run-A', mesh_id: 'mesh-1', agent_id: 'a1', role_key: 'executor', status: 'RUNNING', started_at: '2025-01-01T00:00:02Z', completed_at: null, summary: 'executing', payload_json: null, created_at: '2025-01-01T00:00:02Z', updated_at: '2025-01-01T00:00:02Z' },
  // Cross-run step:
  { id: 's99', run_id: 'run-OTHER', mesh_id: 'mesh-1', agent_id: 'a2', role_key: 'planner', status: 'COMPLETED', started_at: null, completed_at: null, summary: 'other run step', payload_json: null, created_at: '2025-01-01T00:00:04Z', updated_at: '2025-01-01T00:00:04Z' },
];

const eventReader: LiveRunEventReader = {
  async listEvents({ runId, afterId, limit }) {
    let rows = fixtureEvents.filter((e) => e.run_id === runId);
    if (afterId) {
      const idx = rows.findIndex((r) => r.id === afterId);
      if (idx >= 0) rows = rows.slice(idx + 1);
    }
    if (limit) rows = rows.slice(0, limit);
    return rows;
  },
  async getEvent(id) {
    return fixtureEvents.find((e) => e.id === id) ?? null;
  },
};

const stepReader: LiveRunStepReader = {
  async listSteps({ runId }) {
    return fixtureSteps.filter((s) => s.run_id === runId);
  },
  async getStep(id) {
    return fixtureSteps.find((s) => s.id === id) ?? null;
  },
};

// ─── Demo 1: Direct registry construction + run isolation ───
async function demoDirectRegistry() {
  console.log('\n=== Demo 1: Direct registry construction ===');
  const reg = createLiveTraceTools({
    runId: 'run-A',
    agentId: 'a1',
    eventReader,
    stepReader,
  });
  console.log('Tools registered:', reg.list().map((t) => t.schema.name));

  const ctx = weaveContext({});
  const timeline = await reg.get('live_get_run_timeline')!.invoke(ctx, { arguments: {} });
  console.log('timeline:', JSON.parse(timeline.content as string));

  const failed = await reg.get('live_get_failed_attempts')!.invoke(ctx, { arguments: {} });
  console.log('failed attempts:', JSON.parse(failed.content as string));

  // Cross-run lookup MUST be rejected:
  const cross = await reg.get('live_get_event_details')!.invoke(ctx, { arguments: { eventId: 'e99' } });
  console.log('cross-run event lookup (expect error):', JSON.parse(cross.content as string));
}

// ─── Demo 2: Recipe parser accepts the new object form ───
function demoRecipeParser() {
  console.log('\n=== Demo 2: Recipe parser (object form) ===');
  console.log('legacy "$auto":          ', parsePrepareConfig('{"tools":"$auto"}'));
  console.log('object {auto:true}:      ', parsePrepareConfig('{"tools":{"auto":true}}'));
  console.log('object {traceTools}:     ', parsePrepareConfig('{"tools":{"traceTools":"$auto"}}'));
  console.log('object {auto+traceTools}:', parsePrepareConfig('{"tools":{"auto":true,"traceTools":"$auto"}}'));
}

// ─── Demo 3: Recipe-driven prepare() calls the factory ───
async function demoRecipeDrivenPrepare() {
  console.log('\n=== Demo 3: Recipe-driven prepare() with traceToolsFactory ===');

  let factoryCalls = 0;
  const traceToolsFactory = async (ctx: { runId?: string; agentId?: string; meshId?: string }) => {
    factoryCalls += 1;
    console.log(`  factory called with:`, ctx);
    if (!ctx.runId) return null;
    return createLiveTraceTools({
      runId: ctx.runId,
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      eventReader,
      stepReader,
    });
  };

  // Recipe with only trace tools — factory output IS the registry:
  const { prepare: prepareTraceOnly } = dbPrepareFromConfig(
    { systemPrompt: 'hi', tools: { traceTools: '$auto' } },
    { traceToolsFactory, runId: 'run-A', agentId: 'a1', meshId: 'mesh-1' },
  );
  const out1 = await prepareTraceOnly({ inbound: { subject: 's', body: 'b' } });
  console.log('trace-only tools:', out1.tools?.list().map((t) => t.schema.name));

  // Recipe merging base tools + trace tools — fresh registry contains BOTH:
  const baseReg = weaveToolRegistry();
  baseReg.register({
    schema: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {}, required: [] } },
    invoke: async () => ({ content: 'echoed' }),
  });
  const { prepare: prepareMerged } = dbPrepareFromConfig(
    { systemPrompt: 'hi', tools: { auto: true, traceTools: '$auto' } },
    { tools: baseReg, traceToolsFactory, runId: 'run-A' },
  );
  const out2 = await prepareMerged({ inbound: { subject: 's', body: 'b' } });
  console.log('merged tools:', out2.tools?.list().map((t) => t.schema.name).sort());

  console.log(`Total factory calls: ${factoryCalls}`);
}

// ─── Demo 4: Graceful pass-through when factory fails ───
async function demoGracefulPassThrough() {
  console.log('\n=== Demo 4: Graceful pass-through (never load-bearing) ===');

  const baseReg = weaveToolRegistry();
  baseReg.register({
    schema: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: {}, required: [] } },
    invoke: async () => ({ content: 'echoed' }),
  });

  const throwingFactory = async () => {
    throw new Error('DB unreachable');
  };

  const { prepare } = dbPrepareFromConfig(
    { systemPrompt: 'hi', tools: { auto: true, traceTools: '$auto' } },
    { tools: baseReg, traceToolsFactory: throwingFactory, runId: 'run-A' },
  );
  const out = await prepare({ inbound: { subject: 's', body: 'b' } });
  console.log('factory threw → tools fall back to baseReg only:', out.tools?.list().map((t) => t.schema.name));
  console.log('(Notice: prepare() did NOT throw — trace tools are never load-bearing.)');
}

async function main() {
  await demoDirectRegistry();
  demoRecipeParser();
  await demoRecipeDrivenPrepare();
  await demoGracefulPassThrough();
  console.log('\n✓ Phase 9 example complete.');
}

main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
