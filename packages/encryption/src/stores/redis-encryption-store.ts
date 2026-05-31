/**
 * Redis-backed EncryptionStore.
 *
 * Layout:
 *   policy:<tenantId>         STRING — JSON of TenantPolicyRecord (sans tenantId)
 *   kek:<id>                  STRING — JSON of KekRecord (sans id)
 *   keks:<tenantId>           ZSET   — score = version, member = id
 *   dek:<id>                  STRING — JSON of DekRecord (sans id)
 *   deks:<tenantId>           ZSET   — score = epoch, member = id
 *   bik:<id>                  STRING — JSON of BikRecord (sans id)
 *   biks:<tenantId>           ZSET   — score = epoch, member = id
 *
 * Caller passes a node-redis v4 client (already connected). Package does not
 * own connection lifecycle.
 */
import type { RedisClientType } from 'redis';
import type {
  EncryptionStore,
  TenantPolicyRecord,
  KekRecord,
  DekRecord,
  BikRecord,
  KeyStatus,
} from '../store.js';

export interface WeaveRedisEncryptionStoreOptions {
  client: RedisClientType;
  keyPrefix?: string;
}

export function weaveRedisEncryptionStore(opts: WeaveRedisEncryptionStoreOptions): EncryptionStore {
  const prefix = opts.keyPrefix ?? '';
  const client = opts.client;
  const k = (s: string) => `${prefix}${s}`;

  return {
    async getPolicy(tenantId) {
      const raw = await client.get(k(`policy:${tenantId}`));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Omit<TenantPolicyRecord, 'tenantId'>;
      return { tenantId, ...parsed };
    },
    async upsertPolicy(p) {
      const { tenantId, ...rest } = p;
      await client.set(k(`policy:${tenantId}`), JSON.stringify(rest));
    },
    async listKeks(tenantId) {
      const ids = await client.zRange(k(`keks:${tenantId}`), 0, -1);
      if (ids.length === 0) return [];
      const raws = await Promise.all(ids.map((id) => client.get(k(`kek:${id}`))));
      const out: KekRecord[] = [];
      for (let i = 0; i < ids.length; i++) {
        const raw = raws[i];
        if (!raw) continue;
        out.push({ id: ids[i]!, ...(JSON.parse(raw) as Omit<KekRecord, 'id'>) });
      }
      return out;
    },
    async insertKek(rec) {
      const { id, ...rest } = rec;
      await client.set(k(`kek:${id}`), JSON.stringify(rest));
      await client.zAdd(k(`keks:${rec.tenantId}`), { score: rec.version, value: id });
    },
    async updateKekStatus(id, status, ts) {
      const raw = await client.get(k(`kek:${id}`));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Omit<KekRecord, 'id'>;
      const updated: Omit<KekRecord, 'id'> = {
        ...parsed,
        status,
        ...(status === 'previous' ? { rotatedAt: ts } : {}),
        ...(status === 'revoked' ? { revokedAt: ts } : {}),
      };
      await client.set(k(`kek:${id}`), JSON.stringify(updated));
    },
    async listDeks(tenantId) {
      const ids = await client.zRange(k(`deks:${tenantId}`), 0, -1);
      if (ids.length === 0) return [];
      const raws = await Promise.all(ids.map((id) => client.get(k(`dek:${id}`))));
      const out: DekRecord[] = [];
      for (let i = 0; i < ids.length; i++) {
        const raw = raws[i];
        if (!raw) continue;
        out.push({ id: ids[i]!, ...(JSON.parse(raw) as Omit<DekRecord, 'id'>) });
      }
      return out;
    },
    async insertDek(rec) {
      const { id, ...rest } = rec;
      await client.set(k(`dek:${id}`), JSON.stringify(rest));
      await client.zAdd(k(`deks:${rec.tenantId}`), { score: rec.epoch, value: id });
    },
    async updateDekStatus(id, status, ts) {
      const raw = await client.get(k(`dek:${id}`));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Omit<DekRecord, 'id'>;
      const updated: Omit<DekRecord, 'id'> = {
        ...parsed,
        status,
        ...(status === 'previous' ? { rotatedAt: ts } : {}),
        ...(status === 'revoked' ? { revokedAt: ts } : {}),
      };
      await client.set(k(`dek:${id}`), JSON.stringify(updated));
    },
    async listBiks(tenantId) {
      const ids = await client.zRange(k(`biks:${tenantId}`), 0, -1);
      if (ids.length === 0) return [];
      const raws = await Promise.all(ids.map((id) => client.get(k(`bik:${id}`))));
      const out: BikRecord[] = [];
      for (let i = 0; i < ids.length; i++) {
        const raw = raws[i];
        if (!raw) continue;
        out.push({ id: ids[i]!, ...(JSON.parse(raw) as Omit<BikRecord, 'id'>) });
      }
      return out;
    },
    async insertBik(rec) {
      const { id, ...rest } = rec;
      await client.set(k(`bik:${id}`), JSON.stringify(rest));
      await client.zAdd(k(`biks:${rec.tenantId}`), { score: rec.epoch, value: id });
    },
    async updateBikStatus(id, status: KeyStatus, ts) {
      const raw = await client.get(k(`bik:${id}`));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Omit<BikRecord, 'id'>;
      const updated: Omit<BikRecord, 'id'> = {
        ...parsed,
        status,
        ...(status === 'revoked' ? { revokedAt: ts } : {}),
      };
      await client.set(k(`bik:${id}`), JSON.stringify(updated));
    },
    async deletePolicy(tenantId) {
      await client.del(k(`policy:${tenantId}`));
    },
    async deleteAllWrappedMaterial(tenantId) {
      const kekIds = await client.zRange(k(`keks:${tenantId}`), 0, -1);
      const dekIds = await client.zRange(k(`deks:${tenantId}`), 0, -1);
      const bikIds = await client.zRange(k(`biks:${tenantId}`), 0, -1);
      const keys: string[] = [];
      for (const id of kekIds) keys.push(k(`kek:${id}`));
      for (const id of dekIds) keys.push(k(`dek:${id}`));
      for (const id of bikIds) keys.push(k(`bik:${id}`));
      if (keys.length > 0) await client.del(keys);
      await client.del(k(`keks:${tenantId}`));
      await client.del(k(`deks:${tenantId}`));
      await client.del(k(`biks:${tenantId}`));
      return { keks: kekIds.length, deks: dekIds.length, biks: bikIds.length };
    },
  };
}
