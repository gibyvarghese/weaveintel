/**
 * DynamoDB-backed StepIdempotencyStore.
 *
 * Layout: pk = "IDEM#<key>", sk = "META"
 */
import { type DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { StepIdempotencyStore } from './idempotency-store.js';

interface Item { pk: string; sk: string; key: string; output: unknown; createdAt: string; }

export interface WeaveDynamoDbIdempotencyStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
}

export function weaveDynamoDbIdempotencyStore(
  opts: WeaveDynamoDbIdempotencyStoreOptions,
): StepIdempotencyStore {
  const { client, tableName } = opts;
  const pk = (k: string) => `IDEM#${k}`;

  return {
    async get(key) {
      const r = await client.send(new GetCommand({ TableName: tableName, Key: { pk: pk(key), sk: 'META' } }));
      const item = r.Item as Item | undefined;
      return item ? item.output : undefined;
    },
    async set(key, output) {
      const item: Item = {
        pk: pk(key),
        sk: 'META',
        key,
        output: output ?? null,
        createdAt: new Date().toISOString(),
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async delete(key) {
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: pk(key), sk: 'META' } }));
    },
    async clearPrefix(prefix) {
      // Scan IDEM# entries with `begins_with(key, prefix)`.
      const r = await client.send(new ScanCommand({
        TableName: tableName,
        FilterExpression: 'begins_with(pk, :ip) AND begins_with(#k, :p)',
        ExpressionAttributeNames: { '#k': 'key' },
        ExpressionAttributeValues: { ':ip': 'IDEM#', ':p': prefix },
      }));
      for (const it of (r.Items as Item[] | undefined) ?? []) {
        await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: it.pk, sk: it.sk } }));
      }
    },
  };
}

export { QueryCommand as _DynamoQueryCommand };
