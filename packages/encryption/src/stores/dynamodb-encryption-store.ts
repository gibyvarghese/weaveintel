/**
 * DynamoDB-backed EncryptionStore.
 *
 * Caller provides a DynamoDBDocumentClient and 4 table names. Schema (operator
 * provisions out-of-band):
 *   policyTable: PK = tenantId (S)
 *   kekTable:    PK = id (S); GSI 'tenant-index' = tenantId (S) HASH, version (N) RANGE
 *   dekTable:    PK = id (S); GSI 'tenant-index' = tenantId (S) HASH, epoch (N) RANGE
 *   bikTable:    PK = id (S); GSI 'tenant-index' = tenantId (S) HASH, epoch (N) RANGE
 *
 * The package does not manage table creation — that stays operator land.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  EncryptionStore,
  TenantPolicyRecord,
  KekRecord,
  DekRecord,
  BikRecord,
  KeyStatus,
} from '../store.js';

export interface WeaveDynamoDbEncryptionStoreOptions {
  client: DynamoDBDocumentClient;
  policyTable: string;
  kekTable: string;
  dekTable: string;
  bikTable: string;
  tenantIndexName?: string;
}

export function weaveDynamoDbEncryptionStore(
  opts: WeaveDynamoDbEncryptionStoreOptions,
): EncryptionStore {
  const indexName = opts.tenantIndexName ?? 'tenant-index';
  const { client, policyTable, kekTable, dekTable, bikTable } = opts;

  async function queryByTenant<T>(table: string, tenantId: string, sortKey: 'version' | 'epoch'): Promise<T[]> {
    const out: T[] = [];
    let exclusive: Record<string, unknown> | undefined;
    do {
      const res = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: indexName,
          KeyConditionExpression: 'tenantId = :t',
          ExpressionAttributeValues: { ':t': tenantId },
          ...(exclusive ? { ExclusiveStartKey: exclusive } : {}),
        }),
      );
      for (const item of (res.Items ?? []) as T[]) out.push(item);
      exclusive = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusive);
    out.sort((a, b) => (a as Record<string, number>)[sortKey]! - (b as Record<string, number>)[sortKey]!);
    return out;
  }

  return {
    async getPolicy(tenantId) {
      const res = await client.send(new GetCommand({ TableName: policyTable, Key: { tenantId } }));
      return (res.Item as TenantPolicyRecord | undefined) ?? null;
    },
    async upsertPolicy(p) {
      await client.send(new PutCommand({ TableName: policyTable, Item: p as unknown as Record<string, unknown> }));
    },
    async listKeks(tenantId) {
      return queryByTenant<KekRecord>(kekTable, tenantId, 'version');
    },
    async insertKek(k) {
      await client.send(new PutCommand({ TableName: kekTable, Item: k as unknown as Record<string, unknown> }));
    },
    async updateKekStatus(id, status, ts) {
      const sets: string[] = ['#s = :s'];
      const names: Record<string, string> = { '#s': 'status' };
      const values: Record<string, unknown> = { ':s': status };
      if (status === 'previous') {
        sets.push('rotatedAt = :t');
        values[':t'] = ts;
      } else if (status === 'revoked') {
        sets.push('revokedAt = :t');
        values[':t'] = ts;
      }
      await client.send(
        new UpdateCommand({
          TableName: kekTable,
          Key: { id },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    },
    async listDeks(tenantId) {
      return queryByTenant<DekRecord>(dekTable, tenantId, 'epoch');
    },
    async insertDek(d) {
      await client.send(new PutCommand({ TableName: dekTable, Item: d as unknown as Record<string, unknown> }));
    },
    async updateDekStatus(id, status, ts) {
      const sets: string[] = ['#s = :s'];
      const names: Record<string, string> = { '#s': 'status' };
      const values: Record<string, unknown> = { ':s': status };
      if (status === 'previous') {
        sets.push('rotatedAt = :t');
        values[':t'] = ts;
      } else if (status === 'revoked') {
        sets.push('revokedAt = :t');
        values[':t'] = ts;
      }
      await client.send(
        new UpdateCommand({
          TableName: dekTable,
          Key: { id },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    },
    async listBiks(tenantId) {
      return queryByTenant<BikRecord>(bikTable, tenantId, 'epoch');
    },
    async insertBik(b) {
      await client.send(new PutCommand({ TableName: bikTable, Item: b as unknown as Record<string, unknown> }));
    },
    async updateBikStatus(id, status: KeyStatus, ts) {
      const sets: string[] = ['#s = :s'];
      const names: Record<string, string> = { '#s': 'status' };
      const values: Record<string, unknown> = { ':s': status };
      if (status === 'revoked') {
        sets.push('revokedAt = :t');
        values[':t'] = ts;
      }
      await client.send(
        new UpdateCommand({
          TableName: bikTable,
          Key: { id },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    },
    async deletePolicy(tenantId) {
      await client.send(new DeleteCommand({ TableName: policyTable, Key: { tenantId } }));
    },
    async deleteAllWrappedMaterial(tenantId) {
      const keks = await queryByTenant<{ id: string }>(kekTable, tenantId, 'version');
      const deks = await queryByTenant<{ id: string }>(dekTable, tenantId, 'epoch');
      const biks = await queryByTenant<{ id: string }>(bikTable, tenantId, 'epoch');
      for (const r of keks) await client.send(new DeleteCommand({ TableName: kekTable, Key: { id: r.id } }));
      for (const r of deks) await client.send(new DeleteCommand({ TableName: dekTable, Key: { id: r.id } }));
      for (const r of biks) await client.send(new DeleteCommand({ TableName: bikTable, Key: { id: r.id } }));
      return { keks: keks.length, deks: deks.length, biks: biks.length };
    },
  };
}
