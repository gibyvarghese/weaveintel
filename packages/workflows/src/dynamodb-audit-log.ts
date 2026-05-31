/**
 * DynamoDB-backed WorkflowAuditLog. Append-only.
 *
 * Layout: pk = "AUDIT#<runId>", sk = "<timestamp_padded>#<id>"; GSI on workflowId.
 */
import { type DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { WorkflowAuditEvent, WorkflowAuditLog } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

interface Item {
  pk: string;
  sk: string;
  id: string;
  runId: string;
  workflowId: string;
  type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface WeaveDynamoDbAuditLogOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** GSI on `workflowId` for listAll({ workflowId }). Defaults to `gsi_workflowId`. */
  workflowIdIndexName?: string;
}

function padTs(ts: string): string {
  return String(Date.parse(ts)).padStart(16, '0');
}

function toEvent(it: Item): WorkflowAuditEvent {
  return {
    id: it.id,
    runId: it.runId,
    workflowId: it.workflowId,
    type: it.type as WorkflowAuditEvent['type'],
    timestamp: it.timestamp,
    ...it.payload,
  } as WorkflowAuditEvent;
}

export function weaveDynamoDbAuditLog(opts: WeaveDynamoDbAuditLogOptions): WorkflowAuditLog {
  const { client, tableName } = opts;
  const wfIdx = opts.workflowIdIndexName ?? 'gsi_workflowId';
  const pk = (runId: string) => `AUDIT#${runId}`;

  return {
    async append(event) {
      const id = newUUIDv7();
      const { runId, workflowId, type, timestamp, ...rest } = event as WorkflowAuditEvent;
      const item: Item = {
        pk: pk(runId),
        sk: `${padTs(timestamp)}#${id}`,
        id,
        runId,
        workflowId,
        type,
        timestamp,
        payload: rest,
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async list(runId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk(runId) },
        ScanIndexForward: true,
      }));
      return ((r.Items as Item[] | undefined) ?? []).map(toEvent);
    },
    async listAll(o) {
      if (o?.workflowId) {
        const r = await client.send(new QueryCommand({
          TableName: tableName,
          IndexName: wfIdx,
          KeyConditionExpression: 'workflowId = :w',
          ExpressionAttributeValues: { ':w': o.workflowId },
          ScanIndexForward: true,
        }));
        const items = ((r.Items as Item[] | undefined) ?? []);
        items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const mapped = items.map(toEvent);
        return o.limit ? mapped.slice(-o.limit) : mapped;
      }
      const r = await client.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :p)',
        ExpressionAttributeValues: { ':p': 'AUDIT#' },
      }));
      const items = ((r.Items as Item[] | undefined) ?? []);
      items.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const mapped = items.map(toEvent);
      return o?.limit ? mapped.slice(-o.limit) : mapped;
    },
  };
}
