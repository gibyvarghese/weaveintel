/** AWS DynamoDB (cloud NoSQL) backed durable memory store. */

import type { ExecutionContext, MemoryEntry } from '@weaveintel/core';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { type DurableMemoryStore, applyMemoryQuery } from './memory-internal.js';

export function weaveCloudNoSqlMemoryStore(opts: {
  provider: 'dynamodb';
  dynamodb: {
    endpoint?: string;
    region?: string;
    tableName?: string;
  };
}): DurableMemoryStore {
  const region = opts.dynamodb.region ?? 'us-east-1';
  const tableName = opts.dynamodb.tableName ?? 'memory_entries';
  // H-17: Only inject fake local credentials when the endpoint is a loopback
  // or localhost address. Injecting `{ accessKeyId: 'local', ... }` for a real
  // AWS endpoint overrides the SDK's default credential chain (IAM role, env
  // vars, etc.), causing all requests to that endpoint to fail with 403.
  function isLocalEndpoint(url: string): boolean {
    try {
      const { hostname } = new URL(url);
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    } catch {
      return false;
    }
  }
  const client = new DynamoDBClient({
    endpoint: opts.dynamodb.endpoint,
    region,
    credentials:
      opts.dynamodb.endpoint && isLocalEndpoint(opts.dynamodb.endpoint)
        ? { accessKeyId: 'local', secretAccessKey: 'local' }
        : undefined,
  });
  const docClient = DynamoDBDocumentClient.from(client);

  async function ensureTable(): Promise<void> {
    try {
      await client.send(new DescribeTableCommand({ TableName: tableName }));
      return;
    } catch (error) {
      if (!(error instanceof ResourceNotFoundException)) {
        throw error;
      }
    }
    await client.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
    }));
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  }

  return {
    async write(_ctx, entries): Promise<void> {
      await ensureTable();
      for (const entry of entries) {
        await docClient.send(new PutCommand({
          TableName: tableName,
          Item: {
            pk: 'memory',
            sk: entry.id,
            entry,
            updatedAt: new Date().toISOString(),
          },
        }));
      }
    },
    async query(_ctx, options): Promise<MemoryEntry[]> {
      await ensureTable();
      const result = await docClient.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': 'memory' },
      }));
      const rows = (result.Items ?? []).map((item) => item['entry'] as MemoryEntry);
      return applyMemoryQuery(rows, options);
    },
    async delete(_ctx, ids): Promise<void> {
      await ensureTable();
      for (const id of ids) {
        await docClient.send(new DeleteCommand({
          TableName: tableName,
          Key: { pk: 'memory', sk: id },
        }));
      }
    },
    async clear(ctx: ExecutionContext, filter): Promise<void> {
      const rows = await this.query(ctx, { filter, topK: Number.MAX_SAFE_INTEGER });
      await this.delete(ctx, rows.map((row) => row.id));
    },
    async close(): Promise<void> {
      await client.destroy();
    },
  };
}
