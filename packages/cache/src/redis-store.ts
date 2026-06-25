/**
 * @weaveintel/cache/redis — Distributed L2 CacheStore backed by Redis.
 *
 * Phase 1: a shared, cross-replica cache so a warm response on one instance
 * serves the same request on another (in-process caches never share). Implements
 * the same `CacheStore` contract as the in-memory store, plus `ScannableCacheStore`
 * (prefix enumeration / bulk delete) and `close()`.
 *
 * The Redis client is dependency-injected (`RedisLikeClient`) so the package
 * carries no hard dependency on a specific client and stays unit-testable with a
 * fake. Pass `url` instead to have the store lazily build a node-`redis` client
 * (`rediss://` enables TLS automatically) — `redis` is then an optional peer dep
 * resolved only when this subpath is used.
 *
 * Values are JSON-encoded; TTLs use Redis `PX` so expiry is enforced server-side.
 * All keys are namespaced under `keyPrefix` so `clear()` / scans never touch
 * unrelated keys in a shared Redis.
 */

import type { ScannableCacheStore } from '@weaveintel/core';

/** Minimal subset of a Redis client this store needs (node-redis / ioredis compatible). */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  del(keys: string | string[]): Promise<number>;
  exists(keys: string | string[]): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  isOpen?: boolean;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
}

export interface RedisCacheStoreOptions {
  /** A pre-built Redis-like client (takes precedence over `url`). */
  client?: RedisLikeClient;
  /** Connection URL (`redis://` / `rediss://`) — used to lazily build a node-`redis` client. */
  url?: string;
  /** Namespace prefix for every key. Default `'weave:cache'`. */
  keyPrefix?: string;
}

export type RedisCacheStore = ScannableCacheStore & { close(): Promise<void> };

function escapeGlob(s: string): string {
  // Escape Redis KEYS glob metacharacters so a key prefix is matched literally.
  return s.replace(/([\\*?[\]^])/g, '\\$1');
}

export function weaveRedisCacheStore(opts: RedisCacheStoreOptions): RedisCacheStore {
  if (!opts.client && !opts.url) {
    throw new Error('weaveRedisCacheStore requires either `client` or `url`');
  }
  const keyPrefix = opts.keyPrefix ?? 'weave:cache';
  let client: RedisLikeClient | undefined = opts.client;
  let connecting: Promise<void> | undefined;

  const physical = (key: string): string => `${keyPrefix}:${key}`;
  const logical = (physicalKey: string): string =>
    physicalKey.startsWith(keyPrefix + ':') ? physicalKey.slice(keyPrefix.length + 1) : physicalKey;

  async function getClient(): Promise<RedisLikeClient> {
    if (!client) {
      // Lazy node-redis client. `redis` is an optional peer dependency resolved
      // only when a `url` (not a `client`) is supplied.
      const mod = (await import('redis')) as { createClient: (o: { url: string }) => RedisLikeClient };
      client = mod.createClient({ url: opts.url! });
    }
    if (client.connect && client.isOpen === false) {
      // Coalesce concurrent connect attempts.
      connecting ??= client.connect().then(() => undefined);
      await connecting;
    }
    return client;
  }

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const c = await getClient();
      const raw = await c.get(physical(key));
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },

    async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
      const c = await getClient();
      const payload = JSON.stringify(value);
      await c.set(physical(key), payload, ttlMs && ttlMs > 0 ? { PX: ttlMs } : undefined);
    },

    async delete(key: string): Promise<void> {
      const c = await getClient();
      await c.del(physical(key));
    },

    async has(key: string): Promise<boolean> {
      const c = await getClient();
      return (await c.exists(physical(key))) > 0;
    },

    async clear(scope?: string): Promise<void> {
      const c = await getClient();
      const pattern = scope ? `${keyPrefix}:${escapeGlob(scope)}*` : `${keyPrefix}:*`;
      const found = await c.keys(pattern);
      if (found.length > 0) await c.del(found);
    },

    async size(): Promise<number> {
      const c = await getClient();
      return (await c.keys(`${keyPrefix}:*`)).length;
    },

    async keys(prefix?: string): Promise<string[]> {
      const c = await getClient();
      const pattern = prefix ? `${keyPrefix}:${escapeGlob(prefix)}*` : `${keyPrefix}:*`;
      return (await c.keys(pattern)).map(logical);
    },

    async deleteByPrefix(prefix: string): Promise<number> {
      const c = await getClient();
      const found = await c.keys(`${keyPrefix}:${escapeGlob(prefix)}*`);
      if (found.length === 0) return 0;
      await c.del(found);
      return found.length;
    },

    async close(): Promise<void> {
      if (client?.quit && client.isOpen !== false) {
        await client.quit().catch(() => undefined);
      }
    },
  };
}
