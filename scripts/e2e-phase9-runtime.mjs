#!/usr/bin/env node
/**
 * Phase 9 Runtime E2E — exercises the lazy-trace-tools package against a real
 * SQLite-backed geneweave DatabaseAdapter, end-to-end:
 *
 *   1. seed live_runs, live_run_steps, live_run_events directly in DB
 *   2. build LiveRunEventReader / LiveRunStepReader via geneweave adapters
 *   3. mint trace tools via createLiveTraceTools(...) closure-bound to one runId
 *   4. INVOKE each of the 5 tools and assert on their JSON output
 *   5. prove cross-run isolation (event from another run → 'event_not_in_current_run')
 *   6. clean up
 *
 * Uses an isolated DB file so the running dev server (./geneweave.db) is not touched.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createDatabaseAdapter } from '../apps/geneweave/dist/index.js';
import {
  createDbLiveRunEventReader,
  createDbLiveRunStepReader,
} from '../apps/geneweave/dist/cost/db-live-trace-tools.js';
import { createLiveTraceTools } from '../packages/live-agents-trace-tools/dist/index.js';
import { weaveContext } from '../packages/core/dist/index.js';

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log(`✓ ${msg}`); }
function bad(msg, extra) {
  fail++;
  console.error(`✗ ${msg}`);
  if (extra !== undefined) console.error('  ', extra);
}
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(msg);
  else bad(msg, `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
}
function truthy(v, msg) { v ? ok(msg) : bad(msg, `value=${JSON.stringify(v)}`); }

// Invoke a tool by registry key with a plain args object.
async function invokeTool(reg, name, args = {}) {
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const ctx = weaveContext({});
  const out = await tool.invoke(ctx, { name, arguments: args });
  // tool.invoke returns ToolOutput { content: string }
  const text = typeof out === 'string' ? out : out.content;
  try { return { tool, parsed: JSON.parse(text), raw: text }; }
  catch { return { tool, parsed: null, raw: text }; }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'phase9-runtime-'));
  const dbPath = join(dir, 'phase9.db');
  console.log(`▶ test DB: ${dbPath}\n`);

  const db = await createDatabaseAdapter({ type: 'sqlite', path: dbPath });

  try {
    // ── 1. seed parent rows (mesh def → mesh → agent), then 2 runs ──
    const meshDefId = randomUUID();
    const meshId = randomUUID();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const runA = randomUUID();
    const runB = randomUUID();
    const now = new Date().toISOString();

    await db.createLiveMeshDefinition({
      id: meshDefId, mesh_key: 'test_mesh', name: 'Test Mesh',
      charter_prose: 'phase 9 runtime e2e', dual_control_required_for: '[]',
      enabled: 1, description: 'test fixture',
    });
    await db.createLiveMesh({
      id: meshId, tenant_id: tenantId, mesh_def_id: meshDefId, name: 'TestMesh',
      status: 'ACTIVE', domain: null, dual_control_required_for: '[]',
      owner_human_id: null, mcp_server_ref: null, account_id: null, context_json: null,
    });
    await db.createLiveAgent({
      id: agentId, mesh_id: meshId, agent_def_id: null, role_key: 'executor',
      name: 'Executor', role_label: 'Executor', persona: 'test',
      objectives: '[]', success_indicators: '[]',
      attention_policy_key: null, contract_version_id: null,
      status: 'ACTIVE', ordering: 0, archived_at: null,
      model_capability_json: null, model_routing_policy_key: null,
      model_pinned_id: null, prepare_config_json: null,
    });
    ok('seeded parent rows (live_mesh_definition, live_mesh, live_agent)');

    for (const [id, label] of [[runA, 'run-A'], [runB, 'run-B']]) {
      await db.createLiveRun({
        id,
        mesh_id: meshId,
        tenant_id: tenantId,
        run_key: label,
        label,
        status: 'RUNNING',
        started_at: now,
        completed_at: null,
        summary: null,
        context_json: null,
      });
    }
    ok('seeded 2 live_runs (run-A under test, run-B for isolation)');

    // Steps for run-A: 3 RUNNING/COMPLETED + 1 FAILED
    const stepIds = { s1: randomUUID(), s2: randomUUID(), sFail: randomUUID(), s3: randomUUID() };
    await db.createLiveRunStep({
      id: stepIds.s1, run_id: runA, mesh_id: meshId, agent_id: agentId,
      role_key: 'planner', status: 'COMPLETED',
      started_at: now, completed_at: now,
      summary: 'plan ready', payload_json: JSON.stringify({ plan: 'do X then Y' }),
    });
    await db.createLiveRunStep({
      id: stepIds.s2, run_id: runA, mesh_id: meshId, agent_id: agentId,
      role_key: 'executor', status: 'COMPLETED',
      started_at: now, completed_at: now,
      summary: 'fetched data', payload_json: JSON.stringify({ rows: 42 }),
    });
    await db.createLiveRunStep({
      id: stepIds.sFail, run_id: runA, mesh_id: meshId, agent_id: agentId,
      role_key: 'executor', status: 'FAILED',
      started_at: now, completed_at: now,
      summary: 'tool quota exceeded',
      payload_json: JSON.stringify({ error: 'Rate limit hit on api_call', attempt: 3 }),
    });
    const bigStepPayload = JSON.stringify({ trace: 'x'.repeat(8000), note: 'over the 4kb step cap' });
    await db.createLiveRunStep({
      id: stepIds.s3, run_id: runA, mesh_id: meshId, agent_id: agentId,
      role_key: 'executor', status: 'RUNNING',
      started_at: now, completed_at: null,
      summary: 'retry in flight', payload_json: bigStepPayload,
    });
    ok('seeded 4 live_run_steps for run-A (3 done + 1 FAILED + 1 RUNNING)');

    // Events for run-A: tick.started, tick.completed, tool.errored,
    // tick.errored, plus a giant payload event for truncation.
    const evIds = {
      ok1: randomUUID(), ok2: randomUUID(),
      toolErr: randomUUID(), tickErr: randomUUID(), big: randomUUID(),
    };
    await db.appendLiveRunEvent({
      id: evIds.ok1, run_id: runA, step_id: stepIds.s1, kind: 'tick.started',
      agent_id: agentId, tool_key: null,
      summary: 'tick 1 started',
      payload_json: JSON.stringify({ phase: 'plan' }),
    });
    await db.appendLiveRunEvent({
      id: evIds.ok2, run_id: runA, step_id: stepIds.s2, kind: 'tick.completed',
      agent_id: agentId, tool_key: null,
      summary: 'tick 1 done',
      payload_json: JSON.stringify({ ok: true }),
    });
    await db.appendLiveRunEvent({
      id: evIds.toolErr, run_id: runA, step_id: stepIds.sFail, kind: 'tool.errored',
      agent_id: agentId, tool_key: 'api_call',
      summary: 'rate limit',
      payload_json: JSON.stringify({ code: 429, message: 'Too Many Requests' }),
    });
    await db.appendLiveRunEvent({
      id: evIds.tickErr, run_id: runA, step_id: stepIds.sFail, kind: 'tick.errored',
      agent_id: agentId, tool_key: null,
      summary: 'tick failed (downstream tool error)',
      payload_json: JSON.stringify({ cause: 'tool.errored' }),
    });
    const bigPayload = JSON.stringify({ data: 'x'.repeat(8000), note: 'over the 4kb cap' });
    await db.appendLiveRunEvent({
      id: evIds.big, run_id: runA, step_id: stepIds.s3, kind: 'tick.started',
      agent_id: agentId, tool_key: null,
      summary: 'tick 2 started (big payload)',
      payload_json: bigPayload,
    });
    ok('seeded 5 live_run_events for run-A (incl. failure + oversized payload)');

    // One event under run-B for isolation test.
    const evRunB = randomUUID();
    await db.appendLiveRunEvent({
      id: evRunB, run_id: runB, step_id: null, kind: 'tick.completed',
      agent_id: null, tool_key: null,
      summary: 'unrelated event from run-B',
      payload_json: JSON.stringify({ runB: true }),
    });
    ok('seeded 1 live_run_events on run-B (used for cross-run isolation test)');

    // ── 2. build adapters + trace tools ────────────────────────────
    const eventReader = createDbLiveRunEventReader(db);
    const stepReader = createDbLiveRunStepReader(db);
    const reg = createLiveTraceTools({ runId: runA, agentId, eventReader, stepReader });

    const expectedTools = [
      'live_get_run_timeline',
      'live_get_failed_attempts',
      'live_get_recent_events',
      'live_get_event_details',
      'live_get_step_artifact',
    ];
    const got = reg.list().map((t) => t.schema.name).sort();
    eq(got, [...expectedTools].sort(), 'createLiveTraceTools registered all 5 tools');

    // ── 3. invoke live_get_run_timeline ────────────────────────────
    {
      const { parsed } = await invokeTool(reg, 'live_get_run_timeline', { lastN: 10 });
      truthy(parsed && parsed.runId === runA, 'timeline.runId == runA');
      eq(parsed.totalSteps, 4, 'timeline.totalSteps == 4');
      eq(parsed.returned, 4, 'timeline.returned == 4');
      truthy(Array.isArray(parsed.steps) && parsed.steps.length === 4, 'timeline.steps is 4-element array');
    }
    {
      const { parsed } = await invokeTool(reg, 'live_get_run_timeline', { statusFilter: 'failed' });
      eq(parsed.returned, 1, 'timeline (statusFilter=FAILED) returns exactly 1 step');
      eq(parsed.steps[0].status, 'FAILED', 'timeline filtered step is the FAILED one');
    }

    // ── 4. invoke live_get_failed_attempts ─────────────────────────
    {
      const { parsed } = await invokeTool(reg, 'live_get_failed_attempts', {});
      truthy(parsed.runId === runA, 'failed_attempts.runId == runA');
      eq(parsed.failedStepsCount, 1, 'failed_attempts.failedStepsCount == 1');
      truthy(parsed.failedEventsCount >= 2, 'failed_attempts.failedEventsCount >= 2');
      truthy(Array.isArray(parsed.failures) && parsed.failures.length >= 3, 'failed_attempts.failures has step+events');
      const eventFailures = parsed.failures.filter((f) => f.kind === 'event');
      const eventKinds = new Set(eventFailures.map((f) => f.record.kind));
      truthy(eventKinds.has('tool.errored'), 'failures include tool.errored event');
      truthy(eventKinds.has('tick.errored'), 'failures include tick.errored event');
    }

    // ── 5. invoke live_get_recent_events ───────────────────────────
    {
      const { parsed } = await invokeTool(reg, 'live_get_recent_events', { limit: 3 });
      truthy(parsed.runId === runA, 'recent_events.runId == runA');
      truthy(Array.isArray(parsed.events) && parsed.events.length === 3, 'recent_events returned exactly 3');
      // Events ordered by id ASC; lastN slice = the 3 newest
      const lastEvent = parsed.events[parsed.events.length - 1];
      truthy(lastEvent && lastEvent.id, 'recent_events last event has an id');
    }

    // ── 6. invoke live_get_event_details on a normal-sized event ──
    {
      const { parsed } = await invokeTool(reg, 'live_get_event_details', { eventId: evIds.toolErr });
      truthy(parsed.id === evIds.toolErr, 'event_details returned correct event id');
      eq(parsed.kind, 'tool.errored', 'event_details.kind == tool.errored');
      // Full payload should be present (small, no truncation)
      truthy(parsed.payload && parsed.payload.code === 429, 'event_details full payload (code=429) included');
    }

    // ── 7. live_get_step_artifact payload truncation ──────────────
    {
      const { parsed } = await invokeTool(reg, 'live_get_step_artifact', { stepId: stepIds.s3 });
      truthy(parsed.id === stepIds.s3, 'step_artifact (big) returned correct step id');
      const preview = parsed.payloadPreview ?? '';
      truthy(typeof preview === 'string' && preview.includes('…[+'), 'big step payload was truncated with …[+Nb] marker');
    }

    // ── 8. cross-run isolation: ask for run-B event from run-A tools ─
    {
      const { parsed } = await invokeTool(reg, 'live_get_event_details', { eventId: evRunB });
      eq(parsed.error, 'event_not_in_current_run', 'cross-run event_details rejected with event_not_in_current_run');
    }

    // ── 9. invoke live_get_step_artifact ──────────────────────────
    {
      const { parsed } = await invokeTool(reg, 'live_get_step_artifact', { stepId: stepIds.s1 });
      truthy(parsed.id === stepIds.s1, 'step_artifact returned correct step id');
      eq(parsed.status, 'COMPLETED', 'step_artifact.status == COMPLETED');
      const preview = parsed.payloadPreview ?? '';
      truthy(typeof preview === 'string' && preview.includes('do X then Y'), 'step_artifact.payloadPreview includes plan text');
    }

    // ── 10. step_artifact missing arg → typed error ────────────────
    {
      const { parsed } = await invokeTool(reg, 'live_get_step_artifact', {});
      eq(parsed.error, 'stepId is required', 'step_artifact missing stepId returns typed error');
    }

    // ── 11. event_details missing arg → typed error ────────────────
    {
      const { parsed } = await invokeTool(reg, 'live_get_event_details', {});
      eq(parsed.error, 'eventId is required', 'event_details missing eventId returns typed error');
    }

  } finally {
    await db.close?.();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass}/${pass + fail} assertions passed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
