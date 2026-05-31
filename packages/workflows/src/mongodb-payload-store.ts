/**
 * MongoDB-backed PayloadStore.
 */
import type { Db } from 'mongodb';
import type { PayloadStore } from './payload-store.js';

interface Doc { _id: string; runId: string; data: unknown; createdAt: string; }

export interface WeaveMongoDbPayloadStoreOptions {
  db: Db;
  collection?: string;
  ensureIndexes?: boolean;
}

function extractRunId(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(0, idx) : key;
}

export async function weaveMongoDbPayloadStore(
  opts: WeaveMongoDbPayloadStoreOptions,
): Promise<PayloadStore> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_payloads');
  if (opts.ensureIndexes !== false) await col.createIndex({ runId: 1 });
  return {
    async put(key, data) {
      await col.replaceOne(
        { _id: key },
        { runId: extractRunId(key), data: data ?? null, createdAt: new Date().toISOString() },
        { upsert: true },
      );
    },
    async get(key) {
      const d = await col.findOne({ _id: key });
      return d ? d.data : undefined;
    },
    async delete(key) {
      await col.deleteOne({ _id: key });
    },
    async deleteRun(runId) {
      await col.deleteMany({ runId });
    },
  };
}
