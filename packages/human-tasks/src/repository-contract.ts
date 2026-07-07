// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link HumanTaskRepository} adapter.
 *
 * A "repository" here is the one doorway to where human tasks (approvals, reviews, escalations) are
 * stored. The package ships an in-memory version and a JSON-file version; Phase 3 of the persistence
 * review adds a real Postgres one. This single battery is run against ALL of them, so we can prove they
 * behave identically behind the one port — the safety net that lets an app move its human-task storage
 * onto Postgres with confidence that nothing changed.
 *
 * It's framework-agnostic: it returns nothing and just calls the `describe`/`it`/`expect` you pass in,
 * so it works with vitest/jest/etc. The claim test is the important one — it pins the rule that the
 * highest-priority, oldest pending task is the next to be worked, and that claiming it flips it to
 * `assigned` for exactly one worker.
 */
import type { HumanTask } from '@weaveintel/core';
import type { HumanTaskRepository } from './repository.js';

export interface HumanTaskContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    toBeNull(): void;
    toHaveLength(n: number): void;
    [k: string]: unknown;
  };
}

let counter = 0;
let clock = 0;
function nextId(prefix: string): string { return `${prefix}-${++counter}`; }
/** Strictly increasing ISO timestamp so the FIFO tiebreak within a priority is deterministic. */
function nextTs(): string { clock += 1; return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + clock).toISOString(); }

function makeTask(over: Partial<HumanTask> = {}): HumanTask {
  return {
    id: nextId('task'),
    type: 'approval',
    title: 'Please approve',
    status: 'pending',
    priority: 'normal',
    createdAt: nextTs(),
    ...over,
  };
}

export function humanTaskRepositoryContract(
  make: () => Promise<HumanTaskRepository> | HumanTaskRepository,
  t: HumanTaskContractTestApi,
): void {
  const { describe, it, beforeEach, expect } = t;
  describe('HumanTaskRepository contract', () => {
    let repo: HumanTaskRepository;
    beforeEach(async () => { repo = await make(); });

    it('save → get round-trips the whole task (nested data + provenance survive)', async () => {
      const task = makeTask({
        title: 'Approve the refund',
        description: 'Customer asked for a refund on order #42',
        data: { orderId: 42, amount: 19.99, items: ['widget', 'gadget'] },
        provenance: { createdBy: 'agent', sourceRunId: 'run-7' },
        workflowRunId: 'run-7',
        priority: 'high',
      });
      await repo.save(task);
      const got = await repo.get(task.id);
      expect(got).toEqual(task);              // byte-for-byte, nested fields intact
      expect(await repo.get('does-not-exist')).toBeNull();
    });

    it('save is an upsert — saving the same id again replaces it', async () => {
      const task = makeTask({ title: 'v1' });
      await repo.save(task);
      await repo.save({ ...task, title: 'v2', status: 'completed' });
      const got = await repo.get(task.id);
      expect(got?.title).toBe('v2');
      expect(got?.status).toBe('completed');
    });

    it('list filters by status / type / assignee / priority / workflowRunId', async () => {
      const a = makeTask({ status: 'pending', type: 'approval', priority: 'high', workflowRunId: 'w1' });
      const b = makeTask({ status: 'completed', type: 'review', priority: 'low', workflowRunId: 'w1', assignee: 'bob' });
      const c = makeTask({ status: 'pending', type: 'review', priority: 'urgent', workflowRunId: 'w2', assignee: 'bob' });
      for (const task of [a, b, c]) await repo.save(task);

      const ids = async (f?: Parameters<HumanTaskRepository['list']>[0]) => (await repo.list(f)).map((x) => x.id).sort();
      expect(await ids()).toEqual([a.id, b.id, c.id].sort());
      expect(await ids({ status: ['pending'] })).toEqual([a.id, c.id].sort());
      expect(await ids({ type: ['review'] })).toEqual([b.id, c.id].sort());
      expect(await ids({ assignee: 'bob' })).toEqual([b.id, c.id].sort());
      expect(await ids({ priority: ['urgent', 'high'] })).toEqual([a.id, c.id].sort());
      expect(await ids({ workflowRunId: 'w1' })).toEqual([a.id, b.id].sort());
      expect(await ids({ status: ['pending'], type: ['review'] })).toEqual([c.id]); // combined
    });

    it('delete removes a task', async () => {
      const task = makeTask();
      await repo.save(task);
      await repo.delete(task.id);
      expect(await repo.get(task.id)).toBeNull();
      await repo.delete('ghost'); // deleting a non-existent task is a no-op, never throws
    });

    it('claimNextPending takes the highest-priority, oldest task and assigns it', async () => {
      // Saved in a deliberately scrambled order; the claim order must be priority then FIFO.
      const low = makeTask({ priority: 'low' });
      const urgent = makeTask({ priority: 'urgent' });
      const normalOld = makeTask({ priority: 'normal' });
      const normalNew = makeTask({ priority: 'normal' });
      const high = makeTask({ priority: 'high' });
      for (const task of [low, normalOld, high, urgent, normalNew]) await repo.save(task);

      const order: string[] = [];
      for (let i = 0; i < 5; i++) {
        const claimed = await repo.claimNextPending(`worker-${i}`);
        expect(claimed?.status).toBe('assigned');
        expect(claimed?.assignee).toBe(`worker-${i}`);
        order.push(claimed!.id);
        // The store reflects the claim: it's no longer pending.
        expect((await repo.get(claimed!.id))?.status).toBe('assigned');
      }
      expect(order).toEqual([urgent.id, high.id, normalOld.id, normalNew.id, low.id]);
      // Nothing left pending → null.
      expect(await repo.claimNextPending('worker-x')).toBeNull();
    });

    it('claimNextPending ignores tasks that are not pending', async () => {
      await repo.save(makeTask({ status: 'completed', priority: 'urgent' }));
      await repo.save(makeTask({ status: 'assigned', priority: 'urgent' }));
      expect(await repo.claimNextPending('worker')).toBeNull();
      const p = makeTask({ status: 'pending', priority: 'low' });
      await repo.save(p);
      expect((await repo.claimNextPending('worker'))?.id).toBe(p.id);
    });

    it('listByAssignee returns that assignee’s tasks (and merges an extra filter)', async () => {
      const t1 = makeTask({ assignee: 'carol', status: 'pending' });
      const t2 = makeTask({ assignee: 'carol', status: 'completed' });
      const t3 = makeTask({ assignee: 'dave', status: 'pending' });
      for (const task of [t1, t2, t3]) await repo.save(task);
      expect((await repo.listByAssignee('carol')).map((x) => x.id).sort()).toEqual([t1.id, t2.id].sort());
      expect((await repo.listByAssignee('carol', { status: ['pending'] })).map((x) => x.id)).toEqual([t1.id]);
      expect((await repo.listByAssignee('nobody'))).toHaveLength(0);
    });
  });
}
