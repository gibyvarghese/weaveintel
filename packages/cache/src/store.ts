/**
 * @weaveintel/cache — CacheStore implementations
 *
 * In-memory cache store with TTL support. Production deployments
 * can use the same CacheStore interface with Redis, Memcached, etc.
 */

import type { CacheStore } from '@weaveintel/core';

interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number | null;
  scope?: string;
}

/**
 * In-memory CacheStore with optional TTL per entry and scope-based clear.
 */
export function weaveInMemoryCacheStore(): CacheStore {
  const data = new Map<string, CacheEntry>();

  function isExpired(entry: CacheEntry): boolean {
    return entry.expiresAt !== null && Date.now() > entry.expiresAt;
  }

  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const entry = data.get(key);
      if (!entry) return null;
      if (isExpired(entry)) {
        data.delete(key);
        return null;
      }
      return entry.value as T;
    },

    async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
      data.set(key, {
        value,
        expiresAt: ttlMs ? Date.now() + ttlMs : null,
      });
    },

    async delete(key: string): Promise<void> {
      data.delete(key);
    },

    async has(key: string): Promise<boolean> {
      const entry = data.get(key);
      if (!entry) return false;
      if (isExpired(entry)) {
        data.delete(key);
        return false;
      }
      return true;
    },

    async clear(scope?: string): Promise<void> {
      if (!scope) {
        data.clear();
        return;
      }
      for (const [key, entry] of data) {
        if (entry.scope === scope || key.startsWith(scope + ':')) {
          data.delete(key);
        }
      }
    },

    async size(): Promise<number> {
      // Prune expired entries before counting
      for (const [key, entry] of data) {
        if (isExpired(entry)) data.delete(key);
      }
      return data.size;
    },
  };
}
