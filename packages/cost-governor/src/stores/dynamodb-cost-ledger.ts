/**
 * DynamoDB-backed CostLedger.
 *
 * Caller provides a DynamoDBDocumentClient and a table name. Schema (operator
 * provisions out-of-band):
 *   ledgerTable: PK = id (S); GSI 'run-index' = runId (S) HASH, observedAt (N) RANGE
 *
 * Idempotent record via PutCommand with `attribute_not_exists(id)` condition;
 * conditional-check failures are swallowed (best-effort).
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  CostLedger,
  CostLedgerEntry,
  CostBreakdown,
  CostLever,
} from '../types.js';

export interface WeaveDynamoDbCostLedgerOptions {
  client: DynamoDBDocumentClient;
  ledgerTable: string;
  /** GSI name for run-id queries. Default: `run-index`. */
  runIndexName?: string;
}

export function weaveDynamoDbCostLedger(opts: WeaveDynamoDbCostLedgerOptions): CostLedger {
  const { client, ledgerTable } = opts;
  const runIndex = opts.runIndexName ?? 'run-index';

  return {
    async record(entry: CostLedgerEntry): Promise<void> {
      try {
        const item: Record<string, unknown> = {
          id: entry.id,
          runId: entry.runId,
          source: entry.source,
          lever: entry.lever,
          subject: entry.subject,
          costUsd: entry.costUsd,
          observedAt: entry.observedAt,
        };
        if (entry.stepId !== undefined) item['stepId'] = entry.stepId;
        if (entry.agentId !== undefined) item['agentId'] = entry.agentId;
        if (entry.agentRole !== undefined) item['agentRole'] = entry.agentRole;
        if (entry.provider !== undefined) item['provider'] = entry.provider;
        if (entry.inputTokens !== undefined) item['inputTokens'] = entry.inputTokens;
        if (entry.outputTokens !== undefined) item['outputTokens'] = entry.outputTokens;
        if (entry.cachedTokens !== undefined) item['cachedTokens'] = entry.cachedTokens;
        if (entry.reasoningTokens !== undefined) item['reasoningTokens'] = entry.reasoningTokens;
        if (entry.metadata !== undefined) item['metadata'] = entry.metadata;

        await client.send(new PutCommand({
          TableName: ledgerTable,
          Item: item as unknown as Record<string, unknown>,
          ConditionExpression: 'attribute_not_exists(id)',
        }));
      } catch {
        // best-effort (also swallows ConditionalCheckFailedException for idempotency)
      }
    },
    async total(runId: string): Promise<number> {
      const entries = await collectEntries(client, ledgerTable, runIndex, runId);
      return entries.reduce((acc, e) => acc + e.costUsd, 0);
    },
    async breakdown(runId: string): Promise<CostBreakdown> {
      const entries = await collectEntries(client, ledgerTable, runIndex, runId);
      const byLever: Record<string, number> = {};
      const byModel: Record<string, number> = {};
      const bySubject: Record<string, number> = {};
      const byAgent: Record<string, number> = {};
      let totalUsd = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let reasoningTokens = 0;
      for (const e of entries) {
        totalUsd += e.costUsd;
        byLever[e.lever] = (byLever[e.lever] ?? 0) + e.costUsd;
        bySubject[e.subject] = (bySubject[e.subject] ?? 0) + e.costUsd;
        if (e.source === 'model') byModel[e.subject] = (byModel[e.subject] ?? 0) + e.costUsd;
        if (e.agentId) byAgent[e.agentId] = (byAgent[e.agentId] ?? 0) + e.costUsd;
        inputTokens += e.inputTokens ?? 0;
        outputTokens += e.outputTokens ?? 0;
        cachedTokens += e.cachedTokens ?? 0;
        reasoningTokens += e.reasoningTokens ?? 0;
      }
      return {
        runId,
        totalUsd,
        entryCount: entries.length,
        byLever: byLever as Record<CostLever, number>,
        byModel,
        bySubject,
        byAgent,
        tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens, reasoning: reasoningTokens },
        entries,
      };
    },
  };
}

async function collectEntries(
  client: DynamoDBDocumentClient,
  table: string,
  indexName: string,
  runId: string,
): Promise<CostLedgerEntry[]> {
  const out: CostLedgerEntry[] = [];
  let exclusive: Record<string, unknown> | undefined;
  do {
    const res = await client.send(new QueryCommand({
      TableName: table,
      IndexName: indexName,
      KeyConditionExpression: 'runId = :r',
      ExpressionAttributeValues: { ':r': runId },
      ScanIndexForward: true,
      ...(exclusive ? { ExclusiveStartKey: exclusive } : {}),
    }));
    for (const item of (res.Items ?? []) as Record<string, unknown>[]) {
      out.push(itemToEntry(item));
    }
    exclusive = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusive);
  return out;
}

function itemToEntry(item: Record<string, unknown>): CostLedgerEntry {
  const get = <T>(k: string): T | undefined => item[k] as T | undefined;
  return {
    id: get<string>('id') ?? '',
    runId: get<string>('runId') ?? '',
    ...(get<string>('stepId') !== undefined ? { stepId: get<string>('stepId') as string } : {}),
    ...(get<string>('agentId') !== undefined ? { agentId: get<string>('agentId') as string } : {}),
    ...(get<string>('agentRole') !== undefined ? { agentRole: get<string>('agentRole') as string } : {}),
    source: (get<string>('source') ?? 'model') as 'model' | 'tool',
    lever: (get<string>('lever') ?? 'other') as CostLever,
    subject: get<string>('subject') ?? '',
    ...(get<string>('provider') !== undefined ? { provider: get<string>('provider') as string } : {}),
    ...(get<number>('inputTokens') !== undefined ? { inputTokens: get<number>('inputTokens') as number } : {}),
    ...(get<number>('outputTokens') !== undefined ? { outputTokens: get<number>('outputTokens') as number } : {}),
    ...(get<number>('cachedTokens') !== undefined ? { cachedTokens: get<number>('cachedTokens') as number } : {}),
    ...(get<number>('reasoningTokens') !== undefined ? { reasoningTokens: get<number>('reasoningTokens') as number } : {}),
    costUsd: get<number>('costUsd') ?? 0,
    observedAt: get<number>('observedAt') ?? 0,
    ...(get<Record<string, unknown>>('metadata') !== undefined
      ? { metadata: get<Record<string, unknown>>('metadata') as Record<string, unknown> }
      : {}),
  };
}
