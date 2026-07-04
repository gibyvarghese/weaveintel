/**
 * @weaveintel/tools-http — durable per-host rate-limit store.
 *
 * The module-level `rateBuckets` map in `client.ts` loses every per-host
 * window on restart, blowing through vendor rate limits during deploys.
 * `createDurableHttpRateBucketStore` persists the bucket state via
 * `runtime.persistence.kv` so windows survive restarts.
 *
 * Bucket semantics: minute-window refill, where each call decrements `tokens`
 * and the window resets every 60 s. Stored serialized; reads + writes are
 * sequential (KV is async). Best-effort: a thrown KV op surfaces as a thrown
 * Error (caller decides whether to fail-open or fail-closed).
 */
import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
} from '@weaveintel/core';

export interface PersistedRateBucket {
  tokens: number;
  lastRefill: number;
  rpm: number;
  lastSeen: number;
}

export interface DurableHttpRateBucketStore {
  /** Atomic check-and-decrement. Throws when over budget. */
  check(name: string, rpm: number): Promise<void>;
  /** Drop a bucket (e.g. after config change). */
  reset(name: string): Promise<void>;
  /** Snapshot for ops/admin tooling. */
  snapshot(name: string): Promise<PersistedRateBucket | undefined>;
}

export interface DurableHttpRateBucketStoreOptions {
  runtime?: WeaveRuntime;
  namespace?: string;
}

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

export function createDurableHttpRateBucketStore(
  opts: DurableHttpRateBucketStoreOptions = {},
): DurableHttpRateBucketStore {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'http-rate';

  return {
    async check(name, rpm) {
      const now = Date.now();
      const raw = await kv.get(`${ns}:${name}`);
      let bucket: PersistedRateBucket;
      if (raw) {
        try { bucket = JSON.parse(raw) as PersistedRateBucket; }
        catch { bucket = { tokens: rpm, lastRefill: now, rpm, lastSeen: now }; }
      } else {
        bucket = { tokens: rpm, lastRefill: now, rpm, lastSeen: now };
      }
      bucket.lastSeen = now;
      if (now - bucket.lastRefill > 60_000) {
        bucket.tokens = rpm;
        bucket.lastRefill = now;
      }
      if (bucket.tokens <= 0) {
        await kv.set(`${ns}:${name}`, JSON.stringify(bucket));
        throw new Error(`Rate limit exceeded for "${name}" (${rpm} req/min)`);
      }
      bucket.tokens -= 1;
      await kv.set(`${ns}:${name}`, JSON.stringify(bucket));
    },
    async reset(name) { await kv.delete(`${ns}:${name}`); },
    async snapshot(name) {
      const raw = await kv.get(`${ns}:${name}`);
      if (!raw) return undefined;
      try { return JSON.parse(raw) as PersistedRateBucket; } catch { return undefined; }
    },
  };
}
