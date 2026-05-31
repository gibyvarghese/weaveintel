/**
 * DynamoDB-backed PayloadStore.
 *
 * Layout: pk = "PL#<runId>", sk = "K#<key>"
 */
import { type DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { PayloadStore } from './payload-store.js';

interface Item { pk: string; sk: string; key: string; runId: string; data: unknown; createdAt: string; }

export interface WeaveDynamoDbPayloadStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
}

function extractRunId(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(0, idx) : key;
}

export function weaveDynamoDbPayloadStore(
  opts: WeaveDynamoDbPayloadStoreOptions,
): PayloadStore {
  const { client, tableName } = opts;
  const pk = (runId: string) => `PL#${runId}`;
  const sk = (key: string) => `K#${key}`;

  return {
    async put(key, data) {
      const runId = extractRunId(key);
      const item: Item = {
        pk: pk(runId),
        sk: sk(key),
        key,
        runId,
        data: data ?? null,
        createdAt: new Date().toISOString(),
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async get(key) {
      const runId = extractRunId(key);
      const r = await client.send(new GetCommand({ TableName: tableName, Key: { pk: pk(runId), sk: sk(key) } }));
      const item = r.Item as Item | undefined;
      return item ? item.data : undefined;
    },
    async delete(key) {
      const runId = extractRunId(key);
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: pk(runId), sk: sk(key) } }));
    },
    async deleteRun(runId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk(runId) },
        ProjectionExpression: 'pk, sk',
      }));
      for (const it of ((r.Items as Pick<Item, 'pk' | 'sk'>[] | undefined) ?? [])) {
        await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: it.pk, sk: it.sk } }));
      }
    },
  };
}
