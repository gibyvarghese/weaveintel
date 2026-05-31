/**
 * MongoDB-backed DurableSleepStore.
 */
import type { Db } from 'mongodb';
import type { SleepRecord, DurableSleepStore } from '@weaveintel/core';

interface Doc { _id: string; wakeAt: number; createdAt: string; }

export interface WeaveMongoDbSleepStoreOptions {
  db: Db;
  collection?: string;
  ensureIndexes?: boolean;
}

function toRecord(d: Doc): SleepRecord {
  return { runId: d._id, wakeAt: d.wakeAt, createdAt: d.createdAt };
}

export async function weaveMongoDbSleepStore(
  opts: WeaveMongoDbSleepStoreOptions,
): Promise<DurableSleepStore> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_sleeps');
  if (opts.ensureIndexes !== false) await col.createIndex({ wakeAt: 1 });
  return {
    async schedule(runId, wakeAt) {
      await col.replaceOne(
        { _id: runId },
        { wakeAt, createdAt: new Date().toISOString() },
        { upsert: true },
      );
    },
    async cancel(runId) {
      await col.deleteOne({ _id: runId });
    },
    async getDue(now = Date.now()) {
      const docs = await col.find({ wakeAt: { $lte: now } }).sort({ wakeAt: 1, _id: 1 }).toArray();
      return docs.map(toRecord);
    },
    async list() {
      const docs = await col.find({}).sort({ wakeAt: 1, _id: 1 }).toArray();
      return docs.map(toRecord);
    },
  };
}
