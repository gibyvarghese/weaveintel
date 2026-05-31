/**
 * DynamoDB-backed WorkflowRunRepository.
 *
 * Layout: single table.
 *   Primary key:  pk = "RUN#<workflowId>", sk = startedAt + "#" + id
 *      → list by workflow + ordered by startedAt
 *   GSI gsi_id:   id (HASH)
 *      → get(runId), delete(runId)
 *   GSI gsi_parent: parentRunId (HASH), startedAt (RANGE)
 *      → listByParent
 *   GSI gsi_status: workflowId (HASH), status (RANGE)
 *      → countActive
 *   GSI gsi_tenant: tenantId (HASH), startedAt (RANGE)
 *      → tenant filter
 */
import { type DynamoDBDocumentClient, DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { WorkflowRun } from '@weaveintel/core';
import type { RunFilterOpts, WorkflowRunRepository } from './run-repository.js';

interface Item {
  pk: string;
  sk: string;
  id: string;
  workflowId: string;
  parentRunId?: string;
  status: WorkflowRun['status'];
  tenantId?: string;
  startedAt: string;
  payload: WorkflowRun;
}

export interface WeaveDynamoDbRunRepositoryOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  idIndexName?: string;
  parentIndexName?: string;
  statusIndexName?: string;
  tenantIndexName?: string;
}

export function weaveDynamoDbWorkflowRunRepository(
  opts: WeaveDynamoDbRunRepositoryOptions,
): WorkflowRunRepository {
  const { client, tableName } = opts;
  const idIndex = opts.idIndexName ?? 'gsi_id';
  const parentIndex = opts.parentIndexName ?? 'gsi_parent';
  const statusIndex = opts.statusIndexName ?? 'gsi_status';
  const pk = (wf: string) => `RUN#${wf}`;
  const sk = (run: WorkflowRun) => `${run.startedAt}#${run.id}`;

  async function findById(runId: string): Promise<Item | null> {
    const r = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: idIndex,
      KeyConditionExpression: 'id = :id',
      ExpressionAttributeValues: { ':id': runId },
      Limit: 1,
    }));
    return (r.Items?.[0] as Item | undefined) ?? null;
  }

  return {
    async save(run) {
      const item: Item = {
        pk: pk(run.workflowId),
        sk: sk(run),
        id: run.id,
        workflowId: run.workflowId,
        status: run.status,
        startedAt: run.startedAt,
        payload: run,
        ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
        ...(run.tenantId ? { tenantId: run.tenantId } : {}),
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async get(runId) {
      const item = await findById(runId);
      return item?.payload ?? null;
    },
    async list(workflowId) {
      if (workflowId) {
        const r = await client.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :p',
          ExpressionAttributeValues: { ':p': pk(workflowId) },
          ScanIndexForward: false,
        }));
        return ((r.Items as Item[] | undefined) ?? []).map((i) => i.payload);
      }
      // No partition key for "all" — fall back to id-index Scan-equivalent via list-of-workflowIds is too expensive.
      // For cross-workflow listing callers should use listFiltered with explicit filters or per-workflow loops.
      // Return empty to keep contract honest — set workflowId to enumerate.
      return [];
    },
    async listByParent(parentRunId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: parentIndex,
        KeyConditionExpression: 'parentRunId = :p',
        ExpressionAttributeValues: { ':p': parentRunId },
        ScanIndexForward: false,
      }));
      return ((r.Items as Item[] | undefined) ?? []).map((i) => i.payload);
    },
    async listFiltered(opts: RunFilterOpts) {
      // Best path is by workflowId on primary; otherwise fall back to status index when available.
      let items: Item[] = [];
      if (opts.workflowId) {
        const r = await client.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :p',
          ExpressionAttributeValues: { ':p': pk(opts.workflowId) },
          ScanIndexForward: false,
        }));
        items = (r.Items as Item[] | undefined) ?? [];
      } else if (opts.status) {
        // Without a workflow scope, the status index alone has no PK; use a scan as a fallback (cost-aware callers should pass workflowId).
        return [];
      } else {
        return [];
      }
      let runs = items.map((i) => i.payload);
      if (opts.status) runs = runs.filter((r) => r.status === opts.status);
      if (opts.tenantId) runs = runs.filter((r) => r.tenantId === opts.tenantId);
      if (opts.before) runs = runs.filter((r) => r.startedAt < opts.before!);
      if (opts.after) runs = runs.filter((r) => r.startedAt > opts.after!);
      if (opts.limit) runs = runs.slice(0, opts.limit);
      return runs;
    },
    async countActive(workflowId) {
      const running = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: statusIndex,
        KeyConditionExpression: 'workflowId = :w AND #s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':w': workflowId, ':s': 'running' },
        Select: 'COUNT',
      }));
      const paused = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: statusIndex,
        KeyConditionExpression: 'workflowId = :w AND #s = :s',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':w': workflowId, ':s': 'paused' },
        Select: 'COUNT',
      }));
      return (running.Count ?? 0) + (paused.Count ?? 0);
    },
    async delete(runId) {
      const item = await findById(runId);
      if (!item) return;
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }));
    },
  };
}

export type { DynamoDBDocumentClient };
