/**
 * @weaveintel/a2a — the shared contract every `A2AScopedTaskStore` binding passes.
 *
 * The in-memory reference and the Postgres binding run this same battery; a host that writes its own binding
 * (over its own row-level-secured table, say) runs it too. The test functions are passed in, so this module
 * imports no test framework.
 *
 * Rule R-A2A2: a task is readable only in the scope that wrote it — same tenant, same principal, same client.
 * A task id from another tenant is "not found", never "forbidden".
 */

import type { A2ATask } from '@weaveintel/core';
import type { A2AScopedTaskStore, A2ATaskScope } from './task-store-scoped.js';
import { newA2ATaskId } from './task-store-scoped.js';

/** The subset of a test framework the contract needs (vitest and jest both fit). */
export interface A2AScopedTaskStoreContractApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  beforeEach(fn: () => Promise<void> | void): void;
  // The contract only uses toBe, toEqual, toHaveLength, toBeNull, toBeDefined, rejects.toThrow and not.toBeNull.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect: (actual: unknown) => any;
}

const A: A2ATaskScope = { tenantId: 'tenant-a', principalId: 'person-1', clientId: 'ext:client-1' };
const A_OTHER_PERSON: A2ATaskScope = {
  tenantId: 'tenant-a',
  principalId: 'person-2',
  clientId: 'ext:client-1',
};
const A_OTHER_CLIENT: A2ATaskScope = {
  tenantId: 'tenant-a',
  principalId: 'person-1',
  clientId: 'ext:client-2',
};
const A_NO_PRINCIPAL: A2ATaskScope = { tenantId: 'tenant-a' };
const B: A2ATaskScope = { tenantId: 'tenant-b', principalId: 'person-1', clientId: 'ext:client-1' };

function task(over: Partial<A2ATask> = {}): A2ATask {
  return {
    id: newA2ATaskId(),
    contextId: 'ctx-1',
    status: { state: 'TASK_STATE_SUBMITTED', timestamp: '2026-11-14T00:00:00.000Z' },
    artifacts: [],
    history: [],
    ...over,
  };
}

