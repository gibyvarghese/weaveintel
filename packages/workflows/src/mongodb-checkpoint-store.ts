/**
 * MongoDB-backed CheckpointStore.
 */
import type { Db } from 'mongodb';
import type { WorkflowCheckpoint, WorkflowState } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { CheckpointStore } from './checkpoint-store.js';

interface Doc {
  _id: string;
  runId: string;
  workflowId?: string;
  stepId: string;
  state: WorkflowState;
  createdAt: string;
}

function docToCheckpoint(d: Doc): WorkflowCheckpoint {
  return {
    id: d._id,
    runId: d.runId,
    stepId: d.stepId,
    state: d.state,
    createdAt: d.createdAt,
    ...(d.workflowId ? { workflowId: d.workflowId } : {}),
  };
}

export interface WeaveMongoDbCheckpointStoreOptions {
  db: Db;
  collection?: string;
  ensureIndexes?: boolean;
}

export async function weaveMongoDbCheckpointStore(
  opts: WeaveMongoDbCheckpointStoreOptions,
): Promise<CheckpointStore> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_checkpoints');
  if (opts.ensureIndexes !== false) {
    await col.createIndex({ runId: 1, createdAt: 1, _id: 1 });
  }

  return {
    async save(runId, stepId, state, workflowId) {
      const cp: WorkflowCheckpoint = {
        id: newUUIDv7(),
        runId,
        stepId,
        state: structuredClone(state),
        createdAt: new Date().toISOString(),
        ...(workflowId ? { workflowId } : {}),
      };
      const doc: Doc = {
        _id: cp.id,
        runId: cp.runId,
        stepId: cp.stepId,
        state: cp.state,
        createdAt: cp.createdAt,
        ...(cp.workflowId ? { workflowId: cp.workflowId } : {}),
      };
      await col.insertOne(doc);
      return cp;
    },
    async load(checkpointId) {
      const d = await col.findOne({ _id: checkpointId });
      return d ? docToCheckpoint(d) : null;
    },
    async latest(runId) {
      const d = await col.find({ runId }).sort({ createdAt: -1, _id: -1 }).limit(1).next();
      return d ? docToCheckpoint(d) : null;
    },
    async list(runId) {
      const docs = await col.find({ runId }).sort({ createdAt: 1, _id: 1 }).toArray();
      return docs.map(docToCheckpoint);
    },
    async delete(runId) {
      await col.deleteMany({ runId });
    },
  };
}
