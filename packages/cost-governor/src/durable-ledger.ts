/**
 * @weaveintel/cost-governor — durable cost ledger + run-cost-state tracker.
 *
 * Without these, per-run cost history and budget-enforcement counters reset
 * to zero on restart (billing / audit gap). Backed by `runtime.persistence.kv`
 * with an in-memory fallback.
 *
 * Ledger storage: each entry serialized under
 *   `${ns}:${runId}:${seq}` (seq from a per-runId in-memory counter).
 * Run-cost-state storage: serialized under `${ns}:${runId}` (single record
 * per run). Counters are non-monotonic on conflict but conflicts are rare
 * (single supervisor per run). Best-effort throughout — KV failure must not
 * crash a tick.
 */
import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
} from '@weaveintel/core';
import type {
  CostBreakdown,
  CostLedger,
  CostLedgerEntry,
} from './types.js';
import { aggregate } from './in-memory-ledger.js';

export interface DurableLedgerOptions {
  runtime?: WeaveRuntime;
  namespace?: string;
}

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

export function createDurableCostLedger(opts: DurableLedgerOptions = {}): CostLedger {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'cost-ledger';
  const seqs = new Map<string, number>();

  async function loadEntries(runId: string): Promise<CostLedgerEntry[]> {
    const entries = await kv.list(`${ns}:${runId}:`);
    const out: CostLedgerEntry[] = [];
    for (const e of entries) {
      try { out.push(JSON.parse(e.value) as CostLedgerEntry); } catch { /* skip */ }
    }
    return out;
  }

  return {
    async record(entry) {
      const next = (seqs.get(entry.runId) ?? 0) + 1;
      seqs.set(entry.runId, next);
      const seq = String(next).padStart(10, '0');
      await kv.set(`${ns}:${entry.runId}:${seq}`, JSON.stringify(entry));
    },
    async total(runId) {
      const entries = await loadEntries(runId);
      let s = 0;
      for (const e of entries) s += e.costUsd;
      return s;
    },
    async breakdown(runId): Promise<CostBreakdown> {
      const entries = await loadEntries(runId);
      return aggregate(runId, entries);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Durable RunCostStateTracker                                        */
/* ------------------------------------------------------------------ */

export interface DurableRunCostState {
  toolCallFailedCount: number;
  jsonParseFailedCount: number;
  resolveCount: number;
  currentStepKind?: string;
  intelScore?: number;
}

export interface DurableRunCostStateTracker {
  get(runId: string): Promise<DurableRunCostState | null>;
  recordToolCall(runId: string, outcome: { ok: boolean }): Promise<void>;
  recordJsonParse(runId: string, outcome: { ok: boolean }): Promise<void>;
  setCurrentStep(runId: string, kind: string): Promise<void>;
  setIntelScore(runId: string, score: number): Promise<void>;
  noteResolve(runId: string): Promise<void>;
  forget(runId: string): Promise<void>;
}

export function createDurableRunCostStateTracker(
  opts: DurableLedgerOptions = {},
): DurableRunCostStateTracker {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'cost-runstate';

  async function load(runId: string): Promise<DurableRunCostState> {
    const v = await kv.get(`${ns}:${runId}`);
    if (v) {
      try { return JSON.parse(v) as DurableRunCostState; } catch { /* fall through */ }
    }
    return { toolCallFailedCount: 0, jsonParseFailedCount: 0, resolveCount: 0 };
  }

  async function patch(runId: string, p: Partial<DurableRunCostState>): Promise<void> {
    const cur = await load(runId);
    const next: DurableRunCostState = { ...cur, ...p };
    await kv.set(`${ns}:${runId}`, JSON.stringify(next));
  }

  return {
    async get(runId) {
      const v = await kv.get(`${ns}:${runId}`);
      if (!v) return null;
      try { return JSON.parse(v) as DurableRunCostState; } catch { return null; }
    },
    async recordToolCall(runId, outcome) {
      if (outcome.ok) return;
      const cur = await load(runId);
      await patch(runId, { toolCallFailedCount: cur.toolCallFailedCount + 1 });
    },
    async recordJsonParse(runId, outcome) {
      if (outcome.ok) return;
      const cur = await load(runId);
      await patch(runId, { jsonParseFailedCount: cur.jsonParseFailedCount + 1 });
    },
    async setCurrentStep(runId, kind) { await patch(runId, { currentStepKind: kind }); },
    async setIntelScore(runId, score) { await patch(runId, { intelScore: score }); },
    async noteResolve(runId) {
      const cur = await load(runId);
      await patch(runId, { resolveCount: cur.resolveCount + 1 });
    },
    async forget(runId) { await kv.delete(`${ns}:${runId}`); },
  };
}