export function a2aScopedTaskStoreContract(
  makeStore: () => A2AScopedTaskStore | Promise<A2AScopedTaskStore>,
  t: A2AScopedTaskStoreContractApi,
): void {
  const { describe, it, beforeEach, expect } = t;

  describe('A2AScopedTaskStore contract', () => {
    let store: A2AScopedTaskStore;
    beforeEach(async () => {
      store = await makeStore();
    });

    // ── round trip ────────────────────────────────────────────────────────────
    it('saves and loads a task in its own scope', async () => {
      const t1 = task({
        metadata: { note: 'x' },
        history: [{ role: 'ROLE_USER', parts: [{ text: 'hi' }], messageId: 'm1' } as never],
      });
      await store.save(A, t1);
      expect(await store.load(A, t1.id)).toEqual(t1);
    });

    it('overwrites a task on a second save in the same scope', async () => {
      const t1 = task();
      await store.save(A, t1);
      const t2 = {
        ...t1,
        status: { state: 'TASK_STATE_WORKING' as const, timestamp: '2026-11-14T00:00:01.000Z' },
      };
      await store.save(A, t2);
      expect((await store.load(A, t1.id))?.status.state).toBe('TASK_STATE_WORKING');
    });

    it('returns null for an id it does not hold', async () => {
      expect(await store.load(A, newA2ATaskId())).toBeNull();
    });

    // ── R-A2A2 isolation ──────────────────────────────────────────────────────
    it('does not find a task from another tenant', async () => {
      const t1 = task();
      await store.save(A, t1);
      expect(await store.load(B, t1.id)).toBeNull();
      expect((await store.list(B)).tasks).toHaveLength(0);
      expect(await store.delete(B, t1.id)).toBe(false);
      await expect(store.update(B, t1.id, { metadata: { x: 1 } })).rejects.toThrow(/not found/);
      expect(await store.load(A, t1.id)).toEqual(t1);
    });

    it('does not find a task of another person in the same tenant', async () => {
      const t1 = task();
      await store.save(A, t1);
      expect(await store.load(A_OTHER_PERSON, t1.id)).toBeNull();
      expect((await store.list(A_OTHER_PERSON)).tasks).toHaveLength(0);
      expect(await store.delete(A_OTHER_PERSON, t1.id)).toBe(false);
      await expect(store.update(A_OTHER_PERSON, t1.id, { metadata: { x: 1 } })).rejects.toThrow(
        /not found/,
      );
    });

    it('does not find a task created through another client for the same person', async () => {
      const t1 = task();
      await store.save(A, t1);
      expect(await store.load(A_OTHER_CLIENT, t1.id)).toBeNull();
    });

    it('does not let a scope with no principal read a principal-bound task', async () => {
      const t1 = task();
      await store.save(A, t1);
      expect(await store.load(A_NO_PRINCIPAL, t1.id)).toBeNull();
    });

    it('keeps a task with no principal to the scope with no principal', async () => {
      const t1 = task();
      await store.save(A_NO_PRINCIPAL, t1);
      expect(await store.load(A_NO_PRINCIPAL, t1.id)).toEqual(t1);
      expect(await store.load(A, t1.id)).toBeNull();
    });

    it('lets two tenants hold the same id without either seeing or overwriting the other', async () => {
      const id = newA2ATaskId();
      await store.save(A, task({ id, contextId: 'ctx-a' }));
      await store.save(B, task({ id, contextId: 'ctx-b' }));
      expect((await store.load(A, id))?.contextId).toBe('ctx-a');
      expect((await store.load(B, id))?.contextId).toBe('ctx-b');
      expect(await store.delete(B, id)).toBe(true);
      expect((await store.load(A, id))?.contextId).toBe('ctx-a');
    });

    it("refuses a save that would take over another person's task in the same tenant", async () => {
      const t1 = task();
      await store.save(A, t1);
      await expect(store.save(A_OTHER_PERSON, { ...t1, contextId: 'hijack' })).rejects.toThrow(
        /not found/,
      );
      expect((await store.load(A, t1.id))?.contextId).toBe('ctx-1');
    });

    it('refuses a scope with no tenant on every method', async () => {
      const bad = [
        {} as A2ATaskScope,
        { tenantId: '' },
        { tenantId: '   ' },
        { tenantId: 7 } as unknown as A2ATaskScope,
      ];
      for (const scope of bad) {
        await expect(store.save(scope, task())).rejects.toThrow(/tenant/);
        await expect(store.load(scope, 'x')).rejects.toThrow(/tenant/);
        await expect(store.list(scope)).rejects.toThrow(/tenant/);
        await expect(store.update(scope, 'x', {})).rejects.toThrow(/tenant/);
        await expect(store.delete(scope, 'x')).rejects.toThrow(/tenant/);
      }
    });

    it('refuses a task with no usable id', async () => {
      await expect(store.save(A, task({ id: '' }))).rejects.toThrow(/id/);
      await expect(store.save(A, task({ id: 'x'.repeat(300) }))).rejects.toThrow(/id/);
    });

    // ── update ────────────────────────────────────────────────────────────────
    it('updates status, artifacts and history, and merges metadata', async () => {
      const t1 = task({ metadata: { a: 1, b: 1 } });
      await store.save(A, t1);
      const status = {
        state: 'TASK_STATE_COMPLETED' as const,
        timestamp: '2026-11-14T00:00:05.000Z',
      };
      const artifacts = [
        { artifactId: 'a1', parts: [{ text: 'done' }] },
      ] as unknown as A2ATask['artifacts'];
      const updated = await store.update(A, t1.id, { status, artifacts, metadata: { b: 2, c: 3 } });
      expect(updated.status).toEqual(status);
      expect(updated.artifacts).toEqual(artifacts);
      expect(updated.metadata).toEqual({ a: 1, b: 2, c: 3 });
      expect(await store.load(A, t1.id)).toEqual(updated);
    });

    it('throws on update of a task it does not hold', async () => {
      await expect(store.update(A, newA2ATaskId(), { metadata: {} })).rejects.toThrow(/not found/);
    });

    // ── list ──────────────────────────────────────────────────────────────────
    it('lists newest first, filters by context, state and time, and pages', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const t1 = task({
          contextId: i % 2 === 0 ? 'even' : 'odd',
          status: {
            state: i === 4 ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING',
            timestamp: `2026-11-14T00:00:0${i}.000Z`,
          },
        });
        ids.push(t1.id);
        await store.save(A, t1);
      }
      await store.save(B, task({ contextId: 'even' })); // another tenant's task never shows up

      const all = await store.list(A);
      expect(all.tasks.map((x) => x.id)).toEqual([...ids].reverse());
      expect(all.totalSize).toBe(5);

      expect((await store.list(A, { contextId: 'even' })).tasks).toHaveLength(3);
      expect(
        (await store.list(A, { state: 'TASK_STATE_COMPLETED' })).tasks.map((x) => x.id),
      ).toEqual([ids[4]]);
      expect(
        (await store.list(A, { statusTimestampAfter: '2026-11-14T00:00:02.000Z' })).tasks,
      ).toHaveLength(2);

      const page1 = await store.list(A, { pageSize: 2 });
      expect(page1.tasks.map((x) => x.id)).toEqual([ids[4], ids[3]]);
      expect(page1.nextPageToken).toBeDefined();
      const page2 = await store.list(A, { pageSize: 2, pageToken: page1.nextPageToken });
      expect(page2.tasks.map((x) => x.id)).toEqual([ids[2], ids[1]]);
      const page3 = await store.list(A, { pageSize: 2, pageToken: page2.nextPageToken });
      expect(page3.tasks.map((x) => x.id)).toEqual([ids[0]]);
      expect(page3.nextPageToken).toBe(undefined);
    });

    it('refuses a page token it did not issue', async () => {
      await expect(store.list(A, { pageToken: 'abc' })).rejects.toThrow(/page token/);
      await expect(store.list(A, { pageToken: '-1' })).rejects.toThrow(/page token/);
    });

    it('caps the page size', async () => {
      for (let i = 0; i < 3; i++) await store.save(A, task());
      expect((await store.list(A, { pageSize: 0 })).tasks).toHaveLength(1);
      expect((await store.list(A, { pageSize: 10_000 })).tasks).toHaveLength(3);
    });

    // ── delete ────────────────────────────────────────────────────────────────
    it('deletes in its own scope', async () => {
      const t1 = task();
      await store.save(A, t1);
      expect(await store.delete(A, t1.id)).toBe(true);
      expect(await store.load(A, t1.id)).toBeNull();
      expect(await store.delete(A, t1.id)).toBe(false);
    });

    // ── content is data ───────────────────────────────────────────────────────
    it('stores hostile text as data', async () => {
      const nasty = `'); DROP TABLE x; -- \u0000-free ‮ "quoted" \\ back`.replace(
        '\u0000-free',
        'nul-free',
      );
      const t1 = task({ contextId: nasty, metadata: { [nasty]: nasty } });
      await store.save(A, t1);
      expect(await store.load(A, t1.id)).toEqual(t1);
      expect((await store.list(A, { contextId: nasty })).tasks).toHaveLength(1);
    });
  });
}
