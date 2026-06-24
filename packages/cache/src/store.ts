/**
 * @weaveintel/cache — CacheStore implementations
 *
 * In-memory cache store with TTL support, bounded capacity, and pluggable
 * eviction. Production deployments can use the same CacheStore interface with
 * Redis, Memcached, etc.
 *
 * Phase 0 hardening:
 *   - Bounded by `maxEntries` and/or `maxBytes` (was previously unbounded —
 *     an in-memory leak / DoS surface).
 *   - Eviction policy: `lru` (default), `lfu`, or `fifo`.
 *   - Expired entries are pruned lazily on access and opportunistically on
 *     write, so dead entries never pin memory indefinitely.
 *   - Optional `onEvict` hook for metrics / observability (Phase 3).
 */

import type { ScannableCacheStore } from '@weaveintel/core';

/** Reason an entry left the store — surfaced to `onEvict`. */
export type CacheEvictReason = 'capacity' | 'bytes' | 'ttl' | 'manual';

/**
 * Eviction strategy when the store is over capacity (G‑6):
 *   - `lru`     least-recently-used (default)
 *   - `lfu`     least-frequently-used
 *   - `fifo`    first-in, first-out (no reorder on read)
 *   - `tinylfu` LFU admission with LRU tie-break among the least-frequent —
 *     approximates W‑TinyLFU's "keep the frequently-useful, drop the cold".
 *   - `gdsf`    Greedy-Dual-Size-Frequency, **cost-aware**: priority
 *     `H = clock + freq·cost/bytes`; the lowest-H entry is evicted, so
 *     cheap-to-recompute / large / cold entries go first and expensive
 *     (high-`cost`) entries are retained. Supply `costOf` to weight by token
 *     cost; without it `cost` defaults to 1 (size-aware behaviour).
 */
export type CacheEvictionPolicy = 'lru' | 'lfu' | 'fifo' | 'tinylfu' | 'gdsf';

export interface InMemoryCacheStoreOptions {
  /**
   * Maximum number of live entries. When exceeded, entries are evicted per
   * `evictionPolicy`. `0` means unbounded (not recommended). Default 10_000.
   */
  maxEntries?: number;
  /**
   * Approximate maximum total bytes (key + JSON-encoded value). `0` disables
   * the byte cap. Default 0.
   */
  maxBytes?: number;
  /** Eviction strategy when over capacity. Default `'lru'`. */
  evictionPolicy?: CacheEvictionPolicy;
  /**
   * Cost weight for the `gdsf` policy — the (relative) expense of recomputing a
   * value (e.g. its token cost). Higher cost ⇒ less likely to be evicted.
   * Defaults to `1` for every entry (so `gdsf` degrades to size/frequency-aware).
   */
  costOf?: (value: unknown) => number;
  /** Observability hook fired whenever an entry is removed. */
  onEvict?: (key: string, reason: CacheEvictReason) => void;
}

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number | null;
  /** Access frequency — used by `lfu` / `tinylfu` / `gdsf`. */
  freq: number;
  /** Approximate byte footprint of this entry (key + value). */
  bytes: number;
  /** Recency tick (monotonic) — used by `tinylfu` tie-break. */
  lastAccess: number;
  /** Recompute cost weight — used by the cost-aware `gdsf` policy. */
  cost: number;
  scope?: string;
}

/** Default entry cap so the store is safe-by-default (was previously unbounded). */
export const DEFAULT_CACHE_MAX_ENTRIES = 10_000;

function estimateBytes(key: string, value: unknown): number {
  let valueLen = 0;
  try {
    const json = JSON.stringify(value);
    valueLen = json ? json.length : 0;
  } catch {
    valueLen = 64; // non-serialisable — rough fixed estimate
  }
  // UTF-16 length is a close-enough proxy for a memory bound.
  return key.length + valueLen + 32; // +32 for per-entry bookkeeping overhead
}

/**
 * In-memory CacheStore with TTL, bounded capacity, and pluggable eviction.
 *
 * The backing `Map` preserves insertion order; for `lru` the written/read key
 * is re-inserted (moved to the most-recent position) so the oldest key sits at
 * the iteration front and is evicted first. `fifo` never reorders on read;
 * `lfu` evicts the lowest access frequency.
 */
