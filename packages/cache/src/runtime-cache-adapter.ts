/**
 * Phase 7 — `RuntimeCacheSlot` adapter for `@weaveintel/cache`.
 *
 * `createRuntimeCacheAdapter(store, semanticCache?)` wraps an in-memory or
 * durable `CacheStore` (plus an optional `SemanticCache`) into the single
 * `RuntimeCacheSlot` shape that `weaveRuntime({ cache })` expects.
 *
 * Pass the result directly to `weaveRuntime`. All subsystems (chat path,
 * live-agent handlers, tools) then share the same warm cache through the DI
 * chain without each creating a private `weaveInMemoryCacheStore()` instance.
 *
 * Usage:
 *   const cache = createRuntimeCacheAdapter(weaveInMemoryCacheStore());
 *   const runtime = weaveRuntime({ ..., cache });
 */

import type { RuntimeCacheSlot } from '@weaveintel/core';
import type { CacheStore, SemanticCache, CacheMetrics } from '@weaveintel/core';

export function createRuntimeCacheAdapter(
  store: CacheStore,
  semanticCache?: SemanticCache,
  metrics?: CacheMetrics,
): RuntimeCacheSlot {
  return {
    async get(key) {
      return store.get(key);
    },

    async set(key, value, ttlMs) {
      return store.set(key, value, ttlMs);
    },

    async invalidate(key) {
      return store.delete(key);
    },

    async semanticGet(query, semOpts) {
      if (!semanticCache) return null;
      try {
        const hit = await semanticCache.find(query, { scope: semOpts?.scope, threshold: semOpts?.threshold });
        return hit ? hit.response : null;
      } catch {
        return null;
      }
    },

    store,
    semanticStore: semanticCache,
    metrics,
  };
}
