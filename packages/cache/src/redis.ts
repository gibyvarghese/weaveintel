// SPDX-License-Identifier: MIT
/**
 * @weaveintel/cache/redis — distributed L2 store entry point.
 *
 * Importing this subpath (instead of the package root) makes the Redis
 * dependency explicit for consumers that want only the L2 store.
 */
export { weaveRedisCacheStore } from './redis-store.js';
export type { RedisLikeClient, RedisCacheStoreOptions, RedisCacheStore } from './redis-store.js';
