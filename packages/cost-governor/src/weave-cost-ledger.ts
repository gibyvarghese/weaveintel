/**
 * User-facing factory.
 *
 * `weaveCostLedger({ sink, pricing })` returns a CostLedger that delegates
 * record() to the sink and computes total/breakdown by replaying entries
 * from an in-memory mirror. For durable read-side queries, query the sink's
 * backing store directly (see the reference app's admin cost-ledger API).
 */

import type { CostLedger, CostLedgerEntry, CostLedgerSink } from './types.js';
import { aggregate } from './in-memory-ledger.js';

export interface WeaveCostLedgerOptions {
  sink: CostLedgerSink;
}

export function weaveCostLedger(opts: WeaveCostLedgerOptions): CostLedger {
  const mirror = new Map<string, CostLedgerEntry[]>();
  return {
    async record(entry: CostLedgerEntry): Promise<void> {
      try { await opts.sink.append(entry); } catch {/* swallow */}
      const list = mirror.get(entry.runId) ?? [];
      list.push(entry);
      mirror.set(entry.runId, list);
    },
    async total(runId: string): Promise<number> {
      let s = 0;
      for (const e of (mirror.get(runId) ?? [])) s += e.costUsd;
      return s;
    },
    async breakdown(runId: string): Promise<import('./types.js').CostBreakdown> {
      return aggregate(runId, mirror.get(runId) ?? []);
    },
  };
}
