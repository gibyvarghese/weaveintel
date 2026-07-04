/**
 * @weaveintel/a2a — Task store
 *
 * Provides durable and in-memory A2ATask persistence for the A2A v1.0
 * state machine. Tasks transition through:
 *   SUBMITTED → WORKING → COMPLETED | FAILED | REJECTED | INPUT_REQUIRED | AUTH_REQUIRED | CANCELED
 *
 * Two implementations:
 *   - `createInMemoryA2ATaskStore()` — fast, ephemeral; good for tests and single-process servers
 *   - `createDurableA2ATaskStore(kv)` — backed by any `RuntimeKvStore` for cross-restart durability
 *
 * The optional `subscribe` method enables `SubscribeToTask` SSE reconnection:
 *   for await (const task of store.subscribe!(taskId)) { ... }
 */

import type { A2ATask, A2AListTasksFilter, A2ATaskPage, A2ATaskState, RuntimeKvStore } from '@weaveintel/core';

// ─── Terminal states ──────────────────────────────────────────────────────────

const TERMINAL_STATES = new Set<A2ATaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

export function isTerminalA2AState(state: A2ATaskState): boolean {
  return TERMINAL_STATES.has(state);
}

// ─── Store interface ──────────────────────────────────────────────────────────

export interface A2ATaskStorePatch {
  readonly status?: A2ATask['status'];
  readonly artifacts?: A2ATask['artifacts'];
  readonly history?: A2ATask['history'];
  readonly metadata?: A2ATask['metadata'];
}

export interface A2ATaskStore {
  /** Create or overwrite a task. */
  save(task: A2ATask): Promise<void>;
  /** Load task by ID. Returns null if not found. */
  load(taskId: string): Promise<A2ATask | null>;
  /** Paginated listing with optional filter. */
  list(filter?: A2AListTasksFilter): Promise<A2ATaskPage>;
  /** Apply a partial patch to an existing task. Throws if task not found. */
  update(taskId: string, patch: A2ATaskStorePatch): Promise<A2ATask>;
  /** Remove a task. Returns true if it existed. */
  delete(taskId: string): Promise<boolean>;
  /**
   * Subscribe to task state changes as an async iterable.
   * Yields each saved/updated task until it reaches a terminal state,
   * then closes automatically. The current task state is emitted immediately
   * on subscribe (if the task exists).
   * Only available on in-memory store and Redis-backed stores (Phase 5+).
   */
  subscribe?(taskId: string): AsyncIterable<A2ATask>;
}

// ─── In-memory store ──────────────────────────────────────────────────────────

export function createInMemoryA2ATaskStore(): A2ATaskStore {
  const tasks = new Map<string, A2ATask>();
  const subscribers = new Map<string, Set<(task: A2ATask) => void>>();

  function notifySubscribers(task: A2ATask): void {
    const subs = subscribers.get(task.id);
    if (!subs || subs.size === 0) return;
    for (const cb of subs) cb(task);
  }

  return {
    async save(task: A2ATask): Promise<void> {
      tasks.set(task.id, task);
      notifySubscribers(task);
    },

    async load(taskId: string): Promise<A2ATask | null> {
      return tasks.get(taskId) ?? null;
    },

    async list(filter?: A2AListTasksFilter): Promise<A2ATaskPage> {
      let items = [...tasks.values()];

      if (filter?.contextId) {
        items = items.filter((t) => t.contextId === filter.contextId);
      }
      if (filter?.state) {
        items = items.filter((t) => t.status.state === filter.state);
      }
      if (filter?.statusTimestampAfter) {
        items = items.filter((t) => t.status.timestamp > filter.statusTimestampAfter!);
      }

      // Sort newest-first by status timestamp
      items.sort((a, b) => b.status.timestamp.localeCompare(a.status.timestamp));

      const pageSize = filter?.pageSize ?? 50;
      const offset = filter?.pageToken ? parseInt(filter.pageToken, 10) : 0;
      const page = items.slice(offset, offset + pageSize);
      const nextOffset = offset + page.length;
      const nextPageToken = nextOffset < items.length ? String(nextOffset) : undefined;

      return { tasks: page, nextPageToken, totalSize: items.length };
    },

    async update(taskId: string, patch: A2ATaskStorePatch): Promise<A2ATask> {
      const existing = tasks.get(taskId);
      if (!existing) throw new Error(`A2ATaskStore: task not found for update: ${taskId}`);
      const updated: A2ATask = {
        ...existing,
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.artifacts !== undefined && { artifacts: patch.artifacts }),
        ...(patch.history !== undefined && { history: patch.history }),
        ...(patch.metadata !== undefined && { metadata: { ...existing.metadata, ...patch.metadata } }),
      };
      tasks.set(taskId, updated);
      notifySubscribers(updated);
      return updated;
    },

    async delete(taskId: string): Promise<boolean> {
      const existed = tasks.has(taskId);
      tasks.delete(taskId);
      subscribers.delete(taskId);
      return existed;
    },

    subscribe(taskId: string): AsyncIterable<A2ATask> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<A2ATask> {
          const queue: A2ATask[] = [];
          let notifyFn: (() => void) | null = null;
          let closed = false;

          if (!subscribers.has(taskId)) subscribers.set(taskId, new Set());
          const subs = subscribers.get(taskId)!;

          const push = (task: A2ATask): void => {
            if (closed) return;
            queue.push(task);
            if (notifyFn) {
              const n = notifyFn;
              notifyFn = null;
              n();
            }
            if (isTerminalA2AState(task.status.state)) {
              closed = true;
              subs.delete(push);
            }
          };

          subs.add(push);

          // Emit current state immediately if task exists
          const current = tasks.get(taskId);
          if (current) push(current);

          return {
            async next(): Promise<IteratorResult<A2ATask>> {
              while (queue.length === 0 && !closed) {
                await new Promise<void>((r) => {
                  notifyFn = r;
                });
              }
              if (queue.length > 0) {
                const value = queue.shift()!;
                return { value, done: false };
              }
              return { value: undefined as unknown as A2ATask, done: true };
            },
            return(): Promise<IteratorResult<A2ATask>> {
              subs.delete(push);
              closed = true;
              if (notifyFn) {
                const n = notifyFn;
                notifyFn = null;
                n();
              }
              return Promise.resolve({ value: undefined as unknown as A2ATask, done: true });
            },
          };
        },
      };
    },
  };
}

