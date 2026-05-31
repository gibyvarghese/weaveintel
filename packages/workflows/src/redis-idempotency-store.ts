/**
 * Redis-backed StepIdempotencyStore.
 *
 * Layout: wf_idem:<key>  STRING JSON({output})
 */
import type { RedisClientType } from 'redis';
import type { StepIdempotencyStore } from './idempotency-store.js';

export interface WeaveRedisIdempotencyStoreOptions {
  client: RedisClientType;
  prefix?: string;
}

export function weaveRedisIdempotencyStore(
  opts: WeaveRedisIdempotencyStoreOptions,
): StepIdempotencyStore {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_idem';
  const k = (key: string) => `${prefix}:${key}`;

  return {
    async get(key) {
      const raw = await c.get(k(key));
      if (raw === null) return undefined;
      return JSON.parse(raw) as unknown;
    },
    async set(key, output) {
      await c.set(k(key), JSON.stringify(output ?? null));
    },
    async delete(key) {
      await c.del(k(key));
    },
    async clearPrefix(p) {
      const pattern = `${prefix}:${p}*`;
      for await (const found of c.scanIterator({ MATCH: pattern, COUNT: 200 })) {
        const arr = Array.isArray(found) ? found : [found];
        if (arr.length) await c.del(arr);
      }
    },
  };
}
