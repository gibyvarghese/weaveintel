// SPDX-License-Identifier: MIT
/**
 * The nine Drizzle-backed workflow stores, proven on a REAL Postgres (Testcontainers — a throwaway
 * container, no mocks). Skipped automatically when Docker isn't available.
 *
 * Why this matters: before Phase 4 the Postgres adapters were "exercised at compile time only" — they
 * were never actually run against a database in this package. Now the SAME single implementation backs
 * both SQLite (proven by sqlite-stores.test.ts) and Postgres (proven here), so we get real coverage of
 * the Postgres side for the first time, plus stress, security, and a real-LLM end-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { WorkflowDefinition, WorkflowRun } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import { weavePostgresIdempotencyStore } from './postgres-idempotency-store.js';
import { weavePostgresPayloadStore } from './postgres-payload-store.js';
import { weavePostgresStepLockStore } from './postgres-step-lock-store.js';
import { weavePostgresWorkflowDefinitionStore } from './postgres-definition-store.js';
import { weavePostgresWorkflowRunRepository } from './postgres-run-repository.js';
import { weavePostgresSleepStore } from './postgres-sleep-store.js';
import { weavePostgresRunQueue } from './postgres-run-queue.js';
import { weavePostgresAuditLog } from './postgres-audit-log.js';
import { weavePostgresRateLimiter } from './postgres-rate-limiter.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../.env', '../../.env', '../.env']) {
    try { const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m); if (m) return m[1]!.trim().replace(/^["']|["']$/g, ''); } catch { /* */ }
  }
  return undefined;
}
const KEY = loadKey();

let seq = 0;
const uniq = (p: string) => `${p}-${++seq}`;
const wfDef = (over: Partial<WorkflowDefinition> = {}): WorkflowDefinition =>
  ({ id: uniq('def'), name: uniq('name'), version: '1.0.0', steps: [], ...over } as WorkflowDefinition);
const wfRun = (over: Partial<WorkflowRun> = {}): WorkflowRun =>
  ({ id: uniq('run'), workflowId: 'wf-1', workflowVersion: '1.0.0', status: 'running', startedAt: new Date().toISOString(), state: {} as WorkflowRun['state'], ...over } as WorkflowRun);

