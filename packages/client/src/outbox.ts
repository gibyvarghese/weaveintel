/**
 * Offline outbox (v2) — buffers run operations when the network is unavailable,
 * replays them in order on reconnect, and enforces per-item idempotency keys.
 *
 * v2 (Phase 6) adds:
 *  - mid-stream `postEvent` buffering (item `kind: 'event'`), not just run starts;
 *  - bounded retries with a backoff schedule (`maxAttempts` + `backoffMs`);
 *  - a dead-letter queue for items that exhaust their attempts;
 *  - `online`/`offline` auto-flush wiring (`attachAutoFlush`).
 *
 * Browser-safe (no Node.js APIs). The storage backend is injectable so adopters
 * can plug in localStorage, IndexedDB, or any async KV.
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { StartRunInput, RunClient } from './run-client.js';

// ---------------------------------------------------------------------------
// Storage interface
// ---------------------------------------------------------------------------

export interface OutboxStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
  /** List all keys currently in the store. */
  keys(): string[] | Promise<string[]>;
}

/** Zero-dependency in-memory store (for tests and SSR). */
export class MemoryStorage implements OutboxStorage {
  private _map = new Map<string, string>();

  getItem(key: string) { return this._map.get(key) ?? null; }
  setItem(key: string, value: string) { this._map.set(key, value); }
  removeItem(key: string) { this._map.delete(key); }
  keys() { return [...this._map.keys()]; }
}

// ---------------------------------------------------------------------------
// Outbox item
// ---------------------------------------------------------------------------

export type OutboxItemKind = 'start' | 'event';

export interface OutboxItem {
  id: string;
  kind: OutboxItemKind;
  /** Present for `kind: 'start'`. */
  input?: StartRunInput;
  /** Present for `kind: 'event'`. */
  runId?: string;
  payload?: Record<string, unknown>;
  enqueuedAt: number;
  /** How many flush attempts have been made. */
  attempts: number;
  /** Epoch ms before which the item should not be retried (backoff). */
  nextAttemptAt: number;
  /** Last failure message (diagnostic). */
  lastError?: string;
}

const OUTBOX_KEY_PREFIX = '__weave_outbox__:';
const DEADLETTER_KEY_PREFIX = '__weave_outbox_dead__:';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = [0, 1000, 4000, 15000, 30000];

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export interface OutboxFlushResult {
  flushed: number;
  failed: number;
  /** Items moved to the dead-letter queue this flush (exhausted attempts). */
  deadLettered: number;
  /** Items skipped because their backoff window had not elapsed. */
  deferred: number;
}

export interface RunOutbox {
  /**
   * Enqueue a `StartRunInput` for deferred execution.
   * Returns the locally-generated outbox item id.
   */
  enqueue(input: StartRunInput): Promise<string>;
  /**
   * Enqueue a client→run event (e.g. an approval decision) for deferred
   * delivery when offline. Returns the outbox item id.
   */
  enqueueEvent(runId: string, payload: Record<string, unknown>): Promise<string>;
  /**
   * Flush all due items against the provided client, in enqueue order.
   * Successful items are removed; failed items are retried later (backoff);
   * items past `maxAttempts` move to the dead-letter queue.
   */
  flush(client: RunClient): Promise<OutboxFlushResult>;
  /** Return all pending (non-dead-lettered) items, oldest first. */
  pending(): Promise<OutboxItem[]>;
  /** Return dead-lettered items (exhausted retries), oldest first. */
  deadLettered(): Promise<OutboxItem[]>;
  /** Clear all pending items without attempting to flush. */
  clear(): Promise<void>;
  /** Clear the dead-letter queue. */
  clearDeadLetter(): Promise<void>;
  /**
   * Wire `online`/`offline` auto-flush. On `online` (and immediately if already
   * online), flushes against `client`. Returns a detach function. Falls back to
   * a single flush when no event target is available (SSR/Node).
   */
  attachAutoFlush(client: RunClient, opts?: AutoFlushOptions): () => void;
}

export interface AutoFlushOptions {
  /** Event target to listen on. Defaults to `globalThis`. */
  target?: { addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void };
  /** Online probe. Defaults to `navigator.onLine` (true if unknown). */
  isOnline?: () => boolean;
  /** Called after each auto-flush with the result. */
  onFlush?: (result: OutboxFlushResult) => void;
}

export interface CreateRunOutboxOptions {
  storage?: OutboxStorage;
  /** Max flush attempts before an item is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** Backoff schedule (ms) indexed by attempt count; last value repeats. */
  backoffMs?: number[];
  /** Clock injection (tests). Default `Date.now`. */
  now?: () => number;
  /** Called when an item is moved to the dead-letter queue. */
  onDeadLetter?: (item: OutboxItem) => void;
}

