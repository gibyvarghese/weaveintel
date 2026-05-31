/**
 * MongoDB-backed WorkflowRunQueue.
 */
import type { Db } from 'mongodb';
import { newUUIDv7 } from '@weaveintel/core';
import type { RunQueueEntry, WorkflowRunQueue } from './run-queue.js';

interface Doc {
  _id: string;
  runId: string;
  workflowId: string;
  input: Record<string, unknown>;
  priority: number;
  queuedAt: string;
  opts: RunQueueEntry['opts'];
}

export interface WeaveMongoDbRunQueueOptions {
  db: Db;
  collection?: string;
  ensureIndexes?: boolean;
}

function toEntry(d: Doc): RunQueueEntry {
  return {
    id: d._id,
    runId: d.runId,
    workflowId: d.workflowId,
    input: d.input,
    priority: d.priority,
    queuedAt: d.queuedAt,
    opts: d.opts,
  };
}

export async function weaveMongoDbRunQueue(
  opts: WeaveMongoDbRunQueueOptions,
): Promise<WorkflowRunQueue> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_run_queue');
  if (opts.ensureIndexes !== false) {
    await col.createIndex({ workflowId: 1, priority: -1, queuedAt: 1, _id: 1 });
  }

  return {
    async enqueue(entry) {
      const full: RunQueueEntry = { id: newUUIDv7(), queuedAt: new Date().toISOString(), ...entry };
      const doc: Doc = {
        _id: full.id,
        runId: full.runId,
        workflowId: full.workflowId,
        input: full.input,
        priority: full.priority,
        queuedAt: full.queuedAt,
        opts: full.opts,
      };
      await col.insertOne(doc);
      return full;
    },
    async dequeue(workflowId) {
      const d = await col.findOneAndDelete(
        { workflowId },
        { sort: { priority: -1, queuedAt: 1, _id: 1 } },
      );
      // mongodb v6 returns the doc directly (not wrapped). Older versions wrap in `{ value }`.
      const raw = (d && typeof d === 'object' && 'value' in d ? (d as { value: Doc | null }).value : (d as Doc | null));
      return raw ? toEntry(raw) : null;
    },
    async remove(entryId) {
      await col.deleteOne({ _id: entryId });
    },
    async size() {
      return col.countDocuments({});
    },
    async sizeFor(workflowId) {
      return col.countDocuments({ workflowId });
    },
    async listFor(workflowId) {
      const docs = await col.find({ workflowId }).sort({ priority: -1, queuedAt: 1, _id: 1 }).toArray();
      return docs.map(toEntry);
    },
    async listAll() {
      const docs = await col.find({}).sort({ priority: -1, queuedAt: 1, _id: 1 }).toArray();
      return docs.map(toEntry);
    },
  };
}
