/**
 * MongoDB-backed WorkflowRunRepository.
 */
import type { Db, Filter } from 'mongodb';
import type { WorkflowRun } from '@weaveintel/core';
import type { RunFilterOpts, WorkflowRunRepository } from './run-repository.js';

interface Doc {
  _id: string;
  workflowId: string;
  parentRunId?: string;
  status: WorkflowRun['status'];
  tenantId?: string;
  startedAt: string;
  payload: WorkflowRun;
}

export interface WeaveMongoDbRunRepositoryOptions {
  db: Db;
  collection?: string;
  ensureIndexes?: boolean;
}

export async function weaveMongoDbWorkflowRunRepository(
  opts: WeaveMongoDbRunRepositoryOptions,
): Promise<WorkflowRunRepository> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_runs');
  if (opts.ensureIndexes !== false) {
    await col.createIndex({ workflowId: 1, startedAt: -1 });
    await col.createIndex({ parentRunId: 1 });
    await col.createIndex({ status: 1 });
    await col.createIndex({ tenantId: 1 });
  }

  return {
    async save(run) {
      const doc: Doc = {
        _id: run.id,
        workflowId: run.workflowId,
        status: run.status,
        startedAt: run.startedAt,
        payload: run,
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
        ...(run.tenantId ? { tenantId: run.tenantId } : {}),
      };
      await col.replaceOne({ _id: run.id }, doc, { upsert: true });
    },
    async get(runId) {
      const d = await col.findOne({ _id: runId });
      return d?.payload ?? null;
    },
    async list(workflowId) {
      const filter: Filter<Doc> = workflowId ? { workflowId } : {};
      const docs = await col.find(filter).sort({ startedAt: -1 }).toArray();
      return docs.map((d) => d.payload);
    },
    async listByParent(parentRunId) {
      const docs = await col.find({ parentRunId }).sort({ startedAt: -1 }).toArray();
      return docs.map((d) => d.payload);
    },
    async listFiltered(opts: RunFilterOpts) {
      const filter: Filter<Doc> = {};
      if (opts.workflowId) filter.workflowId = opts.workflowId;
      if (opts.status) filter.status = opts.status;
      if (opts.tenantId) filter.tenantId = opts.tenantId;
      const startedAt: Record<string, string> = {};
      if (opts.before) startedAt['$lt'] = opts.before;
      if (opts.after) startedAt['$gt'] = opts.after;
      if (Object.keys(startedAt).length) filter.startedAt = startedAt;
      let cur = col.find(filter).sort({ startedAt: -1 });
      if (opts.limit) cur = cur.limit(opts.limit);
      const docs = await cur.toArray();
      return docs.map((d) => d.payload);
    },
    async countActive(workflowId) {
      return col.countDocuments({ workflowId, status: { $in: ['running', 'paused'] } });
    },
    async delete(runId) {
      await col.deleteOne({ _id: runId });
    },
  };
}
