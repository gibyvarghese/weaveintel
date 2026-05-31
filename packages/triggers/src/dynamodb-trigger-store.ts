/**
 * DynamoDB-backed TriggerStore.
 *
 * Single-table layout:
 *   Triggers:    pk="TRIGGER",            sk="<id>"          + GSI gsi_key on `key`
 *   Invocations: pk="INV#<triggerId>",    sk="<firedAt_pad>#<id>"
 *                 + GSI gsi_inv_status on (status, sk_status="<firedAt_pad>#<id>")
 *                 + GSI gsi_inv_all on (inv_partition="ALL", sk_all="<firedAt_pad>#<id>")
 */
import {
  type DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { newUUIDv7 } from '@weaveintel/core';
import type {
  Trigger,
  TriggerInvocation,
  TriggerStore,
  ListInvocationsFilter,
} from './dispatcher.js';

const FIRED_AT_PAD = 16;
const padScore = (n: number): string => String(n).padStart(FIRED_AT_PAD, '0');

interface TriggerItem extends Trigger {
  pk: string; // "TRIGGER"
  sk: string; // id
}
interface InvocationItem extends TriggerInvocation {
  pk: string; // INV#<triggerId>
  sk: string; // <firedAtPad>#<id>
  sk_status: string;
  inv_partition: string;
  sk_all: string;
}

export interface WeaveDynamoDbTriggerStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** GSI on `key` for getByKey. Default: `gsi_key`. */
  keyIndexName?: string;
  /** GSI on (status, sk_status) for status filter. Default: `gsi_inv_status`. */
  invStatusIndexName?: string;
  /** GSI on (inv_partition, sk_all) for fleet list. Default: `gsi_inv_all`. */
  invAllIndexName?: string;
}

function itemToTrigger(it: TriggerItem): Trigger {
  const { pk: _pk, sk: _sk, ...rest } = it;
  void _pk; void _sk;
  return rest;
}
function itemToInvocation(it: InvocationItem): TriggerInvocation {
  const { pk: _pk, sk: _sk, sk_status: _ss, inv_partition: _ip, sk_all: _sa, ...rest } = it;
  void _pk; void _sk; void _ss; void _ip; void _sa;
  return rest;
}

export function weaveDynamoDbTriggerStore(opts: WeaveDynamoDbTriggerStoreOptions): TriggerStore {
  const { client, tableName } = opts;
  const keyIndex = opts.keyIndexName ?? 'gsi_key';
  const invStatusIndex = opts.invStatusIndexName ?? 'gsi_inv_status';
  const invAllIndex = opts.invAllIndexName ?? 'gsi_inv_all';
  const TRIGGER_PK = 'TRIGGER';
  const ALL_INV_PK = 'ALL';

  return {
    async list() {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :p',
        ExpressionAttributeValues: { ':p': TRIGGER_PK },
      }));
      const items = (r.Items as TriggerItem[] | undefined ?? []).map(itemToTrigger);
      items.sort((a, b) => a.key.localeCompare(b.key));
      return items;
    },
    async get(id) {
      const r = await client.send(new GetCommand({ TableName: tableName, Key: { pk: TRIGGER_PK, sk: id } }));
      const it = r.Item as TriggerItem | undefined;
      return it ? itemToTrigger(it) : null;
    },
    async getByKey(key) {
      const r = await client.send(new QueryCommand({
        TableName: tableName,
        IndexName: keyIndex,
        KeyConditionExpression: '#k = :k',
        ExpressionAttributeNames: { '#k': 'key' },
        ExpressionAttributeValues: { ':k': key },
        Limit: 1,
      }));
      const it = r.Items?.[0] as TriggerItem | undefined;
      return it ? itemToTrigger(it) : null;
    },
    async save(t) {
      const item: TriggerItem = { ...t, pk: TRIGGER_PK, sk: t.id };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async delete(id) {
      await client.send(new DeleteCommand({ TableName: tableName, Key: { pk: TRIGGER_PK, sk: id } }));
    },
    async recordInvocation(inv) {
      const id = inv.id || newUUIDv7();
      const stored: TriggerInvocation = { ...inv, id };
      const sk = `${padScore(inv.firedAt)}#${id}`;
      const item: InvocationItem = {
        ...stored,
        pk: `INV#${inv.triggerId}`,
        sk,
        sk_status: sk,
        inv_partition: ALL_INV_PK,
        sk_all: sk,
      };
      await client.send(new PutCommand({ TableName: tableName, Item: item }));
    },
    async listInvocations(filter: ListInvocationsFilter = {}) {
      const limit = filter.limit ?? 100;
      const offset = filter.offset ?? 0;
      const fetch = limit + offset;
      let items: InvocationItem[];
      if (filter.triggerId) {
        const r = await client.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'pk = :p',
          ExpressionAttributeValues: { ':p': `INV#${filter.triggerId}` },
          ScanIndexForward: false,
          Limit: fetch,
        }));
        items = (r.Items as InvocationItem[] | undefined ?? []);
        if (filter.status) items = items.filter((it) => it.status === filter.status);
      } else if (filter.status) {
        const r = await client.send(new QueryCommand({
          TableName: tableName,
          IndexName: invStatusIndex,
          KeyConditionExpression: '#s = :s',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': filter.status },
          ScanIndexForward: false,
          Limit: fetch,
        }));
        items = (r.Items as InvocationItem[] | undefined ?? []);
      } else {
        const r = await client.send(new QueryCommand({
          TableName: tableName,
          IndexName: invAllIndex,
          KeyConditionExpression: 'inv_partition = :p',
          ExpressionAttributeValues: { ':p': ALL_INV_PK },
          ScanIndexForward: false,
          Limit: fetch,
        }));
        items = (r.Items as InvocationItem[] | undefined ?? []);
      }
      return items.slice(offset, offset + limit).map(itemToInvocation);
    },
  };
}
