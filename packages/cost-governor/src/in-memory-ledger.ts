import type {
  CostBreakdown,
  CostLedger,
  CostLedgerEntry,
  CostLever,
} from './types.js';

const ZERO_LEVER: Record<CostLever, number> = {
  model: 0,
  tool: 0,
  rag: 0,
  reasoning: 0,
  cache: 0,
  other: 0,
};

/**
 * Process-local ledger. Useful for tests, examples, and short-lived runs.
 * For durable storage use a sink-backed implementation that writes to
 * `live_run_events` (see `weaveCostLedger` factory).
 */
export function createInMemoryCostLedger(): CostLedger {
  const byRun = new Map<string, CostLedgerEntry[]>();

  return {
    async record(entry: CostLedgerEntry): Promise<void> {
      const list = byRun.get(entry.runId) ?? [];
      list.push(entry);
      byRun.set(entry.runId, list);
    },
    async total(runId: string): Promise<number> {
      const list = byRun.get(runId) ?? [];
      let s = 0;
      for (const e of list) s += e.costUsd;
      return s;
    },
    async breakdown(runId: string): Promise<CostBreakdown> {
      const entries = byRun.get(runId) ?? [];
      return aggregate(runId, entries);
    },
  };
}

/** Pure aggregator — exported so DB-backed adapters can reuse it. */
export function aggregate(runId: string, entries: ReadonlyArray<CostLedgerEntry>): CostBreakdown {
  const byLever = { ...ZERO_LEVER };
  const byModel: Record<string, number> = {};
  const bySubject: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  let totalUsd = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  let reasoning = 0;

  for (const e of entries) {
    totalUsd += e.costUsd;
    byLever[e.lever] = (byLever[e.lever] ?? 0) + e.costUsd;
    bySubject[e.subject] = (bySubject[e.subject] ?? 0) + e.costUsd;
    if (e.source === 'model') {
      byModel[e.subject] = (byModel[e.subject] ?? 0) + e.costUsd;
    }
    if (e.agentId) {
      byAgent[e.agentId] = (byAgent[e.agentId] ?? 0) + e.costUsd;
    } else if (e.agentRole) {
      byAgent[e.agentRole] = (byAgent[e.agentRole] ?? 0) + e.costUsd;
    }
    input     += e.inputTokens     ?? 0;
    output    += e.outputTokens    ?? 0;
    cached    += e.cachedTokens    ?? 0;
    reasoning += e.reasoningTokens ?? 0;
  }

  return {
    runId,
    totalUsd,
    entryCount: entries.length,
    byLever,
    byModel,
    bySubject,
    byAgent,
    tokens: { input, output, cached, reasoning },
    entries,
  };
}
