/**
 * Contract tests for the SQLite-backed workflows adapters.
 *
 * Postgres / MongoDB / Redis / DynamoDB adapters mirror the same shape and are
 * exercised at compile time + by app integration tests. A live test for those
 * stores requires running services; CI runs SQLite only.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { WorkflowDefinition, WorkflowRun, WorkflowState } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import {
  weaveSqliteCheckpointStore,
  weaveSqliteWorkflowDefinitionStore,
  weaveSqliteWorkflowRunRepository,
  weaveSqliteIdempotencyStore,
  weaveSqlitePayloadStore,
  weaveSqliteSleepStore,
  weaveSqliteStepLockStore,
  weaveSqliteRateLimiter,
  weaveSqliteRunQueue,
  weaveSqliteAuditLog,
} from './index.js';

function makeState(): WorkflowState {
  return {
    runId: 'run-1',
    workflowId: 'wf-1',
    workflowVersion: '1.0.0',
    currentStepId: 'step-1',
    variables: { x: 1 },
    history: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  } as WorkflowState;
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: newUUIDv7(),
    workflowId: 'wf-1',
    workflowVersion: '1.0.0',
    status: 'running',
    startedAt: new Date().toISOString(),
    state: makeState(),
    ...overrides,
  } as WorkflowRun;
}

describe('weaveSqliteCheckpointStore', () => {
  it('saves, loads, lists and deletes per run', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteCheckpointStore({ database: db });
    const cp1 = await store.save('run-A', 'step-1', makeState(), 'wf-1');
    const cp2 = await store.save('run-A', 'step-2', makeState(), 'wf-1');
    await store.save('run-B', 'step-1', makeState());
    expect(cp1.id).not.toBe(cp2.id);
    const loaded = await store.load(cp2.id);
    expect(loaded?.stepId).toBe('step-2');
    const listA = await store.list('run-A');
    expect(listA.map((c) => c.stepId)).toEqual(['step-1', 'step-2']);
    const latest = await store.latest('run-A');
    expect(latest?.id).toBe(cp2.id);
    await store.delete('run-A');
    expect(await store.list('run-A')).toEqual([]);
    expect((await store.list('run-B')).length).toBe(1);
  });
});

describe('weaveSqliteWorkflowDefinitionStore', () => {
  it('upserts and resolves by id-or-name', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteWorkflowDefinitionStore({ database: db });
    const def: WorkflowDefinition = {
      id: 'wf-1',
      name: 'demo',
      version: '1.0.0',
      steps: [],
      entryStepId: 'start',
    } as WorkflowDefinition;
    const saved = await store.save(def);
    expect(saved.createdAt).toBeTruthy();
    expect(saved.updatedAt).toBeTruthy();
    expect((await store.get('wf-1'))?.name).toBe('demo');
    expect((await store.get('demo'))?.id).toBe('wf-1');
    expect(await store.list()).toHaveLength(1);
    // Idempotent save bumps updatedAt but preserves createdAt.
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.save({ ...saved, name: 'demo-renamed' });
    expect(second.createdAt).toBe(saved.createdAt);
    expect((second.updatedAt ?? 0) > (saved.updatedAt ?? 0)).toBe(true);
    await store.delete('wf-1');
    expect(await store.get('wf-1')).toBeNull();
  });
});

describe('weaveSqliteWorkflowRunRepository', () => {
  it('persists runs with filters, parent, active count', async () => {
    const db = new Database(':memory:');
    const repo = weaveSqliteWorkflowRunRepository({ database: db });
    const r1 = makeRun({ workflowId: 'wf-A', tenantId: 't1' });
    const r2 = makeRun({ workflowId: 'wf-A', status: 'completed', tenantId: 't1' });
    const r3 = makeRun({ workflowId: 'wf-B', parentRunId: r1.id, tenantId: 't2' });
    await repo.save(r1);
    await repo.save(r2);
    await repo.save(r3);

    expect((await repo.get(r1.id))?.id).toBe(r1.id);
    expect((await repo.list('wf-A')).map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());
    expect((await repo.list()).length).toBe(3);
    expect((await repo.listByParent(r1.id)).map((r) => r.id)).toEqual([r3.id]);
    expect(await repo.countActive('wf-A')).toBe(1); // r2 is completed
    expect(await repo.countActive('wf-B')).toBe(1);

    const filtered = await repo.listFiltered({ workflowId: 'wf-A', status: 'running' });
    expect(filtered.map((r) => r.id)).toEqual([r1.id]);
    const tenantFiltered = await repo.listFiltered({ tenantId: 't2' });
    expect(tenantFiltered.map((r) => r.id)).toEqual([r3.id]);

    // Update preserves indexes.
    await repo.save({ ...r1, status: 'completed' });
    expect(await repo.countActive('wf-A')).toBe(0);

    await repo.delete(r3.id);
    expect(await repo.get(r3.id)).toBeNull();
  });
});

describe('weaveSqliteIdempotencyStore', () => {
  it('round-trips, deletes, and clears prefix', async () => {
    const store = weaveSqliteIdempotencyStore({ database: new Database(':memory:') });
    await store.set('run-1:step-a:abc', { ok: true });
    await store.set('run-1:step-b:xyz', { ok: false });
    await store.set('run-2:step-a:abc', 42);
    expect(await store.get('run-1:step-a:abc')).toEqual({ ok: true });
    expect(await store.get('missing')).toBeUndefined();
    await store.delete('run-1:step-b:xyz');
    expect(await store.get('run-1:step-b:xyz')).toBeUndefined();
    await store.clearPrefix('run-1:');
    expect(await store.get('run-1:step-a:abc')).toBeUndefined();
    expect(await store.get('run-2:step-a:abc')).toBe(42);
  });
});

describe('weaveSqlitePayloadStore', () => {
  it('round-trips and cascades deleteRun', async () => {
    const store = weaveSqlitePayloadStore({ database: new Database(':memory:') });
    await store.put('run-1:k1', { big: 'data' });
    await store.put('run-1:k2', [1, 2, 3]);
    await store.put('run-2:k1', 'other');
    expect(await store.get('run-1:k1')).toEqual({ big: 'data' });
    await store.delete('run-1:k2');
    expect(await store.get('run-1:k2')).toBeUndefined();
    await store.deleteRun('run-1');
    expect(await store.get('run-1:k1')).toBeUndefined();
    expect(await store.get('run-2:k1')).toBe('other');
  });
});

describe('weaveSqliteSleepStore', () => {
  it('schedules, lists due, and cancels', async () => {
    const store = weaveSqliteSleepStore({ database: new Database(':memory:') });
    const now = Date.now();
    await store.schedule('run-1', now - 1000);
    await store.schedule('run-2', now + 60_000);
    const all = await store.list();
    expect(all).toHaveLength(2);
    const due = await store.getDue(now);
    expect(due.map((d) => d.runId)).toEqual(['run-1']);
    await store.cancel('run-1');
    expect((await store.list()).map((d) => d.runId)).toEqual(['run-2']);
  });
});

describe('weaveSqliteStepLockStore', () => {
  it('locks, marks done, and clears', async () => {
    const store = weaveSqliteStepLockStore({ database: new Database(':memory:') });
    await store.lock('run-1', 'step-a');
    expect(await store.isLocked('run-1', 'step-a')).toBe(true);
    expect((await store.isDone('run-1', 'step-a')).done).toBe(false);
    await store.markDone('run-1', 'step-a', { value: 42 });
    const d = await store.isDone('run-1', 'step-a');
    expect(d.done).toBe(true);
    expect(d.output).toEqual({ value: 42 });
    await store.lock('run-1', 'step-b');
    await store.clear('run-1');
    expect(await store.isLocked('run-1', 'step-a')).toBe(false);
    expect(await store.isLocked('run-1', 'step-b')).toBe(false);
  });
});

describe('weaveSqliteRateLimiter', () => {
  it('drains and refills the token bucket', async () => {
    const limiter = weaveSqliteRateLimiter({ database: new Database(':memory:') });
    const wf = 'wf-1';
    const cap = 3;
    expect(await limiter.allow(wf, cap)).toBe(true);
    expect(await limiter.allow(wf, cap)).toBe(true);
    expect(await limiter.allow(wf, cap)).toBe(true);
    expect(await limiter.allow(wf, cap)).toBe(false);
    expect(await limiter.remaining(wf, cap)).toBe(0);
    await limiter.reset(wf);
    expect(await limiter.remaining(wf, cap)).toBe(cap);
  });
});

describe('weaveSqliteRunQueue', () => {
  it('honours priority and FIFO within priority', async () => {
    const q = weaveSqliteRunQueue({ database: new Database(':memory:') });
    const wf = 'wf-1';
    const e1 = await q.enqueue({ runId: 'r1', workflowId: wf, input: {}, priority: 1, opts: {} });
    await new Promise((r) => setTimeout(r, 5));
    const e2 = await q.enqueue({ runId: 'r2', workflowId: wf, input: {}, priority: 5, opts: {} });
    await new Promise((r) => setTimeout(r, 5));
    const e3 = await q.enqueue({ runId: 'r3', workflowId: wf, input: {}, priority: 5, opts: {} });
    expect(await q.size()).toBe(3);
    expect(await q.sizeFor(wf)).toBe(3);
    const first = await q.dequeue(wf);
    expect(first?.id).toBe(e2.id);
    const second = await q.dequeue(wf);
    expect(second?.id).toBe(e3.id);
    await q.remove(e1.id);
    expect(await q.dequeue(wf)).toBeNull();
  });
});

describe('weaveSqliteAuditLog', () => {
  it('appends and lists by run and workflow', async () => {
    const log = weaveSqliteAuditLog({ database: new Database(':memory:') });
    await log.append({
      runId: 'r1',
      workflowId: 'wf-A',
      type: 'run:started',
      timestamp: new Date().toISOString(),
    });
    await log.append({
      runId: 'r1',
      workflowId: 'wf-A',
      type: 'step:completed',
      stepId: 's1',
      timestamp: new Date().toISOString(),
    });
    await log.append({
      runId: 'r2',
      workflowId: 'wf-B',
      type: 'run:started',
      timestamp: new Date().toISOString(),
    });
    expect((await log.list('r1')).map((e) => e.type)).toEqual(['run:started', 'step:completed']);
    expect(await log.list('missing')).toEqual([]);
    const all = await log.listAll({ workflowId: 'wf-A' });
    expect(all.every((e) => e.workflowId === 'wf-A')).toBe(true);
    expect(all).toHaveLength(2);
    const limited = await log.listAll({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
