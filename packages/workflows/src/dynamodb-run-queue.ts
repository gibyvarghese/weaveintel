/**
 * DynamoDB-backed WorkflowRunQueue.
 *
 * Layout: pk = "Q#<workflowId>", sk = "<priority_inv_padded>#<queuedAt_padded>#<id>"
 *   priority_inv = (9999 - priority) padded so high priority sorts first ascending.
 * GSI on `id` for `remove(entryId)`.
 */
import { type DynamoDBDocumentClient, DeleteCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { newUUIDv7 } from '@weaveintel/core';
import type { RunQueueEntry, WorkflowRunQueue } from './run-queue.js';

interface Item {
  pk: string;
  sk: string;
  id: string;
  runId: string;
  workflowId: string;
  input: Record<string, unknown>;
  priority: number;
  queuedAt: string;
  opts: RunQueueEntry['opts'];
}

export interface WeaveDynamoDbRunQueueOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** GSI on `id` for remove-by-entryId. Defaults to `gsi_id`. */
  idIndexName?: string;
}

function padPriorityInv(priority: number): string {
  return String(Math.max(0, 9999 - priority)).padStart(5, '0');
}
function padQueuedAt(ts: string): string {
  return String(Date.parse(ts)).padStart(16, '0');
}

function toEntry(it: Item): RunQueueEntry {
  return {
    id: it.id,
    runId: it.runId,
    workflowId: it.workflowId,
    input: it.input,
    priority: it.priority,
    queuedAt: it.queuedAt,
    opts: it.opts,
  };
}

export function weaveDynamoDbRunQueue(opts: WeaveDynamoDbRunQueueOptions): WorkflowRunQueue {
  const { client, tableName } = opts;
  const idIdx = opts.idIndexName ?? 'gsi_id';
  const pk = (workflowId: string) => `Q#${workflowId}`;
  const sk = (priority: number, queuedAt: string, id: string) =>
    `${padPriorityInv(priority)}#${padQueuedAt(queuedAt)}#${id}`;

  async function lookupById(entryId: string): Promise<Item | null> {
    const r = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: idIdx,
      KeyConditionExpression: 'id = :i',
      ExpressionAttributeValues: { ':i': entryId },
      Limit: 1,
    }));
    return (r.Items?.[0] as Item | undefined) ?? null;
  }

  return {
    async enqueue(entry) {
      const full: RunQueueEntry = { id: newUUIDv7(), queuedAt: new Date().toISOString(), ...entry };
      const item: Item = {
        pk: pk(full.workflowId),
        sk: sk(full.priority, full.queuedAt, full.id),
        id: full.id,
        runId: full.runId,
        workflowId: full.workflowId,
        input: full.input,
        priority: full.priority,
        queuedAt: full.queuedAt,
        opts: full.opts,
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
      return full;
    },
    async dequeue(workflowId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk(workflowId) },
        ScanIndexForward: true,
        Limit: 1,
      }));
      const item = r.Items?.[0] as Item | undefined;
      if (!item) return null;
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }));
      return toEntry(item);
    },
    async remove(entryId) {
      const item = await lookupById(entryId);
      if (item) {
        await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: item.pk, sk: item.sk } }));
      }
    },
    async size() {
      const r = await client.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': 'Q#' },
        Select: 'COUNT',
      }));
      return r.Count ?? 0;
    },
    async sizeFor(workflowId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk(workflowId) },
        Select: 'COUNT',
      }));
      return r.Count ?? 0;
    },
    async listFor(workflowId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk(workflowId) },
        ScanIndexForward: true,
      }));
      return ((r.Items as Item[] | undefined) ?? []).map(toEntry);
    },
    async listAll() {
      const r = await client.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': 'Q#' },
      }));
      const items = ((r.Items as Item[] | undefined) ?? []);
      items.sort((a, b) => a.sk.localeCompare(b.sk));
      return items.map(toEntry);
    },
  };
}
