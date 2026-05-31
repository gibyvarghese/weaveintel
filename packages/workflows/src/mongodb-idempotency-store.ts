/**
 * MongoDB-backed StepIdempotencyStore.
 */
import type { Db } from 'mongodb';
import type { StepIdempotencyStore } from './idempotency-store.js';

interface Doc { _id: string; output: unknown; createdAt: string; }

export interface WeaveMongoDbIdempotencyStoreOptions {
  db: Db;
  collection?: string;
  ensureIndexes?: boolean;
}

export async function weaveMongoDbIdempotencyStore(
  opts: WeaveMongoDbIdempotencyStoreOptions,
): Promise<StepIdempotencyStore> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_idempotency');
  // _id is auto-indexed; no extra indexes required.
  return {
    async get(key) {
      const d = await col.findOne({ _id: key });
      return d ? d.output : undefined;
    },
    async set(key, output) {
      await col.replaceOne(
        { _id: key },
        { output: output ?? null, createdAt: new Date().toISOString() },
        { upsert: true },
      );
    },
    async delete(key) {
      await col.deleteOne({ _id: key });
    },
    async clearPrefix(prefix) {
      await col.deleteMany({ _id: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } });
    },
  };
}
