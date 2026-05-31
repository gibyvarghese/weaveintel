/**
 * DynamoDB-backed DurableSleepStore.
 *
 * Layout: pk = "SLEEP", sk = "<wakeAt_padded>#<runId>"; GSI on runId for cancel().
 * For a small/medium scheduler this is fine; high-volume deployments should shard `pk` by hour.
 */
import { type DynamoDBDocumentClient, DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { SleepRecord, DurableSleepStore } from '@weaveintel/core';

interface Item { pk: string; sk: string; runId: string; wakeAt: number; createdAt: string; }

export interface WeaveDynamoDbSleepStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** GSI on `runId` so we can cancel/find by run. Defaults to `gsi_runId`. */
  runIdIndexName?: string;
}

function padWake(wakeAt: number): string {
  return String(wakeAt).padStart(16, '0');
}

function toRecord(it: Item): SleepRecord {
  return { runId: it.runId, wakeAt: it.wakeAt, createdAt: it.createdAt };
}

export function weaveDynamoDbSleepStore(opts: WeaveDynamoDbSleepStoreOptions): DurableSleepStore {
  const { client, tableName } = opts;
  const runIdIdx = opts.runIdIndexName ?? 'gsi_runId';
  const PK = 'SLEEP';
  const sk = (wakeAt: number, runId: string) => `${padWake(wakeAt)}#${runId}`;

  async function findItemsByRun(runId: string): Promise<Item[]> {
    const r = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: runIdIdx,
      KeyConditionExpression: 'runId = :r',
      ExpressionAttributeValues: { ':r': runId },
    }));
    return (r.Items as Item[] | undefined) ?? [];
  }

  return {
    async schedule(runId, wakeAt) {
      // Replace any existing entries for this runId, then put fresh.
      const existing = await findItemsByRun(runId);
      for (const it of existing) {
        await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: it.pk, sk: it.sk } }));
      }
      const item: Item = {
        pk: PK,
        sk: sk(wakeAt, runId),
        runId,
        wakeAt,
        createdAt: new Date().toISOString(),
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async cancel(runId) {
      const items = await findItemsByRun(runId);
      for (const it of items) {
        await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: it.pk, sk: it.sk } }));
      }
    },
    async getDue(now = Date.now()) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p AND sk <= :s',
        ExpressionAttributeValues: { ':p': PK, ':s': `${padWake(now)}#~` },
      }));
      return ((r.Items as Item[] | undefined) ?? []).map(toRecord);
    },
    async list() {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': PK },
      }));
      return ((r.Items as Item[] | undefined) ?? []).map(toRecord);
    },
  };
}