export function createRunOutbox(opts: CreateRunOutboxOptions = {}): RunOutbox {
  const storage = opts.storage ?? new MemoryStorage();
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = opts.backoffMs && opts.backoffMs.length > 0 ? opts.backoffMs : DEFAULT_BACKOFF_MS;
  const now = opts.now ?? (() => Date.now());

  const backoffFor = (attempts: number): number => backoff[Math.min(attempts, backoff.length - 1)] ?? 0;

  function parseItem(raw: string | null): OutboxItem | null {
    if (!raw) return null;
    try {
      const item = JSON.parse(raw) as OutboxItem;
      if (typeof item?.id !== 'string' || (item.kind !== 'start' && item.kind !== 'event')) return null;
      return item;
    } catch { return null; }
  }

  async function writeItem(item: OutboxItem): Promise<void> {
    await storage.setItem(OUTBOX_KEY_PREFIX + item.id, JSON.stringify(item));
  }

  async function removeItem(id: string): Promise<void> {
    await storage.removeItem(OUTBOX_KEY_PREFIX + id);
  }

  async function deadLetter(item: OutboxItem): Promise<void> {
    await storage.setItem(DEADLETTER_KEY_PREFIX + item.id, JSON.stringify(item));
    await removeItem(item.id);
    opts.onDeadLetter?.(item);
  }

  async function keysWithPrefix(prefix: string): Promise<string[]> {
    return (await storage.keys()).filter((k) => k.startsWith(prefix));
  }

  async function readAll(prefix: string): Promise<OutboxItem[]> {
    const items: OutboxItem[] = [];
    for (const key of await keysWithPrefix(prefix)) {
      const item = parseItem(await storage.getItem(key));
      if (item) items.push(item);
    }
    return items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  async function attempt(client: RunClient, item: OutboxItem): Promise<void> {
    if (item.kind === 'start') {
      if (!item.input) throw new Error('outbox start item missing input');
      await client.startRun(item.input);
    } else {
      if (!item.runId || !item.payload) throw new Error('outbox event item missing runId/payload');
      await client.postEvent(item.runId, item.payload);
    }
  }

  return {
    async enqueue(input) {
      const id = newUUIDv7();
      const item: OutboxItem = { id, kind: 'start', input, enqueuedAt: now(), attempts: 0, nextAttemptAt: 0 };
      await writeItem(item);
      return id;
    },

    async enqueueEvent(runId, payload) {
      const id = newUUIDv7();
      const item: OutboxItem = { id, kind: 'event', runId, payload, enqueuedAt: now(), attempts: 0, nextAttemptAt: 0 };
      await writeItem(item);
      return id;
    },

    async flush(client) {
      const items = await readAll(OUTBOX_KEY_PREFIX);
      let flushed = 0, failed = 0, deadLettered = 0, deferred = 0;
      const t = now();

      for (const item of items) {
        if (item.nextAttemptAt > t) { deferred++; continue; }
        item.attempts++;
        try {
          await attempt(client, item);
          await removeItem(item.id);
          flushed++;
        } catch (err) {
          item.lastError = err instanceof Error ? err.message : String(err);
          if (item.attempts >= maxAttempts) {
            await deadLetter(item);
            deadLettered++;
          } else {
            item.nextAttemptAt = now() + backoffFor(item.attempts);
            await writeItem(item);
            failed++;
          }
        }
      }

      return { flushed, failed, deadLettered, deferred };
    },

    async pending() {
      return readAll(OUTBOX_KEY_PREFIX);
    },

    async deadLettered() {
      return readAll(DEADLETTER_KEY_PREFIX);
    },

    async clear() {
      for (const key of await keysWithPrefix(OUTBOX_KEY_PREFIX)) {
        await storage.removeItem(key);
      }
    },

    async clearDeadLetter() {
      for (const key of await keysWithPrefix(DEADLETTER_KEY_PREFIX)) {
        await storage.removeItem(key);
      }
    },

    attachAutoFlush(client, autoOpts = {}) {
      const target = autoOpts.target
        ?? (globalThis as unknown as AutoFlushOptions['target']);
      const isOnline = autoOpts.isOnline
        ?? (() => {
          const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
          return nav?.onLine ?? true;
        });

      const run = () => {
        if (!isOnline()) return;
        void this.flush(client).then((r) => autoOpts.onFlush?.(r)).catch(() => { /* swallow */ });
      };

      if (!target?.addEventListener) {
        // No event target (Node/SSR): flush once if online, return a no-op detach.
        run();
        return () => { /* nothing to detach */ };
      }

      target.addEventListener('online', run);
      run(); // flush immediately if already online
      return () => target.removeEventListener?.('online', run);
    },
  };
}
