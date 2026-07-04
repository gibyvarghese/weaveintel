import { newUUIDv7 } from '@weaveintel/core';

export interface DeadLetterRecord {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly error: string;
  readonly firstFailedAt: string;
  readonly lastFailedAt: string;
  readonly retryCount: number;
  resolved: boolean;
}

export interface DeadLetterQueue {
  enqueue(record: Omit<DeadLetterRecord, 'id' | 'firstFailedAt' | 'lastFailedAt' | 'resolved'>): DeadLetterRecord;
  dequeue(id: string): boolean;
  list(filter?: { type?: string; resolved?: boolean }): readonly DeadLetterRecord[];
  retry(id: string, fn: (payload: unknown) => Promise<void>): Promise<boolean>;
  clear(): number;
}

export function createDeadLetterQueue(): DeadLetterQueue {
  const records = new Map<string, DeadLetterRecord>();

  return {
    enqueue(input): DeadLetterRecord {
      const now = new Date().toISOString();
      const record: DeadLetterRecord = {
        id: newUUIDv7(),
        type: input.type,
        payload: input.payload,
        error: input.error,
        retryCount: input.retryCount,
        firstFailedAt: now,
        lastFailedAt: now,
        resolved: false,
      };
      records.set(record.id, record);
      return record;
    },

    dequeue(id: string): boolean {
      const record = records.get(id);
      if (record === undefined) {
        return false;
      }
      record.resolved = true;
      return true;
    },

    list(filter?: { type?: string; resolved?: boolean }): readonly DeadLetterRecord[] {
      let results = Array.from(records.values());
      if (filter?.type !== undefined) {
        results = results.filter((r) => r.type === filter.type);
      }
      if (filter?.resolved !== undefined) {
        results = results.filter((r) => r.resolved === filter.resolved);
      }
      return results;
    },

    async retry(id: string, fn: (payload: unknown) => Promise<void>): Promise<boolean> {
      const record = records.get(id);
      if (record === undefined || record.resolved) {
        return false;
      }
      try {
        await fn(record.payload);
        record.resolved = true;
        return true;
      } catch {
        const updated: DeadLetterRecord = {
          ...record,
          retryCount: record.retryCount + 1,
          lastFailedAt: new Date().toISOString(),
          resolved: false,
        };
        records.set(id, updated);
        return false;
      }
    },

    clear(): number {
      let removed = 0;
      for (const [id, record] of records) {
        if (record.resolved) {
          records.delete(id);
          removed++;
        }
      }
      return removed;
    },
  };
}

// --- Phase 4: durable DLQ via runtime.persistence ---

import type { WeaveRuntime } from '@weaveintel/core';
import { weaveInMemoryPersistence } from '@weaveintel/core';

/**
 * Async DLQ contract used by `createDurableDeadLetterQueue` (Phase 4).
 * Every method is `Promise`-returning so the same surface works against
 * any `RuntimePersistenceSlot.kv` backend (in-memory, SQLite, Postgres,
 * Redis, etc.).
 */
export interface AsyncDeadLetterQueue {
  enqueue(record: Omit<DeadLetterRecord, 'id' | 'firstFailedAt' | 'lastFailedAt' | 'resolved'>): Promise<DeadLetterRecord>;
  dequeue(id: string): Promise<boolean>;
  list(filter?: { type?: string; resolved?: boolean }): Promise<readonly DeadLetterRecord[]>;
  retry(id: string, fn: (payload: unknown) => Promise<void>): Promise<boolean>;
  clear(): Promise<number>;
}

export interface DurableDeadLetterQueueOptions {
  /** When provided and `runtime.persistence` is configured, records survive
   *  process restarts. With no runtime — or a runtime without persistence —
   *  falls back to a process-local in-memory KV (same DX as the sync DLQ). */
  runtime?: WeaveRuntime;
  /** Key namespace under the runtime KV. Defaults to `'dlq'`. */
  namespace?: string;
}

/**
 * Durable, runtime-aware dead-letter queue (Phase 4 — Durability everywhere).
 *
 *   - Records are serialised to `${namespace}:${id}` in `runtime.persistence.kv`.
 *   - When no `runtime` (or no persistence slot) is supplied, falls back to a
 *     local `weaveInMemoryPersistence()` so the API works zero-config.
 *   - `list()` does a single prefix scan; callers filter in-memory.
 *
 * Drop-in upgrade for `createDeadLetterQueue()` when you want restart-safe
 * behavior — see `examples/125-durable-runtime.ts` for the wired path.
 */
export function createDurableDeadLetterQueue(
  opts: DurableDeadLetterQueueOptions = {},
): AsyncDeadLetterQueue {
  const namespace = opts.namespace ?? 'dlq';
  const slot = opts.runtime?.persistence ?? weaveInMemoryPersistence();
  const kv = slot.kv;
  const k = (id: string) => `${namespace}:${id}`;

  async function loadAll(): Promise<DeadLetterRecord[]> {
    const entries = await kv.list(`${namespace}:`);
    const out: DeadLetterRecord[] = [];
    for (const e of entries) {
      try { out.push(JSON.parse(e.value) as DeadLetterRecord); } catch { /* skip malformed row */ }
    }
    return out;
  }

  async function loadOne(id: string): Promise<DeadLetterRecord | undefined> {
    const raw = await kv.get(k(id));
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw) as DeadLetterRecord; } catch { return undefined; }
  }

  return {
    async enqueue(input) {
      const now = new Date().toISOString();
      const record: DeadLetterRecord = {
        id: newUUIDv7(),
        type: input.type,
        payload: input.payload,
        error: input.error,
        retryCount: input.retryCount,
        firstFailedAt: now,
        lastFailedAt: now,
        resolved: false,
      };
      await kv.set(k(record.id), JSON.stringify(record));
      return record;
    },

    async dequeue(id) {
      const record = await loadOne(id);
      if (!record) return false;
      const updated: DeadLetterRecord = { ...record, resolved: true };
      await kv.set(k(id), JSON.stringify(updated));
      return true;
    },

    async list(filter) {
      let results = await loadAll();
      if (filter?.type !== undefined) results = results.filter((r) => r.type === filter.type);
      if (filter?.resolved !== undefined) results = results.filter((r) => r.resolved === filter.resolved);
      return results;
    },

    async retry(id, fn) {
      const record = await loadOne(id);
      if (!record || record.resolved) return false;
      try {
        await fn(record.payload);
        await kv.set(k(id), JSON.stringify({ ...record, resolved: true } satisfies DeadLetterRecord));
        return true;
      } catch {
        const updated: DeadLetterRecord = {
          ...record,
          retryCount: record.retryCount + 1,
          lastFailedAt: new Date().toISOString(),
          resolved: false,
        };
        await kv.set(k(id), JSON.stringify(updated));
        return false;
      }
    },

    async clear() {
      const all = await loadAll();
      let removed = 0;
      for (const r of all) {
        if (r.resolved) {
          if (await kv.delete(k(r.id))) removed++;
        }
      }
      return removed;
    },
  };
}
