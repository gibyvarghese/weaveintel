// SPDX-License-Identifier: MIT
/**
 * @weaveintel/cache — Public API
 */

export { weaveInMemoryCacheStore, DEFAULT_CACHE_MAX_ENTRIES } from './store.js';
export type {
  InMemoryCacheStoreOptions,
  CacheEvictReason,
  CacheEvictionPolicy,
} from './store.js';
// Phase 1 — multi-tier (L1 + L2) composite store.
export { weaveTieredCacheStore } from './tiered-store.js';
export type { TieredCacheStoreOptions, TieredCacheStore } from './tiered-store.js';
// Phase 1 — distributed L2 (Redis) store. Also re-exported from `@weaveintel/cache/redis`.
export { weaveRedisCacheStore } from './redis-store.js';
export type { RedisLikeClient, RedisCacheStoreOptions, RedisCacheStore } from './redis-store.js';
// Phase 7 — RuntimeCacheSlot adapter for weaveRuntime({ cache }).
export { createRuntimeCacheAdapter } from './runtime-cache-adapter.js';
export { weaveSemanticCache, createInMemoryVectorIndex, cosineSimilarity } from './semantic.js';
export type { SemanticCacheOptions, VectorIndex, SemanticEntry } from './semantic.js';
export {
  createCachePolicy,
  shouldBypass,
  shouldBypassResponse,
  isCacheableTemperature,
  resolvePolicy,
} from './policy.js';
export type { CachePolicyOptions } from './policy.js';
export { weaveCacheKeyBuilder, cacheScopeKey, cacheScopeKeyString } from './key-builder.js';
export type { CacheKeyBuilderOptions } from './key-builder.js';
// Phase 2 — provider-native prompt-cache planning.
export { planPromptCacheBreakpoints, estimatePromptTokens } from './prompt-cache.js';
export type { PromptCachePlan, PromptCachePlanInput } from './prompt-cache.js';
// Phase 3 — cache observability.
export { createCacheMetrics, withMetrics, estimatePromptCacheSavingsUsd } from './metrics.js';
export {
  evaluateInvalidationRules,
  applyInvalidation,
  applySemanticInvalidation,
  createCacheInvalidator,
} from './invalidation.js';
export type {
  InvalidationEvent,
  CacheInvalidator,
  CacheInvalidatorOptions,
  InvalidateTarget,
} from './invalidation.js';
// Phase 6 — opt-in tool-result caching.
export { withToolResultCache, buildToolCacheKey, TOOL_CACHE_NAMESPACE } from './tool-cache.js';
export type { ToolResultCacheOptions } from './tool-cache.js';
// Phase 7 — stampede protection (singleflight), SWR/XFetch, negative caching.
export { createSingleflight } from './singleflight.js';
export type { Singleflight, SingleflightStats, FlightHandle, LeaderHandle, FollowerHandle } from './singleflight.js';
export { createStampedeCache, shouldServeStale, shouldEarlyRefresh } from './stampede.js';
export type { StampedeCache, StampedeCacheOptions, GetOrComputeOptions, StampedeResult, StaleState } from './stampede.js';
