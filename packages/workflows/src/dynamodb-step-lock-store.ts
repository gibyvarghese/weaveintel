/**
 * DynamoDB-backed StepLockStore.
 *
 * Layout: pk = "LOCK#<runId>", sk = "S#<stepId>"
 */
import { type DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { StepLockStore } from './step-lock-store.js';

interface Item {
  pk: string;
  sk: string;
  runId: string;
  stepId: string;
  state: 'locked' | 'done';
  lockedAt: string;
  doneAt?: string;
  output?: unknown;
}

export interface WeaveDynamoDbStepLockStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
}

export function weaveDynamoDbStepLockStore(
  opts: WeaveDynamoDbStepLockStoreOptions,
): StepLockStore {
  const { client, tableName } = opts;
  const pk = (runId: string) => `LOCK#${runId}`;
  const sk = (stepId: string) => `S#${stepId}`;

  return {
    async lock(runId, stepId) {
      try {
        const item: Item = {
          pk: pk(runId),
          sk: sk(stepId),
          runId,
          stepId,
          state: 'locked',
          lockedAt: new Date().toISOString(),
        };
        await client.send(new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
      } catch (e) {
        const errName = (e as { name?: string }).name;
        if (errName !== 'ConditionalCheckFailedException') throw e;
        // Already locked; idempotent.
      }
    },
    async markDone(runId, stepId, output) {
      const now = new Date().toISOString();
      await client.send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: pk(runId), sk: sk(stepId) },
        UpdateExpression: 'SET #s = :done, doneAt = :n, #o = :o, runId = :r, stepId = :st, lockedAt = if_not_exists(lockedAt, :n)',
        ExpressionAttributeNames: { '#s': 'state', '#o': 'output' },
        ExpressionAttributeValues: { ':done': 'done', ':n': now, ':o': output ?? null, ':r': runId, ':st': stepId },
      }));
    },
    async isDone(runId, stepId) {
      const r = await client.send(new GetCommand({ TableName: tableName, Key: { pk: pk(runId), sk: sk(stepId) } }));
      const item = r.Item as Item | undefined;
      if (item?.state === 'done') return { done: true, output: item.output };
      return { done: false };
    },
    async isLocked(runId, stepId) {
      const r = await client.send(new GetCommand({ TableName: tableName, Key: { pk: pk(runId), sk: sk(stepId) } }));
      return !!r.Item;
    },
    async clear(runId) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': pk(runId) },
        ProjectionExpression: 'pk, sk',
      }));
      for (const it of (r.Items as Pick<Item, 'pk' | 'sk'>[] | undefined) ?? []) {
        await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: it.pk, sk: it.sk } }));
      }
    },
  };
}
