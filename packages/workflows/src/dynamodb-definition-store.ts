/**
 * DynamoDB-backed WorkflowDefinitionStore.
 *
 * Layout: single table keyed by `pk = "DEF"`, `sk = id`. Lookup by name via
 * GSI on `name`. Listing is a Query on partition pk='DEF'.
 */
import { type DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { WorkflowDefinition } from '@weaveintel/core';
import type { WorkflowDefinitionStore } from './definition-store.js';

interface Item {
  pk: string;
  sk: string;
  id: string;
  name: string;
  payload: WorkflowDefinition;
  updatedAt: string;
}

export interface WeaveDynamoDbDefinitionStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** GSI on `name` for `get(byName)` lookups. */
  nameIndexName?: string;
}

export function weaveDynamoDbWorkflowDefinitionStore(
  opts: WeaveDynamoDbDefinitionStoreOptions,
): WorkflowDefinitionStore {
  const { client, tableName } = opts;
  const nameIndex = opts.nameIndexName ?? 'gsi_name';

  return {
    async list() {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': 'DEF' },
      }));
      const items = (r.Items as Item[] | undefined) ?? [];
      return items
        .map((i) => i.payload)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    },
    async get(idOrKey) {
      const byId = await client.send(new GetCommand({ TableName: tableName, Key: { pk: 'DEF', sk: idOrKey } }));
      if (byId.Item) return (byId.Item as Item).payload;
      const byName = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: nameIndex,
        KeyConditionExpression: '#n = :n',
        ExpressionAttributeNames: { '#n': 'name' },
        ExpressionAttributeValues: { ':n': idOrKey },
        Limit: 1,
      }));
      const item = byName.Items?.[0] as Item | undefined;
      return item?.payload ?? null;
    },
    async save(def) {
      const now = new Date().toISOString();
      const saved: WorkflowDefinition = {
        ...def,
        updatedAt: now,
        createdAt: def.createdAt ?? now,
      };
      const item: Item = {
        pk: 'DEF',
        sk: saved.id,
        id: saved.id,
        name: saved.name,
        payload: saved,
        updatedAt: saved.updatedAt ?? now,
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
      return saved;
    },
    async delete(id) {
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: 'DEF', sk: id } }));
    },
  };
}
