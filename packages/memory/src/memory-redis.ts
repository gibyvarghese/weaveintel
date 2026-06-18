/** Redis-backed durable memory store. */

import type { ExecutionContext, MemoryEntry } from '@weaveintel/core';
import { createClient } from 'redis';
import { type DurableMemoryStore, applyMemoryQuery, parseStoredMemoryRow } from './memory-internal.js';

export function weaveRedisMemoryStore(opts: { url: string; keyPrefix?: string }): DurableMemoryStore {
  const client = createClient({ url: opts.url });
  const keyPrefix = opts.keyPrefix ?? 'weave:memory';

  async function ensureOpen(): Promise<void> {
    if (!client.isOpen) {
      await client.connect();
    }
  }

  function entryKey(id: string): string {
    return `${keyPrefix}:entry:${id}`;
  }

  return {
    async write(_ctx, entries): Promise<void> {
      await ensureOpen();
      const multi = client.multi();
      for (const entry of entries) {
        multi.set(entryKey(entry.id), JSON.stringify(entry));
      }
      await multi.exec();
    },
    async query(_ctx, options): Promise<MemoryEntry[]> {
      await ensureOpen();
      const keys = await client.keys(`${keyPrefix}:entry:*`);
      if (keys.length === 0) {
        return [];
      }
      const values = await client.mGet(keys);
      const rows = values
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .map((value) => parseStoredMemoryRow(value));
      return applyMemoryQuery(rows, options);
    },
    async delete(_ctx, ids): Promise<void> {
      await ensureOpen();
      if (ids.length === 0) return;
      await client.del(ids.map((id) => entryKey(id)));
    },
    async clear(ctx: ExecutionContext, filter): Promise<void> {
      // L-25: When no filter is provided, delete all entry keys with KEYS pattern
      // instead of fetching all values into memory first.
      if (!filter) {
        await ensureOpen();
        const keys = await client.keys(`${keyPrefix}:entry:*`);
        if (keys.length > 0) await client.del(keys);
        return;
      }
      // Filtered clear: still needs value inspection to apply filter predicates.
      const rows = await this.query(ctx, { filter, topK: Number.MAX_SAFE_INTEGER });
      await this.delete(ctx, rows.map((row) => row.id));
    },
    async close(): Promise<void> {
      if (client.isOpen) {
        await client.quit();
      }
    },
  };
}
