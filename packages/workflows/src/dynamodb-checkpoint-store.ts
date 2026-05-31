/**
 * DynamoDB-backed CheckpointStore.
 *
 * Layout: single table keyed by `pk = "RUN#<runId>"`, `sk = "CP#<createdAt>#<id>"`
 * — naturally sorts checkpoints by run + time.  `id` is also stored as a
 * top-level attribute for `load(id)` via GSI on `id`.
 */
import { type DynamoDBDocumentClient, GetCommand, DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { WorkflowCheckpoint, WorkflowState } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { CheckpointStore } from './checkpoint-store.js';

interface Item {
  pk: string;
  sk: string;
  id: string;
  runId: string;
  workflowId?: string;
  stepId: string;
  state: WorkflowState;
  createdAt: string;
}

function itemToCheckpoint(it: Item): WorkflowCheckpoint {
  return {
    id: it.id,
    runId: it.runId,
    stepId: it.stepId,
    state: it.state,
    createdAt: it.createdAt,
    ...(it.workflowId ? { workflowId: it.workflowId } : {}),
  };
}

export interface WeaveDynamoDbCheckpointStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** GSI on `id` for `load(checkpointId)` lookups. Defaults to `gsi_id`. */
  idIndexName?: string;
}

export function weaveDynamoDbCheckpointStore(
  opts: WeaveDynamoDbCheckpointStoreOptions,
): CheckpointStore {
  const { client, tableName } = opts;
  const idIndex = opts.idIndexName ?? 'gsi_id';
  const pk = (runId: string) => `RUN#${runId}`;

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
      const item: Item = {
        pk: pk(runId),
        sk: `CP#${cp.createdAt}#${cp.id}`,
        id: cp.id,
        runId,
        stepId: cp.stepId,
        state: cp.state,
        createdAt: cp.createdAt,
        ...(cp.workflowId ? { workflowId: cp.workflowId } : {}),
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
      return cp;
    },
    async load(checkpointId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: idIndex,
        KeyConditionExpression: 'id = :id',
        ExpressionAttributeValues: { ':id': checkpointId },
        Limit: 1,
      }));
      const item = r.Items?.[0] as Item | undefined;
      return item ? itemToCheckpoint(item) : null;
    },
    async latest(runId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':p': pk(runId), ':prefix': 'CP#' },
        ScanIndexForward: false,
        Limit: 1,
      }));
      const item = r.Items?.[0] as Item | undefined;
      return item ? itemToCheckpoint(item) : null;
    },
    async list(runId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':p': pk(runId), ':prefix': 'CP#' },
        ScanIndexForward: true,
      }));
      return (r.Items as Item[] | undefined ?? []).map(itemToCheckpoint);
    },
    async delete(runId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':p': pk(runId), ':prefix': 'CP#' },
        ProjectionExpression: 'pk, sk',
      }));
      const items = (r.Items as Pick<Item, 'pk' | 'sk'>[] | undefined) ?? [];
      for (const it of items) {
        await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: it.pk, sk: it.sk } }));
      }
    },
  };
}

// Re-export GetCommand for callers that want to construct custom keys; also keeps the import used.
export { GetCommand as _DynamoGetCommand };