// ─── Durable KV store ─────────────────────────────────────────────────────────

/**
 * A durable task store backed by any `RuntimeKvStore`.
 * Keys: `${prefix}task:${taskId}` → JSON-serialized A2ATask
 * Secondary contextId index: `${prefix}ctx:${contextId}:${taskId}` → `""` (key-only)
 *
 * Note: listing by contextId requires a full prefix scan. For Phase 3 this
 * is acceptable; Phase 5+ should add a dedicated index or Redis sorted sets.
 */
export function createDurableA2ATaskStore(kv: RuntimeKvStore, prefix = 'a2a:'): A2ATaskStore {
  const taskKey = (id: string) => `${prefix}task:${id}`;
  const ctxKey = (contextId: string, taskId: string) => `${prefix}ctx:${contextId}:${taskId}`;

  async function loadRaw(taskId: string): Promise<A2ATask | null> {
    const raw = await kv.get(taskKey(taskId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as A2ATask;
    } catch {
      return null;
    }
  }

  return {
    async save(task: A2ATask): Promise<void> {
      await kv.set(taskKey(task.id), JSON.stringify(task));
      // Maintain contextId → taskId index
      await kv.set(ctxKey(task.contextId, task.id), '');
    },

    async load(taskId: string): Promise<A2ATask | null> {
      return loadRaw(taskId);
    },

    async list(filter?: A2AListTasksFilter): Promise<A2ATaskPage> {
      let entries: { key: string; value: string }[];

      if (filter?.contextId) {
        // Use contextId index: list all `${prefix}ctx:${contextId}:` keys
        const ctxPrefix = `${prefix}ctx:${filter.contextId}:`;
        const ctxEntries = await kv.list(ctxPrefix);
        // Extract taskIds from keys and load
        const taskIds = ctxEntries.map((e) => e.key.slice(ctxPrefix.length));
        entries = [];
        for (const id of taskIds) {
          const raw = await kv.get(taskKey(id));
          if (raw) entries.push({ key: taskKey(id), value: raw });
        }
      } else {
        entries = [...(await kv.list(`${prefix}task:`))];
      }

      let items: A2ATask[] = [];
      for (const e of entries) {
        try {
          items.push(JSON.parse(e.value) as A2ATask);
        } catch {
          // skip corrupt entries
        }
      }

      if (filter?.state) {
        items = items.filter((t) => t.status.state === filter.state);
      }
      if (filter?.statusTimestampAfter) {
        items = items.filter((t) => t.status.timestamp > filter.statusTimestampAfter!);
      }

      items.sort((a, b) => b.status.timestamp.localeCompare(a.status.timestamp));

      const pageSize = filter?.pageSize ?? 50;
      const offset = filter?.pageToken ? parseInt(filter.pageToken, 10) : 0;
      const page = items.slice(offset, offset + pageSize);
      const nextOffset = offset + page.length;
      const nextPageToken = nextOffset < items.length ? String(nextOffset) : undefined;

      return { tasks: page, nextPageToken, totalSize: items.length };
    },

    async update(taskId: string, patch: A2ATaskStorePatch): Promise<A2ATask> {
      const existing = await loadRaw(taskId);
      if (!existing) throw new Error(`A2ATaskStore: task not found for update: ${taskId}`);
      const updated: A2ATask = {
        ...existing,
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.artifacts !== undefined && { artifacts: patch.artifacts }),
        ...(patch.history !== undefined && { history: patch.history }),
        ...(patch.metadata !== undefined && { metadata: { ...existing.metadata, ...patch.metadata } }),
      };
      await kv.set(taskKey(taskId), JSON.stringify(updated));
      return updated;
    },

    async delete(taskId: string): Promise<boolean> {
      const existing = await loadRaw(taskId);
      if (!existing) return false;
      await kv.delete(taskKey(taskId));
      await kv.delete(ctxKey(existing.contextId, taskId));
      return true;
    },

    // No subscribe on durable store (requires pub/sub, Phase 5+)
  };
}
