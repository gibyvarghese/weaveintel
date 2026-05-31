/**
 * Redis-backed PayloadStore.
 *
 * Layout:
 *   wf_pl:k:<key>           STRING JSON payload
 *   wf_pl:run:<runId>       SET of keys for that run (for deleteRun)
 */
import type { RedisClientType } from 'redis';
import type { PayloadStore } from './payload-store.js';

export interface WeaveRedisPayloadStoreOptions {
  client: RedisClientType;
  prefix?: string;
}

function extractRunId(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(0, idx) : key;
}

export function weaveRedisPayloadStore(opts: WeaveRedisPayloadStoreOptions): PayloadStore {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_pl';
  const kKey = (key: string) => `${prefix}:k:${key}`;
  const runKey = (runId: string) => `${prefix}:run:${runId}`;

  return {
    async put(key, data) {
      await c.set(kKey(key), JSON.stringify(data ?? null));
      await c.sAdd(runKey(extractRunId(key)), key);
    },
    async get(key) {
      const raw = await c.get(kKey(key));
      if (raw === null) return undefined;
      return JSON.parse(raw) as unknown;
    },
    async delete(key) {
      await c.del(kKey(key));
      await c.sRem(runKey(extractRunId(key)), key);
    },
    async deleteRun(runId) {
      const members = await c.sMembers(runKey(runId));
      if (members.length) await c.del(members.map(kKey));
      await c.del(runKey(runId));
    },
  };
}
