/**
 * MongoDB-backed StepLockStore.
 */
import type { Db } from 'mongodb';
import type { StepLockStore } from './step-lock-store.js';

interface Doc {
  _id: string; // `${runId}:${stepId}`
  runId: string;
  stepId: string;
  state: 'locked' | 'done';
  lockedAt: string;
  doneAt?: string;
  output?: unknown;
}

export interface WeaveMongoDbStepLockStoreOptions {
  db: Db;
  collection?: string;
  ensureIndexes?: boolean;
}

function key(runId: string, stepId: string): string {
  return `${runId}:${stepId}`;
}

export async function weaveMongoDbStepLockStore(
  opts: WeaveMongoDbStepLockStoreOptions,
): Promise<StepLockStore> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_step_locks');
  if (opts.ensureIndexes !== false) await col.createIndex({ runId: 1 });
  return {
    async lock(runId, stepId) {
      const now = new Date().toISOString();
      await col.updateOne(
        { _id: key(runId, stepId) },
        { $setOnInsert: { runId, stepId, state: 'locked', lockedAt: now } },
        { upsert: true },
      );
    },
    async markDone(runId, stepId, output) {
      const now = new Date().toISOString();
      await col.updateOne(
        { _id: key(runId, stepId) },
        {
          $set: { state: 'done', doneAt: now, output: output ?? null, runId, stepId },
          $setOnInsert: { lockedAt: now },
        },
        { upsert: true },
      );
    },
    async isDone(runId, stepId) {
      const d = await col.findOne({ _id: key(runId, stepId) });
      if (d?.state === 'done') return { done: true, output: d.output };
      return { done: false };
    },
    async isLocked(runId, stepId) {
      const d = await col.findOne({ _id: key(runId, stepId) }, { projection: { _id: 1 } });
      return !!d;
    },
    async clear(runId) {
      await col.deleteMany({ runId });
    },
  };
}
