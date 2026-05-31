/**
 * Redis-backed DurableSleepStore.
 *
 * Layout:
 *   wf_slp:idx          ZSET  member=runId score=wakeAt_ms
 *   wf_slp:rec:<runId>  STRING JSON({wakeAt, createdAt})
 */
import type { RedisClientType } from 'redis';
import type { SleepRecord, DurableSleepStore } from '@weaveintel/core';

export interface WeaveRedisSleepStoreOptions {
  client: RedisClientType;
  prefix?: string;
}

export function weaveRedisSleepStore(opts: WeaveRedisSleepStoreOptions): DurableSleepStore {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_slp';
  const idxKey = `${prefix}:idx`;
  const recKey = (runId: string) => `${prefix}:rec:${runId}`;

  async function readRec(runId: string, fallbackWakeAt?: number): Promise<SleepRecord | null> {
    const raw = await c.get(recKey(runId));
    if (!raw) {
      if (fallbackWakeAt === undefined) return null;
      return { runId, wakeAt: fallbackWakeAt, createdAt: new Date().toISOString() };
    }
    const parsed = JSON.parse(raw) as { wakeAt: number; createdAt: string };
    return { runId, wakeAt: parsed.wakeAt, createdAt: parsed.createdAt };
  }

  return {
    async schedule(runId, wakeAt) {
      await c.zAdd(idxKey, { score: wakeAt, value: runId });
      await c.set(recKey(runId), JSON.stringify({ wakeAt, createdAt: new Date().toISOString() }));
    },
    async cancel(runId) {
      await c.zRem(idxKey, runId);
      await c.del(recKey(runId));
    },
    async getDue(now = Date.now()) {
      const ids = await c.zRangeByScore(idxKey, '-inf', now);
      const out: SleepRecord[] = [];
      for (const id of ids) {
        const rec = await readRec(id);
        if (rec) out.push(rec);
      }
      return out;
    },
    async list() {
      const ids = await c.zRange(idxKey, 0, -1);
      const out: SleepRecord[] = [];
      for (const id of ids) {
        const rec = await readRec(id);
        if (rec) out.push(rec);
      }
      return out;
    },
  };
}
