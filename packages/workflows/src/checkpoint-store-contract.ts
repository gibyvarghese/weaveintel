// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link CheckpointStore} adapter.
 *
 * A checkpoint store is where a running workflow's state is saved so it can survive a crash and resume.
 * The package ships several implementations (in-memory, JSON-file, KV, and — after Phase 4 — a single
 * Drizzle-backed one that serves both Postgres and SQLite). This one battery is run against all of them,
 * so we can prove they behave identically behind the one `CheckpointStore` port. That's the safety net
 * that made it safe to replace the two hand-written SQL adapters with one shared Drizzle implementation.
 *
 * It is framework-agnostic (it just calls the `describe`/`it`/`expect` you pass in). Where ordering
 * matters it inserts a 2 ms gap so timestamps are distinct on every backend — real checkpoints are
 * always further apart than that.
 */
import type { WorkflowState } from '@weaveintel/core';
import type { CheckpointStore } from './checkpoint-store.js';

export interface CheckpointContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    toBeNull(): void;
    toHaveLength(n: number): void;
    not: { toBe(v: unknown): void };
    [k: string]: unknown;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeState(over: Partial<WorkflowState> = {}): WorkflowState {
  return {
    runId: 'run-1',
    workflowId: 'wf-1',
    workflowVersion: '1.0.0',
    currentStepId: 'step-1',
    variables: { x: 1 },
    history: [],
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as WorkflowState;
}

export function checkpointStoreContract(
  make: () => Promise<CheckpointStore> | CheckpointStore,
  t: CheckpointContractTestApi,
): void {
  const { describe, it, beforeEach, expect } = t;
  describe('CheckpointStore contract', () => {
    let store: CheckpointStore;
    beforeEach(async () => { store = await make(); });

    it('save → load round-trips the full state, with defaults', async () => {
      const cp = await store.save('run-A', 'step-1', makeState({ variables: { count: 42 } }), 'wf-1');
      expect(cp.id).not.toBe('');
      expect(cp.runId).toBe('run-A');
      expect(cp.stepId).toBe('step-1');
      expect(cp.workflowId).toBe('wf-1');
      const loaded = await store.load(cp.id);
      expect(loaded?.id).toBe(cp.id);
      expect((loaded?.state.variables as { count: number }).count).toBe(42);
      expect(loaded?.state.currentStepId).toBe('step-1');
    });

    it('workflowId is optional — a checkpoint saved without one has none', async () => {
      const cp = await store.save('run-B', 'step-1', makeState());
      const loaded = await store.load(cp.id);
      expect(loaded?.workflowId ?? null).toBeNull();
    });

    it('latest returns the most-recent checkpoint for a run', async () => {
      const cp1 = await store.save('run-C', 'step-1', makeState());
      await sleep(2);
      const cp2 = await store.save('run-C', 'step-2', makeState());
      const latest = await store.latest('run-C');
      expect(latest?.id).toBe(cp2.id);
      expect(latest?.id).not.toBe(cp1.id);
    });

    it('list returns every checkpoint for a run, oldest → newest', async () => {
      await store.save('run-D', 'step-1', makeState());
      await sleep(2);
      await store.save('run-D', 'step-2', makeState());
      await sleep(2);
      await store.save('run-D', 'step-3', makeState());
      const list = await store.list('run-D');
      expect(list.map((c) => c.stepId)).toEqual(['step-1', 'step-2', 'step-3']);
    });

    it('runs are isolated — one run’s checkpoints never leak into another', async () => {
      await store.save('run-E', 'step-1', makeState());
      await store.save('run-F', 'step-1', makeState());
      expect(await store.list('run-E')).toHaveLength(1);
      expect(await store.list('run-F')).toHaveLength(1);
    });

    it('delete removes only that run’s checkpoints', async () => {
      await store.save('run-G', 'step-1', makeState());
      await store.save('run-H', 'step-1', makeState());
      await store.delete('run-G');
      expect(await store.list('run-G')).toHaveLength(0);
      expect(await store.list('run-H')).toHaveLength(1);
      expect(await store.latest('run-G')).toBeNull();
    });

    it('load and latest on unknown ids return null (never throw)', async () => {
      expect(await store.load('no-such-checkpoint')).toBeNull();
      expect(await store.latest('no-such-run')).toBeNull();
      expect(await store.list('no-such-run')).toHaveLength(0);
    });

    it('a large, deeply-nested state with tricky characters round-trips intact (JSON integrity)', async () => {
      const tricky = `"quotes" 'single' \\ backslash, ; DROP TABLE wf_checkpoints; -- 🧠 unicode`;
      const big = {
        note: tricky,
        history: Array.from({ length: 200 }, (_, i) => ({ step: `s${i}`, ok: i % 2 === 0, payload: { i, tricky } })),
        nested: { a: { b: { c: [1, 2, { d: tricky }] } } },
      };
      const cp = await store.save('run-I', 'step-1', makeState({ variables: big }));
      const loaded = await store.load(cp.id);
      expect((loaded?.state.variables as typeof big).note).toBe(tricky);
      expect((loaded?.state.variables as typeof big).history).toHaveLength(200);
      // The injection string was stored as data — the table still works afterwards.
      const after = await store.save('run-I', 'step-2', makeState());
      expect((await store.load(after.id))?.stepId).toBe('step-2');
    });
  });
}
