/**
 * @weaveintel/cache — Cache observability.
 *
 * `createCacheMetrics()` is an in-process counter sink implementing the core
 * `CacheMetrics` contract. `withMetrics(store, metrics)` wraps ANY `CacheStore`
 * (in-memory, Redis, tiered) so its lookups/writes feed the response-cache
 * counters automatically — a reusable, storage-agnostic decorator. The chat
 * path feeds prompt-cache token savings via `recordPromptCache`.
 *
 * `estimatePromptCacheSavingsUsd` converts cached-read input tokens into an
 * estimated dollar saving using the provider's cache-read discount.
 */

import type {
  CacheStore,
  ScannableCacheStore,
  CacheMetrics,
  CacheStatsSnapshot,
} from '@weaveintel/core';
import { isScannableCacheStore } from '@weaveintel/core';

/**
 * Provider cache-read discount (fraction of the input rate that is *saved* on a
 * cache hit). Anthropic reads at 0.1× input (90% off); OpenAI's automatic cache
 * is ~50% off; Gemini implicit caching is ~75% off. Conservative default 0.5.
 */
const PROMPT_CACHE_READ_DISCOUNT: Record<string, number> = {
  anthropic: 0.9,
  openai: 0.5,
  google: 0.75,
};

/** Estimated USD saved by serving `readTokens` from the provider prompt cache. */
export function estimatePromptCacheSavingsUsd(
  provider: string,
  readTokens: number,
  inputCostPer1M: number,
): number {
  if (!readTokens || !inputCostPer1M) return 0;
  const discount = PROMPT_CACHE_READ_DISCOUNT[provider] ?? 0.5;
  return (readTokens / 1_000_000) * inputCostPer1M * discount;
}

/** Create an in-process cache metrics sink. */
export function createCacheMetrics(opts?: { startedAt?: string }): CacheMetrics {
  const startedAt = opts?.startedAt ?? new Date().toISOString();
  let hits = 0, misses = 0, sets = 0, evictions = 0;
  let turns = 0, cacheReadTokens = 0, cacheWriteTokens = 0, estCostSavedUsd = 0;

  return {
    onHit() { hits++; },
    onMiss() { misses++; },
    onSet() { sets++; },
    onEvict() { evictions++; },
    recordPromptCache(delta) {
      turns++;
      cacheReadTokens += Math.max(0, delta.readTokens || 0);
      cacheWriteTokens += Math.max(0, delta.writeTokens || 0);
      estCostSavedUsd += Math.max(0, delta.costSavedUsd || 0);
    },
    snapshot(): CacheStatsSnapshot {
      const lookups = hits + misses;
      return {
        responseCache: {
          hits, misses, sets, evictions,
          hitRate: lookups > 0 ? hits / lookups : 0,
        },
        promptCache: { turns, cacheReadTokens, cacheWriteTokens, estCostSavedUsd },
        startedAt,
      };
    },
    reset() {
      hits = misses = sets = evictions = 0;
      turns = cacheReadTokens = cacheWriteTokens = 0;
      estCostSavedUsd = 0;
    },
  };
}

/**
 * Wrap a `CacheStore` so reads/writes feed a `CacheMetrics` sink:
 *   - `get` → `onHit()` when a value is returned, `onMiss()` otherwise;
 *   - `set` → `onSet()`.
 * Eviction counting is driven by the underlying store's `onEvict` hook (wire it
 * to `metrics.onEvict` at construction), since evictions happen inside the store.
 *
 * All other methods (incl. optional `keys`/`deleteByPrefix`/`close` for
 * scannable/closable stores) are forwarded unchanged, preserving the store's
 * capabilities so the wrapper stays a drop-in replacement.
 */
export function withMetrics(store: CacheStore, metrics: CacheMetrics): CacheStore {
  const wrapped: CacheStore = {
    async get<T = unknown>(key: string): Promise<T | null> {
      const value = await store.get<T>(key);
      if (value !== null && value !== undefined) metrics.onHit();
      else metrics.onMiss();
      return value;
    },
    async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
      await store.set(key, value, ttlMs);
      metrics.onSet();
    },
    delete: (key) => store.delete(key),
    has: (key) => store.has(key),
    clear: (scope) => store.clear(scope),
    size: () => store.size(),
  };

  // Preserve scannable capability (tiered / Redis) so isScannableCacheStore holds.
  if (isScannableCacheStore(store)) {
    (wrapped as ScannableCacheStore).keys = (prefix) => store.keys(prefix);
    (wrapped as ScannableCacheStore).deleteByPrefix = (prefix) => store.deleteByPrefix(prefix);
  }
  // Preserve closability.
  const closable = store as { close?: () => Promise<void> };
  if (typeof closable.close === 'function') {
    (wrapped as { close?: () => Promise<void> }).close = () => closable.close!();
  }
  return wrapped;
}