export function weaveInMemoryCacheStore(opts: InMemoryCacheStoreOptions = {}): ScannableCacheStore {
  const data = new Map<string, CacheEntry>();
  const maxEntries = opts.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  const maxBytes = opts.maxBytes ?? 0;
  const policy = opts.evictionPolicy ?? 'lru';
  const costOf = opts.costOf;
  const onEvict = opts.onEvict;
  let totalBytes = 0;
  let tick = 0;          // monotonic recency counter (tinylfu tie-break)
  let gdsfClock = 0;     // GDSF aging term — raised to the last victim's priority

  function isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt !== null && Date.now() > entry.expiresAt;
  }

  function remove(key: string, entry: CacheEntry, reason: CacheEvictReason): void {
    data.delete(key);
    totalBytes -= entry.bytes;
    if (totalBytes < 0) totalBytes = 0;
    onEvict?.(key, reason);
  }

  /** Drop all currently-expired entries. */
  function pruneExpired(): void {
    for (const [key, entry] of data) {
      if (isExpired(entry)) remove(key, entry, 'ttl');
    }
  }

  /** GDSF priority: higher = more valuable = evicted later. */
  function gdsfPriority(e: CacheEntry): number {
    return gdsfClock + (e.freq * e.cost) / Math.max(1, e.bytes);
  }

  /** Pick and remove a single victim per the configured policy. */
  function evictOne(reason: CacheEvictReason): void {
    if (data.size === 0) return;
    let victimKey: string | undefined;
    if (policy === 'lfu') {
      let minFreq = Infinity;
      for (const [k, e] of data) {
        if (e.freq < minFreq) { minFreq = e.freq; victimKey = k; }
      }
    } else if (policy === 'tinylfu') {
      // Least-frequent, tie-broken by least-recently-accessed (drop cold entries
      // the workload no longer reuses, keep the frequently-useful ones).
      let minFreq = Infinity, oldest = Infinity;
      for (const [k, e] of data) {
        if (e.freq < minFreq || (e.freq === minFreq && e.lastAccess < oldest)) {
          minFreq = e.freq; oldest = e.lastAccess; victimKey = k;
        }
      }
    } else if (policy === 'gdsf') {
      // Lowest priority H = clock + freq·cost/bytes — cheap/large/cold first.
      let minH = Infinity;
      for (const [k, e] of data) {
        const h = gdsfPriority(e);
        if (h < minH) { minH = h; victimKey = k; }
      }
      if (victimKey !== undefined) gdsfClock = minH; // age the clock to the victim's H
    } else {
      // lru & fifo: the front of the Map is the oldest (least-recently written,
      // and for lru also least-recently read since reads re-insert).
      victimKey = data.keys().next().value as string | undefined;
    }
    if (victimKey !== undefined) {
      const entry = data.get(victimKey)!;
      remove(victimKey, entry, reason);
    }
  }

  /** Enforce entry- and byte-caps, pruning expired entries first. */
  function enforceCapacity(): void {
    const overEntries = maxEntries > 0 && data.size > maxEntries;
    const overBytes = maxBytes > 0 && totalBytes > maxBytes;
    if (overEntries || overBytes) pruneExpired();
    if (maxEntries > 0) {
      while (data.size > maxEntries) evictOne('capacity');
    }
    if (maxBytes > 0) {
      while (totalBytes > maxBytes && data.size > 0) evictOne('bytes');
    }
  }

  /** Move a key to the most-recent position (lru) / bump frequency + recency. */
  function touch(key: string, entry: CacheEntry): void {
    entry.freq++;
    entry.lastAccess = ++tick;
    if (policy === 'lru') {
      data.delete(key);
      data.set(key, entry);
    }
  }

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const entry = data.get(key);
      if (!entry) return null;
      if (isExpired(entry)) {
        remove(key, entry, 'ttl');
        return null;
      }
      touch(key, entry);
      return entry.value as T;
    },

    async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
      const existing = data.get(key);
      const bytes = estimateBytes(key, value);
      if (existing) {
        totalBytes -= existing.bytes;
        data.delete(key); // re-insert below to refresh ordering
      }
      let cost = 1;
      if (costOf) { try { const c = costOf(value); if (Number.isFinite(c) && c > 0) cost = c; } catch { /* default 1 */ } }
      const entry: CacheEntry<T> = {
        value,
        expiresAt: ttlMs ? Date.now() + ttlMs : null,
        freq: existing ? existing.freq + 1 : 1,
        bytes,
        lastAccess: ++tick,
        cost,
      };
      data.set(key, entry as CacheEntry);
      totalBytes += bytes;
      enforceCapacity();
    },

    async delete(key: string): Promise<void> {
      const entry = data.get(key);
      if (entry) remove(key, entry, 'manual');
    },

    async has(key: string): Promise<boolean> {
      const entry = data.get(key);
      if (!entry) return false;
      if (isExpired(entry)) {
        remove(key, entry, 'ttl');
        return false;
      }
      return true;
    },

    async clear(scope?: string): Promise<void> {
      if (!scope) {
        data.clear();
        totalBytes = 0;
        return;
      }
      for (const [key, entry] of data) {
        if (entry.scope === scope || key.startsWith(scope + ':')) {
          remove(key, entry, 'manual');
        }
      }
    },

    async size(): Promise<number> {
      pruneExpired();
      return data.size;
    },

    async keys(prefix?: string): Promise<string[]> {
      pruneExpired();
      const out: string[] = [];
      for (const key of data.keys()) {
        if (!prefix || key.startsWith(prefix)) out.push(key);
      }
      return out;
    },

    async deleteByPrefix(prefix: string): Promise<number> {
      let removed = 0;
      for (const [key, entry] of data) {
        if (key.startsWith(prefix)) {
          remove(key, entry, 'manual');
          removed++;
        }
      }
      return removed;
    },
  };
}
