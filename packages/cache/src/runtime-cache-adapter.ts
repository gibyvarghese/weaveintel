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
import type { CacheStore, SemanticCache } from '@weaveintel/core';

export function createRuntimeCacheAdapter(
  store: CacheStore,
  semanticCache?: SemanticCache,
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

    async semanticGet(embedding, threshold) {
      if (!semanticCache) return null;
      // SemanticCache.find() searches by query string, not raw embedding.
      // We store the embedding as a JSON key so semantic lookup still works
      // when the same embedding is passed again. This is a best-effort
      // wrapper — callers with access to the original query string should use
      // `semanticStore.find(query, threshold)` directly.
      const embeddingKey = JSON.stringify(embedding.slice(0, 8)); // prefix key
      try {
        return await semanticCache.find(embeddingKey, threshold ?? 0.92);
      } catch {
        return null;
      }
    },

    store,
    semanticStore: semanticCache,
  };
}
