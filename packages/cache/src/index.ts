// SPDX-License-Identifier: MIT
/**
 * @weaveintel/cache — Public API
 */

export { weaveInMemoryCacheStore } from './store.js';
// Phase 7 — RuntimeCacheSlot adapter for weaveRuntime({ cache }).
export { createRuntimeCacheAdapter } from './runtime-cache-adapter.js';
export { weaveSemanticCache } from './semantic.js';
export type { SemanticCacheOptions } from './semantic.js';
export { createCachePolicy, shouldBypass, resolvePolicy } from './policy.js';
export { weaveCacheKeyBuilder } from './key-builder.js';
export {
  evaluateInvalidationRules,
  applyInvalidation,
  applySemanticInvalidation,
} from './invalidation.js';
export type { InvalidationEvent } from './invalidation.js';
