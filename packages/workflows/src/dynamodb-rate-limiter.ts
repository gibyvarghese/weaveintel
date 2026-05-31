/**
 * DynamoDB-backed WorkflowRateLimiter (token bucket).
 *
 * Layout: pk = "RL", sk = "<workflowId>"
 */
import { type DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { WorkflowRateLimiter } from './rate-limiter.js';

interface Item { pk: string; sk: string; tokens: number; lastRefillMs: number; }
interface Bucket { tokens: number; lastRefillMs: number; }

export interface WeaveDynamoDbRateLimiterOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
}

function refill(bucket: Bucket, maxPerMinute: number, nowMs: number): Bucket {
  const elapsedMinutes = (nowMs - bucket.lastRefillMs) / 60_000;
  const refilled = Math.min(maxPerMinute, bucket.tokens + elapsedMinutes * maxPerMinute);
  return { tokens: refilled, lastRefillMs: nowMs };
}

export function weaveDynamoDbRateLimiter(
  opts: WeaveDynamoDbRateLimiterOptions,
): WorkflowRateLimiter {
  const { client, tableName } = opts;
  const PK = 'RL';

  async function read(workflowId: string, maxPerMinute: number): Promise<Bucket> {
    const r = await client.send(new GetCommand({ TableName: tableName, Key: { pk: PK, sk: workflowId } }));
    const item = r.Item as Item | undefined;
    return item
      ? { tokens: item.tokens, lastRefillMs: item.lastRefillMs }
      : { tokens: maxPerMinute, lastRefillMs: Date.now() };
  }
  async function write(workflowId: string, bucket: Bucket): Promise<void> {
    const item: Item = { pk: PK, sk: workflowId, tokens: bucket.tokens, lastRefillMs: bucket.lastRefillMs };
    await client.send(new PutCommand({ TableName: tableName, Item: item }));
  }

  return {
    async allow(workflowId, maxRunsPerMinute) {
      const now = Date.now();
      const bucket = refill(await read(workflowId, maxRunsPerMinute), maxRunsPerMinute, now);
      if (bucket.tokens < 1) {
        await write(workflowId, bucket);
        return false;
      }
      await write(workflowId, { tokens: bucket.tokens - 1, lastRefillMs: bucket.lastRefillMs });
      return true;
    },
    async remaining(workflowId, maxRunsPerMinute) {
      const now = Date.now();
      return Math.floor(refill(await read(workflowId, maxRunsPerMinute), maxRunsPerMinute, now).tokens);
    },
    async reset(workflowId) {
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: PK, sk: workflowId } }));
    },
  };
}
