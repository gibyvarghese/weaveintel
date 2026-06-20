/**
 * Unit tests for A2ATaskStore implementations (Phase 3)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createInMemoryA2ATaskStore,
  createDurableA2ATaskStore,
  isTerminalA2AState,
} from './task-store.js';
import type { A2ATask, RuntimeKvStore } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<A2ATask> = {}): A2ATask {
  const id = newUUIDv7();
  return {
    id,
    contextId: 'ctx-1',
    status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    ...overrides,
  };
}

function makeKvStore(): RuntimeKvStore & { _store: Map<string, string> } {
  const _store = new Map<string, string>();
  return {
    _store,
    async get(key: string) { return _store.get(key); },
    async set(key: string, value: string) { _store.set(key, value); },
    async delete(key: string) { const had = _store.has(key); _store.delete(key); return had; },
    async list(prefix: string) {
      const results: { key: string; value: string }[] = [];
      for (const [k, v] of _store) {
        if (k.startsWith(prefix)) results.push({ key: k, value: v });
      }
      return results;
    },
  };
}

// ─── isTerminalA2AState ───────────────────────────────────────────────────────

describe('isTerminalA2AState', () => {
  it('returns true for COMPLETED', () => expect(isTerminalA2AState('TASK_STATE_COMPLETED')).toBe(true));
  it('returns true for FAILED', () => expect(isTerminalA2AState('TASK_STATE_FAILED')).toBe(true));
  it('returns true for CANCELED', () => expect(isTerminalA2AState('TASK_STATE_CANCELED')).toBe(true));
  it('returns true for REJECTED', () => expect(isTerminalA2AState('TASK_STATE_REJECTED')).toBe(true));
  it('returns false for SUBMITTED', () => expect(isTerminalA2AState('TASK_STATE_SUBMITTED')).toBe(false));
  it('returns false for WORKING', () => expect(isTerminalA2AState('TASK_STATE_WORKING')).toBe(false));
  it('returns false for INPUT_REQUIRED', () => expect(isTerminalA2AState('TASK_STATE_INPUT_REQUIRED')).toBe(false));
  it('returns false for AUTH_REQUIRED', () => expect(isTerminalA2AState('TASK_STATE_AUTH_REQUIRED')).toBe(false));
});

// ─── In-memory store ──────────────────────────────────────────────────────────

describe('createInMemoryA2ATaskStore', () => {
  describe('save + load', () => {
    it('saves and loads a task', async () => {
      const store = createInMemoryA2ATaskStore();
      const task = makeTask();
      await store.save(task);
      const loaded = await store.load(task.id);
      expect(loaded).toEqual(task);
    });

    it('returns null for unknown taskId', async () => {
      const store = createInMemoryA2ATaskStore();
      expect(await store.load('no-such-id')).toBeNull();
    });

    it('overwrites on second save', async () => {
      const store = createInMemoryA2ATaskStore();
      const task = makeTask();
      await store.save(task);
      const updated = { ...task, status: { state: 'TASK_STATE_WORKING' as const, timestamp: new Date().toISOString() } };
      await store.save(updated);
      expect((await store.load(task.id))?.status.state).toBe('TASK_STATE_WORKING');
    });
  });

  describe('update', () => {
    it('applies status patch', async () => {
      const store = createInMemoryA2ATaskStore();
      const task = makeTask();
      await store.save(task);
      const ts = new Date().toISOString();
      const updated = await store.update(task.id, { status: { state: 'TASK_STATE_WORKING', timestamp: ts } });
      expect(updated.status.state).toBe('TASK_STATE_WORKING');
      expect((await store.load(task.id))?.status.state).toBe('TASK_STATE_WORKING');
    });

    it('merges metadata', async () => {
      const store = createInMemoryA2ATaskStore();
      const task = makeTask({ metadata: { a: 1 } });
      await store.save(task);
      const updated = await store.update(task.id, { metadata: { b: 2 } });
      expect(updated.metadata).toEqual({ a: 1, b: 2 });
    });

    it('throws if task not found', async () => {
      const store = createInMemoryA2ATaskStore();
      await expect(store.update('unknown', { status: { state: 'TASK_STATE_WORKING', timestamp: '' } })).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('removes a task', async () => {
      const store = createInMemoryA2ATaskStore();
      const task = makeTask();
      await store.save(task);
      expect(await store.delete(task.id)).toBe(true);
      expect(await store.load(task.id)).toBeNull();
    });

    it('returns false for unknown taskId', async () => {
      const store = createInMemoryA2ATaskStore();
      expect(await store.delete('no-such-id')).toBe(false);
    });
  });

  describe('list', () => {
    it('lists all tasks when no filter', async () => {
      const store = createInMemoryA2ATaskStore();
      const t1 = makeTask({ contextId: 'ctx-A' });
      const t2 = makeTask({ contextId: 'ctx-B' });
      await store.save(t1);
      await store.save(t2);
      const page = await store.list();
      expect(page.tasks.length).toBe(2);
    });

    it('filters by contextId', async () => {
      const store = createInMemoryA2ATaskStore();
      const t1 = makeTask({ contextId: 'ctx-A' });
      const t2 = makeTask({ contextId: 'ctx-B' });
      await store.save(t1);
      await store.save(t2);
      const page = await store.list({ contextId: 'ctx-A' });
      expect(page.tasks.length).toBe(1);
      expect(page.tasks[0]!.contextId).toBe('ctx-A');
    });

    it('filters by state', async () => {
      const store = createInMemoryA2ATaskStore();
      const t1 = makeTask({ status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() } });
      const t2 = makeTask({ status: { state: 'TASK_STATE_FAILED', timestamp: new Date().toISOString() } });
      await store.save(t1);
      await store.save(t2);
      const page = await store.list({ state: 'TASK_STATE_COMPLETED' });
      expect(page.tasks.length).toBe(1);
      expect(page.tasks[0]!.status.state).toBe('TASK_STATE_COMPLETED');
    });

    it('paginates with pageSize', async () => {
      const store = createInMemoryA2ATaskStore();
      for (let i = 0; i < 5; i++) await store.save(makeTask());
      const page = await store.list({ pageSize: 2 });
      expect(page.tasks.length).toBe(2);
      expect(page.nextPageToken).toBeDefined();
      expect(page.totalSize).toBe(5);
    });

    it('returns next page using pageToken', async () => {
      const store = createInMemoryA2ATaskStore();
      for (let i = 0; i < 5; i++) await store.save(makeTask());
      const page1 = await store.list({ pageSize: 3 });
      expect(page1.tasks.length).toBe(3);
      const page2 = await store.list({ pageSize: 3, pageToken: page1.nextPageToken });
      expect(page2.tasks.length).toBe(2);
      expect(page2.nextPageToken).toBeUndefined();
    });
  });

  describe('subscribe', () => {
    it('emits current state immediately if task exists', async () => {
      const store = createInMemoryA2ATaskStore();
      const task = makeTask();
      await store.save(task);

      const events: A2ATask[] = [];
      const iter = store.subscribe!(task.id)[Symbol.asyncIterator]();
      const first = await iter.next();
      events.push(first.value);
      await iter.return?.();

      expect(events[0]?.id).toBe(task.id);
    });

    it('emits task updates', async () => {
      const store = createInMemoryA2ATaskStore();
      const task = makeTask();
      await store.save(task);

      const received: A2ATask[] = [];
      const done = (async () => {
        for await (const t of store.subscribe!(task.id)) {
          received.push(t);
          if (received.length >= 2) break;
        }
      })();

      // Push an update
      await store.update(task.id, {
        status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
      });

      await done;
      expect(received.length).toBeGreaterThanOrEqual(2);
    });

    it('closes after terminal state', async () => {
      const store = createInMemoryA2ATaskStore();
      const task = makeTask();
      await store.save(task);

      const received: A2ATask[] = [];
      const subDone = (async () => {
        for await (const t of store.subscribe!(task.id)) {
          received.push(t);
        }
      })();

      await store.save({
        ...task,
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
      });

      await subDone;
      const states = received.map((t) => t.status.state);
      expect(states).toContain('TASK_STATE_COMPLETED');
    });
  });
});

// ─── Durable KV store ─────────────────────────────────────────────────────────

describe('createDurableA2ATaskStore', () => {
  it('saves and loads a task', async () => {
    const kv = makeKvStore();
    const store = createDurableA2ATaskStore(kv);
    const task = makeTask();
    await store.save(task);
    const loaded = await store.load(task.id);
    expect(loaded?.id).toBe(task.id);
    expect(loaded?.status.state).toBe('TASK_STATE_SUBMITTED');
  });

  it('returns null for unknown task', async () => {
    const kv = makeKvStore();
    const store = createDurableA2ATaskStore(kv);
    expect(await store.load('no-such-id')).toBeNull();
  });

  it('updates a task', async () => {
    const kv = makeKvStore();
    const store = createDurableA2ATaskStore(kv);
    const task = makeTask();
    await store.save(task);
    const updated = await store.update(task.id, {
      status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    });
    expect(updated.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('deletes a task', async () => {
    const kv = makeKvStore();
    const store = createDurableA2ATaskStore(kv);
    const task = makeTask();
    await store.save(task);
    expect(await store.delete(task.id)).toBe(true);
    expect(await store.load(task.id)).toBeNull();
  });

  it('lists tasks', async () => {
    const kv = makeKvStore();
    const store = createDurableA2ATaskStore(kv);
    const t1 = makeTask();
    const t2 = makeTask();
    await store.save(t1);
    await store.save(t2);
    const page = await store.list();
    expect(page.tasks.length).toBe(2);
  });

  it('lists by contextId via secondary index', async () => {
    const kv = makeKvStore();
    const store = createDurableA2ATaskStore(kv);
    const t1 = makeTask({ contextId: 'ctx-X' });
    const t2 = makeTask({ contextId: 'ctx-Y' });
    await store.save(t1);
    await store.save(t2);
    const page = await store.list({ contextId: 'ctx-X' });
    expect(page.tasks.length).toBe(1);
    expect(page.tasks[0]!.contextId).toBe('ctx-X');
  });

  it('uses custom prefix', async () => {
    const kv = makeKvStore();
    const store = createDurableA2ATaskStore(kv, 'myprefix:');
    const task = makeTask();
    await store.save(task);
    const keys = [...kv._store.keys()];
    expect(keys.some((k) => k.startsWith('myprefix:task:'))).toBe(true);
  });

  it('does not expose subscribe', () => {
    const kv = makeKvStore();
    const store = createDurableA2ATaskStore(kv);
    expect(store.subscribe).toBeUndefined();
  });

  it('throws on update of unknown task', async () => {
    const kv = makeKvStore();
    const store = createDurableA2ATaskStore(kv);
    await expect(
      store.update('ghost-id', { status: { state: 'TASK_STATE_WORKING', timestamp: '' } }),
    ).rejects.toThrow();
  });
});
