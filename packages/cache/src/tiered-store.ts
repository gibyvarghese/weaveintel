/**
 * @weaveintel/cache — Tiered (multi-level) CacheStore.
 *
 * Phase 1: composes a fast in-process L1 (`weaveInMemoryCacheStore`) with a
 * shared distributed L2 (`weaveRedisCacheStore`) into a single `CacheStore`:
 *
 *   get    → L1 hit returns immediately; on L1 miss, read L2 and back-fill L1
 *            (with a short `l1TtlMs` cap so L1 never serves very stale data).
 *   set    → write-through to both tiers (L1 capped at `l1TtlMs`).
 *   delete → fan-out to both tiers.
 *   clear  → fan-out to both tiers.
 *   size   → reports the L2 (authoritative, cluster-wide) size when available.
 *
 * Callers keep talking to the plain `CacheStore` interface — the chat path,
 * live-agent handlers, and tools are unchanged. The result is also a
 * `ScannableCacheStore` (delegating to L2 for cluster-wide prefix invalidation)
 * and closable (closes L2).
 */

import type { CacheStore, ScannableCacheStore } from '@weaveintel/core';
import { isScannableCacheStore } from '@weaveintel/core';

export interface TieredCacheStoreOptions {
  /**
   * Max TTL applied to L1 back-fills / writes (ms). Keeps L1 entries short-lived
   * so a stale local copy can't outlive an L2 invalidation by long. `0` means
   * "use the caller's TTL unchanged". Default 30_000 (30s).
   */
  l1TtlMs?: number;
}

export type TieredCacheStore = ScannableCacheStore & { close(): Promise<void> };

export function weaveTieredCacheStore(
  l1: CacheStore,
  l2: CacheStore,
  opts: TieredCacheStoreOptions = {},
): TieredCacheStore {
  const l1Cap = opts.l1TtlMs ?? 30_000;

  /** TTL to use when writing to L1 — the smaller of the caller's TTL and the L1 cap. */
  function l1Ttl(ttlMs?: number): number | undefined {
    if (!l1Cap) return ttlMs;
    if (!ttlMs) return l1Cap;
    return Math.min(ttlMs, l1Cap);
  }

  const l2Scannable = isScannableCacheStore(l2) ? l2 : null;

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const local = await l1.get<T>(key);
      if (local !== null) return local;
      const remote = await l2.get<T>(key);
      if (remote !== null) {
        // Back-fill L1 so subsequent reads on this replica are fast.
        await l1.set(key, remote, l1Ttl());
        return remote;
      }
      return null;
    },

    async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
      // Write-through: L2 is the shared source of truth, L1 is a short-lived cache.
      await Promise.all([l1.set(key, value, l1Ttl(ttlMs)), l2.set(key, value, ttlMs)]);
    },

    async delete(key: string): Promise<void> {
      await Promise.all([l1.delete(key), l2.delete(key)]);
    },

    async has(key: string): Promise<boolean> {
      if (await l1.has(key)) return true;
      return l2.has(key);
    },

    async clear(scope?: string): Promise<void> {
      await Promise.all([l1.clear(scope), l2.clear(scope)]);
    },

    async size(): Promise<number> {
      // L2 is the cluster-wide truth; fall back to L1 if L2 errors.
      try {
        return await l2.size();
      } catch {
        return l1.size();
      }
    },

    async keys(prefix?: string): Promise<string[]> {
      if (l2Scannable) return l2Scannable.keys(prefix);
      if (isScannableCacheStore(l1)) return l1.keys(prefix);
      return [];
    },

    async deleteByPrefix(prefix: string): Promise<number> {
      // Invalidate the cluster-wide L2 first (authoritative), then the local L1.
      let removed = 0;
      if (l2Scannable) removed = await l2Scannable.deleteByPrefix(prefix);
      if (isScannableCacheStore(l1)) await l1.deleteByPrefix(prefix);
      return removed;
    },

    async close(): Promise<void> {
      const maybeClose = (s: CacheStore): Promise<void> => {
        const closer = (s as { close?: () => Promise<void> }).close;
        return typeof closer === 'function' ? closer.call(s) : Promise.resolve();
      };
      await Promise.all([maybeClose(l1), maybeClose(l2)]);
    },
  };
}