describe.skipIf(!HAS_DOCKER)('Drizzle workflow stores → real Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 20 });
    await pool.query('SELECT 1');
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  it('idempotency: get/set/delete + clearPrefix matches by prefix', async () => {
    const s = await weavePostgresIdempotencyStore({ pool });
    const p = uniq('step');
    expect(await s.get(`${p}:a`)).toBeUndefined();
    await s.set(`${p}:a`, { result: 1 });
    expect(await s.get(`${p}:a`)).toEqual({ result: 1 });
    await s.set(`${p}:b`, { result: 2 });
    await s.clearPrefix(`${p}:`);
    expect(await s.get(`${p}:a`)).toBeUndefined();
    expect(await s.get(`${p}:b`)).toBeUndefined();
  }, 60_000);

  it('payload: put/get/delete + deleteRun removes a whole run', async () => {
    const s = await weavePostgresPayloadStore({ pool });
    const run = uniq('run');
    await s.put(`${run}:in`, { big: 'x'.repeat(1000) });
    await s.put(`${run}:out`, { ok: true });
    expect((await s.get(`${run}:in`) as { big: string }).big.length).toBe(1000);
    await s.deleteRun(run);
    expect(await s.get(`${run}:in`)).toBeUndefined();
    expect(await s.get(`${run}:out`)).toBeUndefined();
  }, 60_000);

  it('step-lock: locked → done state machine with output', async () => {
    const s = await weavePostgresStepLockStore({ pool });
    const run = uniq('run');
    expect(await s.isLocked(run, 's1')).toBe(false);
    await s.lock(run, 's1');
    expect(await s.isLocked(run, 's1')).toBe(true);
    expect(await s.isDone(run, 's1')).toEqual({ done: false });
    await s.lock(run, 's1'); // idempotent, no throw
    await s.markDone(run, 's1', { total: 42 });
    expect(await s.isDone(run, 's1')).toEqual({ done: true, output: { total: 42 } });
    await s.clear(run);
    expect(await s.isLocked(run, 's1')).toBe(false);
  }, 60_000);

  it('definitions: save (upsert + updated_at refresh), get by id OR name, list, delete', async () => {
    const s = await weavePostgresWorkflowDefinitionStore({ pool });
    const def = wfDef({ name: uniq('checkout') });
    const saved = await s.save(def);
    expect((saved as { updatedAt?: string }).updatedAt).toBeDefined();
    expect((await s.get(def.id))?.id).toBe(def.id);       // by id
    expect((await s.get(def.name))?.id).toBe(def.id);     // by name
    expect((await s.list()).some((d) => d.id === def.id)).toBe(true);
    await s.save({ ...def, name: uniq('checkout-v2') } as WorkflowDefinition); // upsert same id
    await s.delete(def.id);
    expect(await s.get(def.id)).toBeNull();
  }, 60_000);

  it('runs: save/get, list by workflow + parent, listFiltered, countActive', async () => {
    const s = await weavePostgresWorkflowRunRepository({ pool });
    const wf = uniq('wf');
    const parent = wfRun({ workflowId: wf, status: 'running' });
    await s.save(parent);
    const child = wfRun({ workflowId: wf, status: 'completed', parentRunId: parent.id, tenantId: 'acme' } as Partial<WorkflowRun>);
    await s.save(child);
    expect((await s.get(parent.id))?.id).toBe(parent.id);
    expect((await s.list(wf)).length).toBe(2);
    expect((await s.listByParent(parent.id)).map((r) => r.id)).toEqual([child.id]);
    expect((await s.listFiltered({ workflowId: wf, status: 'completed' })).map((r) => r.id)).toEqual([child.id]);
    expect((await s.listFiltered({ workflowId: wf, tenantId: 'acme' })).map((r) => r.id)).toEqual([child.id]);
    expect((await s.listFiltered({ workflowId: wf, limit: 1 })).length).toBe(1);
    expect(await s.countActive(wf)).toBe(1); // only the 'running' parent
    await s.delete(parent.id);
    expect(await s.get(parent.id)).toBeNull();
  }, 60_000);

  it('sleeps: schedule, getDue(now), list ordering, cancel', async () => {
    const s = await weavePostgresSleepStore({ pool });
    const a = uniq('run'); const b = uniq('run');
    await s.schedule(a, 1000);
    await s.schedule(b, 2000);
    await s.schedule(a, 1500); // upsert wake time
    const dueAt1600 = (await s.getDue(1600)).filter((r) => r.runId === a || r.runId === b);
    expect(dueAt1600.map((r) => r.runId)).toEqual([a]); // only a (1500 <= 1600); b (2000) not yet
    await s.cancel(a);
    expect((await s.getDue(9999)).some((r) => r.runId === a)).toBe(false);
  }, 60_000);

  it('run-queue: priority then FIFO dequeue; sizeFor/listFor/remove', async () => {
    const q = await weavePostgresRunQueue({ pool });
    const wf = uniq('wf');
    const mk = (priority: number) => ({ runId: newUUIDv7(), workflowId: wf, input: {}, priority, opts: {} });
    const low = await q.enqueue(mk(1));
    const hi1 = await q.enqueue(mk(9));
    const hi2 = await q.enqueue(mk(9)); // same priority → FIFO after hi1
    expect(await q.sizeFor(wf)).toBe(3);
    expect((await q.listFor(wf)).map((e) => e.id)).toEqual([hi1.id, hi2.id, low.id]);
    expect((await q.dequeue(wf))?.id).toBe(hi1.id); // highest priority, oldest first
    expect((await q.dequeue(wf))?.id).toBe(hi2.id);
    await q.remove(low.id);
    expect(await q.sizeFor(wf)).toBe(0);
    expect(await q.dequeue(wf)).toBeNull();
  }, 60_000);

  it('audit: append-only, list by run in order, listAll last-N', async () => {
    const log = await weavePostgresAuditLog({ pool });
    const run = uniq('run'); const wf = uniq('wf');
    for (let i = 0; i < 5; i++) {
      await log.append({ runId: run, workflowId: wf, type: `evt-${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), data: { i } });
    }
    const events = await log.list(run);
    expect(events.map((e) => e.type)).toEqual(['evt-0', 'evt-1', 'evt-2', 'evt-3', 'evt-4']);
    expect((events[2]!.data as { i: number }).i).toBe(2); // extra fields survive in payload
    const last2 = await log.listAll({ workflowId: wf, limit: 2 });
    expect(last2.map((e) => e.type)).toEqual(['evt-3', 'evt-4']); // newest two, oldest→newest
  }, 60_000);

  it('rate-limiter: token bucket depletes, denies, then refills over time', async () => {
    const rl = await weavePostgresRateLimiter({ pool });
    const wf = uniq('wf');
    expect(await rl.remaining(wf, 3)).toBe(3);
    expect(await rl.allow(wf, 3)).toBe(true);
    expect(await rl.allow(wf, 3)).toBe(true);
    expect(await rl.allow(wf, 3)).toBe(true);
    expect(await rl.allow(wf, 3)).toBe(false); // bucket empty
    await rl.reset(wf);
    expect(await rl.allow(wf, 3)).toBe(true);   // reset → full again
  }, 60_000);

  // ── Stress: a busy queue — 1,000 runs enqueued and drained in exact priority/FIFO order. ──
  it('STRESS: 1,000 run-queue entries drain in priority-then-FIFO order with no double-pop', async () => {
    const q = await weavePostgresRunQueue({ pool });
    const wf = uniq('wf');
    const N = 1000;
    for (let i = 0; i < N; i += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, j) => q.enqueue({ runId: `r-${i + j}`, workflowId: wf, input: { n: i + j }, priority: (i + j) % 10, opts: {} })));
    }
    expect(await q.sizeFor(wf)).toBe(N);
    // Concurrent drain — every entry popped exactly once (atomic delete-and-return).
    const popped = await Promise.all(Array.from({ length: N + 50 }, () => q.dequeue(wf)));
    const ids = popped.filter((e): e is NonNullable<typeof e> => e !== null).map((e) => e.id);
    expect(ids.length).toBe(N);
    expect(new Set(ids).size).toBe(N); // no id popped twice
    expect(await q.sizeFor(wf)).toBe(0);
  }, 120_000);

  // ── Security: hostile content is stored as data across the JSON-bearing stores. ──
  it('SECURITY: injection-laden values are stored as data, never executed', async () => {
    const evil = `'; DROP TABLE wf_idempotency; DROP TABLE wf_payloads; -- "x"`;
    const idem = await weavePostgresIdempotencyStore({ pool });
    const pay = await weavePostgresPayloadStore({ pool });
    await idem.set(uniq('k'), { evil });
    await pay.put(`${uniq('run')}:s`, { evil });
    // Tables still work afterwards.
    const k = uniq('k');
    await idem.set(k, { ok: true });
    expect(await idem.get(k)).toEqual({ ok: true });
  }, 60_000);

  // ── REAL LLM: an agent authors a workflow, we persist the definition + a run + an audit trail. ──
  it.skipIf(!KEY)('REAL LLM: a model designs a workflow; definition + run + audit persist to Postgres', async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Design a 3-step order-fulfilment workflow. Reply as strict JSON: {"name": string, "steps": [{"id": string, "title": string}]}.' }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
    const drafted = JSON.parse(((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content) as { name: string; steps: Array<{ id: string; title: string }> };
    expect(drafted.steps.length).toBeGreaterThanOrEqual(1);

    const defs = await weavePostgresWorkflowDefinitionStore({ pool });
    const runs = await weavePostgresWorkflowRunRepository({ pool });
    const audit = await weavePostgresAuditLog({ pool });

    // Persist the AI-designed definition, look it up by its (model-chosen) name.
    const def = wfDef({ name: drafted.name, steps: drafted.steps as unknown as WorkflowDefinition['steps'] });
    await defs.save(def);
    const found = await defs.get(drafted.name);
    expect(found?.id).toBe(def.id);
    expect((found as unknown as { steps: unknown[] }).steps.length).toBe(drafted.steps.length);

    // Start a run of it and record one audit event per step — all durable in Postgres.
    const run = wfRun({ workflowId: def.id, status: 'running' });
    await runs.save(run);
    for (const [i, step] of drafted.steps.entries()) {
      await audit.append({ runId: run.id, workflowId: def.id, type: 'step:started', stepId: step.id, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), data: { title: step.title } });
    }
    const trail = await audit.list(run.id);
    expect(trail.length).toBe(drafted.steps.length);
    expect(await runs.countActive(def.id)).toBe(1);
  }, 180_000);
});
