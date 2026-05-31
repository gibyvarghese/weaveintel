/**
 * MongoDB-backed EncryptionStore.
 *
 * 4 collections: tenant_encryption_policy / tenant_keks / tenant_deks / tenant_biks.
 * Indexes ensured on first construction when ensureSchema=true. Caller passes
 * a Db handle so connection/auth stays out of the package.
 */
import type { Db, Collection } from 'mongodb';
import type {
  EncryptionStore,
  TenantPolicyRecord,
  KekRecord,
  DekRecord,
  BikRecord,
  KeyStatus,
} from '../store.js';

export interface WeaveMongoDbEncryptionStoreOptions {
  db: Db;
  ensureSchema?: boolean;
}

interface PolicyDoc extends Omit<TenantPolicyRecord, 'tenantId'> {
  _id: string;
}

interface KekDoc extends Omit<KekRecord, 'id'> {
  _id: string;
}

interface DekDoc extends Omit<DekRecord, 'id'> {
  _id: string;
}

interface BikDoc extends Omit<BikRecord, 'id'> {
  _id: string;
}

export async function weaveMongoDbEncryptionStore(
  opts: WeaveMongoDbEncryptionStoreOptions,
): Promise<EncryptionStore> {
  const { db, ensureSchema = true } = opts;
  const policies = db.collection<PolicyDoc>('tenant_encryption_policy');
  const keks: Collection<KekDoc> = db.collection<KekDoc>('tenant_keks');
  const deks: Collection<DekDoc> = db.collection<DekDoc>('tenant_deks');
  const biks: Collection<BikDoc> = db.collection<BikDoc>('tenant_biks');

  if (ensureSchema) {
    await keks.createIndex({ tenantId: 1, version: -1 });
    await deks.createIndex({ tenantId: 1, epoch: -1 });
    await biks.createIndex({ tenantId: 1, epoch: -1 });
  }

  return {
    async getPolicy(tenantId) {
      const doc = await policies.findOne({ _id: tenantId });
      if (!doc) return null;
      const { _id, ...rest } = doc;
      return { tenantId: _id, ...rest } as TenantPolicyRecord;
    },
    async upsertPolicy(p) {
      const { tenantId, ...rest } = p;
      await policies.replaceOne({ _id: tenantId }, rest as Omit<PolicyDoc, '_id'>, { upsert: true });
    },
    async listKeks(tenantId) {
      const docs = await keks.find({ tenantId }).sort({ version: 1, _id: 1 }).toArray();
      return docs.map((d) => {
        const { _id, ...rest } = d;
        return { id: _id, ...rest } as KekRecord;
      });
    },
    async insertKek(k) {
      const { id, ...rest } = k;
      await keks.insertOne({ _id: id, ...rest } as KekDoc);
    },
    async updateKekStatus(id, status, ts) {
      const set: Record<string, unknown> = { status };
      if (status === 'previous') set['rotatedAt'] = ts;
      if (status === 'revoked') set['revokedAt'] = ts;
      await keks.updateOne({ _id: id }, { $set: set });
    },
    async listDeks(tenantId) {
      const docs = await deks.find({ tenantId }).sort({ epoch: 1, _id: 1 }).toArray();
      return docs.map((d) => {
        const { _id, ...rest } = d;
        return { id: _id, ...rest } as DekRecord;
      });
    },
    async insertDek(d) {
      const { id, ...rest } = d;
      await deks.insertOne({ _id: id, ...rest } as DekDoc);
    },
    async updateDekStatus(id, status, ts) {
      const set: Record<string, unknown> = { status };
      if (status === 'previous') set['rotatedAt'] = ts;
      if (status === 'revoked') set['revokedAt'] = ts;
      await deks.updateOne({ _id: id }, { $set: set });
    },
    async listBiks(tenantId) {
      const docs = await biks.find({ tenantId }).sort({ epoch: 1, _id: 1 }).toArray();
      return docs.map((d) => {
        const { _id, ...rest } = d;
        return { id: _id, ...rest } as BikRecord;
      });
    },
    async insertBik(b) {
      const { id, ...rest } = b;
      await biks.insertOne({ _id: id, ...rest } as BikDoc);
    },
    async updateBikStatus(id, status: KeyStatus, ts) {
      const set: Record<string, unknown> = { status };
      if (status === 'revoked') set['revokedAt'] = ts;
      await biks.updateOne({ _id: id }, { $set: set });
    },
    async deletePolicy(tenantId) {
      await policies.deleteOne({ _id: tenantId });
    },
    async deleteAllWrappedMaterial(tenantId) {
      const k = await keks.deleteMany({ tenantId });
      const d = await deks.deleteMany({ tenantId });
      const b = await biks.deleteMany({ tenantId });
      return { keks: k.deletedCount, deks: d.deletedCount, biks: b.deletedCount };
    },
  };
}
