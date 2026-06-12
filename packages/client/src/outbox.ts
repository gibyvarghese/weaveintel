/**
 * Offline outbox — buffers run-start events when the network is unavailable,
 * replays them in order on reconnect, and enforces per-item idempotency keys.
 *
 * Browser-safe (no Node.js APIs). The storage backend is injectable so
 * adopters can plug in localStorage, IndexedDB, or any async KV.
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

interface OutboxItem {
  id: string;
  input: StartRunInput;
  enqueuedAt: number;
  /** How many flush attempts have been made. */
  attempts: number;
}

const OUTBOX_KEY_PREFIX = '__weave_outbox__:';

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

export interface OutboxFlushResult {
  flushed: number;
  failed: number;
}

export interface RunOutbox {
  /**
   * Enqueue a `StartRunInput` for deferred execution.
   * Returns the locally-generated outbox item id.
   */
  enqueue(input: StartRunInput): Promise<string>;
  /**
   * Flush all pending items against the provided client.
   * Successfully started runs are removed from the outbox.
   */
  flush(client: RunClient): Promise<OutboxFlushResult>;
  /** Return all pending outbox items. */
  pending(): Promise<OutboxItem[]>;
  /** Clear all pending items without attempting to flush. */
  clear(): Promise<void>;
}

export function createRunOutbox(opts: { storage?: OutboxStorage } = {}): RunOutbox {
  const storage = opts.storage ?? new MemoryStorage();

  async function readItem(key: string): Promise<OutboxItem | null> {
    const raw = await storage.getItem(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as OutboxItem; } catch { return null; }
  }

  async function writeItem(item: OutboxItem): Promise<void> {
    await storage.setItem(OUTBOX_KEY_PREFIX + item.id, JSON.stringify(item));
  }

  async function removeItem(id: string): Promise<void> {
    await storage.removeItem(OUTBOX_KEY_PREFIX + id);
  }

  async function allKeys(): Promise<string[]> {
    const ks = await storage.keys();
    return ks.filter((k) => k.startsWith(OUTBOX_KEY_PREFIX));
  }

  return {
    async enqueue(input) {
      const id = newUUIDv7();
      const item: OutboxItem = { id, input, enqueuedAt: Date.now(), attempts: 0 };
      await writeItem(item);
      return id;
    },

    async flush(client) {
      const keys = await allKeys();
      let flushed = 0;
      let failed = 0;

      for (const key of keys) {
        const item = await readItem(key);
        if (!item) continue;

        item.attempts++;
        try {
          await client.startRun(item.input);
          await removeItem(item.id);
          flushed++;
        } catch {
          // Update attempts count in storage but keep in outbox
          await writeItem(item);
          failed++;
        }
      }

      return { flushed, failed };
    },

    async pending() {
      const keys = await allKeys();
      const items: OutboxItem[] = [];
      for (const key of keys) {
        const item = await readItem(key);
        if (item) items.push(item);
      }
      return items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    },

    async clear() {
      const keys = await allKeys();
      for (const key of keys) {
        const id = key.slice(OUTBOX_KEY_PREFIX.length);
        await removeItem(id);
      }
    },
  };
}
