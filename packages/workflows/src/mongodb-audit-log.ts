/**
 * MongoDB-backed WorkflowAuditLog. Append-only.
 */
import type { Db } from 'mongodb';
import type { WorkflowAuditEvent, WorkflowAuditLog } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

interface Doc {
  _id: string;
  runId: string;
  workflowId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface WeaveMongoDbAuditLogOptions {
  db: Db;
  collection?: string;
  ensureIndexes?: boolean;
}

function toEvent(d: Doc): WorkflowAuditEvent {
  return {
    id: d._id,
    runId: d.runId,
    workflowId: d.workflowId,
    type: d.type as WorkflowAuditEvent['type'],
    timestamp: d.timestamp,
    ...d.payload,
  } as WorkflowAuditEvent;
}

export async function weaveMongoDbAuditLog(
  opts: WeaveMongoDbAuditLogOptions,
): Promise<WorkflowAuditLog> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_audit_events');
  if (opts.ensureIndexes !== false) {
    await col.createIndex({ runId: 1, timestamp: 1, _id: 1 });
    await col.createIndex({ workflowId: 1, timestamp: 1, _id: 1 });
  }
  return {
    async append(event) {
      const { runId, workflowId, type, timestamp, ...rest } = event as WorkflowAuditEvent;
      const doc: Doc = {
        _id: newUUIDv7(),
        runId,
        workflowId,
        type,
        timestamp,
        payload: rest,
      };
      await col.insertOne(doc);
    },
    async list(runId) {
      const docs = await col.find({ runId }).sort({ timestamp: 1, _id: 1 }).toArray();
      return docs.map(toEvent);
    },
    async listAll(o) {
      const filter: Record<string, unknown> = {};
      if (o?.workflowId) filter['workflowId'] = o.workflowId;
      const docs = await col.find(filter).sort({ timestamp: 1, _id: 1 }).toArray();
      const mapped = docs.map(toEvent);
      return o?.limit ? mapped.slice(-o.limit) : mapped;
    },
  };
}
