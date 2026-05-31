/**
 * MongoDB-backed CostLedger.
 *
 * Persists every `CostLedgerEntry` as one doc per entry keyed by `_id = entry.id`.
 * Idempotent insert via `updateOne($setOnInsert, { upsert: true })`.
 * `total()` uses `$group` aggregation; `breakdown()` reads all docs for the run.
 */
import type { Collection, Db } from 'mongodb';
import type {
  CostLedger,
  CostLedgerEntry,
  CostBreakdown,
  CostLever,
} from '../types.js';

interface EntryDoc {
  _id: string;
  runId: string;
  stepId?: string;
  agentId?: string;
  agentRole?: string;
  source: 'model' | 'tool';
  lever: CostLever;
  subject: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  costUsd: number;
  observedAt: number;
  metadata?: Record<string, unknown>;
}

function docToEntry(d: EntryDoc): CostLedgerEntry {
  return {
    id: d._id,
    runId: d.runId,
    ...(d.stepId !== undefined ? { stepId: d.stepId } : {}),
    ...(d.agentId !== undefined ? { agentId: d.agentId } : {}),
    ...(d.agentRole !== undefined ? { agentRole: d.agentRole } : {}),
    source: d.source,
    lever: d.lever,
    subject: d.subject,
    ...(d.provider !== undefined ? { provider: d.provider } : {}),
    ...(d.inputTokens !== undefined ? { inputTokens: d.inputTokens } : {}),
    ...(d.outputTokens !== undefined ? { outputTokens: d.outputTokens } : {}),
    ...(d.cachedTokens !== undefined ? { cachedTokens: d.cachedTokens } : {}),
    ...(d.reasoningTokens !== undefined ? { reasoningTokens: d.reasoningTokens } : {}),
    costUsd: d.costUsd,
    observedAt: d.observedAt,
    ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
  };
}

export interface WeaveMongoDbCostLedgerOptions {
  db: Db;
  collectionName?: string;
  ensureSchema?: boolean;
}

export async function weaveMongoDbCostLedger(opts: WeaveMongoDbCostLedgerOptions): Promise<CostLedger> {
  const collName = opts.collectionName ?? 'cost_ledger_entries';
  const coll: Collection<EntryDoc> = opts.db.collection<EntryDoc>(collName);
  if (opts.ensureSchema !== false) {
    await coll.createIndex({ runId: 1, observedAt: 1 });
  }

  return {
    async record(entry: CostLedgerEntry): Promise<void> {
      try {
        const doc: EntryDoc = {
          _id: entry.id,
          runId: entry.runId,
          ...(entry.stepId !== undefined ? { stepId: entry.stepId } : {}),
          ...(entry.agentId !== undefined ? { agentId: entry.agentId } : {}),
          ...(entry.agentRole !== undefined ? { agentRole: entry.agentRole } : {}),
          source: entry.source,
          lever: entry.lever,
          subject: entry.subject,
          ...(entry.provider !== undefined ? { provider: entry.provider } : {}),
          ...(entry.inputTokens !== undefined ? { inputTokens: entry.inputTokens } : {}),
          ...(entry.outputTokens !== undefined ? { outputTokens: entry.outputTokens } : {}),
          ...(entry.cachedTokens !== undefined ? { cachedTokens: entry.cachedTokens } : {}),
          ...(entry.reasoningTokens !== undefined ? { reasoningTokens: entry.reasoningTokens } : {}),
          costUsd: entry.costUsd,
          observedAt: entry.observedAt,
          ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
        };
        await coll.updateOne({ _id: entry.id }, { $setOnInsert: doc }, { upsert: true });
      } catch {
        // best-effort
      }
    },
    async total(runId: string): Promise<number> {
      const cursor = coll.aggregate<{ total: number }>([
        { $match: { runId } },
        { $group: { _id: null, total: { $sum: '$costUsd' } } },
      ]);
      const r = await cursor.toArray();
      return r[0]?.total ?? 0;
    },
    async breakdown(runId: string): Promise<CostBreakdown> {
      const docs = await coll.find({ runId }).sort({ observedAt: 1, _id: 1 }).toArray();
      const entries = docs.map(docToEntry);
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
