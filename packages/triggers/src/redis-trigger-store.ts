/**
 * Redis-backed TriggerStore.
 *
 * Layout:
 *   trg:t:<id>             STRING JSON of full Trigger
 *   trg:key:<key>          STRING id (lookup by key)
 *   trg:all                ZSET   member=id score=0 (for list())
 *   trg:inv:<id>           STRING JSON of full TriggerInvocation
 *   trg:inv:by-trigger:<triggerId> ZSET  member=inv_id score=firedAt
 *   trg:inv:by-status:<status>     ZSET  member=inv_id score=firedAt
 *   trg:inv:all                    ZSET  member=inv_id score=firedAt
 */
import type { RedisClientType } from 'redis';
import { newUUIDv7 } from '@weaveintel/core';
import type {
  Trigger,
  TriggerInvocation,
  TriggerStore,
  ListInvocationsFilter,
} from './dispatcher.js';

export interface WeaveRedisTriggerStoreOptions {
  client: RedisClientType;
  prefix?: string;
}

export function weaveRedisTriggerStore(opts: WeaveRedisTriggerStoreOptions): TriggerStore {
  const c = opts.client;
  const p = opts.prefix ?? 'trg';
  const tKey = (id: string) => `${p}:t:${id}`;
  const keyIdx = (key: string) => `${p}:key:${key}`;
  const allTriggers = `${p}:all`;
  const invKey = (id: string) => `${p}:inv:${id}`;
  const invByTrigger = (tid: string) => `${p}:inv:by-trigger:${tid}`;
  const invByStatus = (s: string) => `${p}:inv:by-status:${s}`;
  const invAll = `${p}:inv:all`;

  async function loadTrigger(id: string): Promise<Trigger | null> {
    const raw = await c.get(tKey(id));
    return raw ? (JSON.parse(raw) as Trigger) : null;
  }
  async function loadInv(id: string): Promise<TriggerInvocation | null> {
    const raw = await c.get(invKey(id));
    return raw ? (JSON.parse(raw) as TriggerInvocation) : null;
  }

  return {
    async list() {
      const ids = await c.zRange(allTriggers, 0, -1);
      const out: Trigger[] = [];
      for (const id of ids) {
        const t = await loadTrigger(id);
        if (t) out.push(t);
      }
      // sort by key for determinism
      out.sort((a, b) => a.key.localeCompare(b.key));
      return out;
    },
    async get(id) { return loadTrigger(id); },
    async getByKey(key) {
      const id = await c.get(keyIdx(key));
      return id ? loadTrigger(id) : null;
    },
    async save(t) {
      // if existing trigger has different key, clean old key index
      const existing = await loadTrigger(t.id);
      if (existing && existing.key !== t.key) {
        await c.del(keyIdx(existing.key));
      }
      await c.set(tKey(t.id), JSON.stringify(t));
      await c.set(keyIdx(t.key), t.id);
      await c.zAdd(allTriggers, { score: 0, value: t.id });
    },
    async delete(id) {
      const existing = await loadTrigger(id);
      if (existing) await c.del(keyIdx(existing.key));
      await c.del(tKey(id));
      await c.zRem(allTriggers, id);
    },
    async recordInvocation(inv) {
      const id = inv.id || newUUIDv7();
      const stored: TriggerInvocation = { ...inv, id };
      await c.set(invKey(id), JSON.stringify(stored));
      await c.zAdd(invByTrigger(inv.triggerId), { score: inv.firedAt, value: id });
      await c.zAdd(invByStatus(inv.status), { score: inv.firedAt, value: id });
      await c.zAdd(invAll, { score: inv.firedAt, value: id });
    },
    async listInvocations(filter: ListInvocationsFilter = {}) {
      const limit = filter.limit ?? 100;
      const offset = filter.offset ?? 0;
      const stop = offset + limit - 1;
      let ids: string[];
      if (filter.triggerId && filter.status) {
        // intersect: small sets — fetch both and intersect manually
        const a = await c.zRange(invByTrigger(filter.triggerId), 0, -1, { REV: true });
        const b = new Set(await c.zRange(invByStatus(filter.status), 0, -1, { REV: true }));
        ids = a.filter((x) => b.has(x)).slice(offset, offset + limit);
      } else if (filter.triggerId) {
        ids = await c.zRange(invByTrigger(filter.triggerId), offset, stop, { REV: true });
      } else if (filter.status) {
        ids = await c.zRange(invByStatus(filter.status), offset, stop, { REV: true });
      } else {
        ids = await c.zRange(invAll, offset, stop, { REV: true });
      }
      const out: TriggerInvocation[] = [];
      for (const id of ids) {
        const inv = await loadInv(id);
        if (inv) out.push(inv);
      }
      return out;
    },
    async listByOwner(principalId) {
      const all = await this.list();
      return all.filter((t) => t.ownerPrincipalId === principalId);
    },
  };
}
