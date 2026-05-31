/**
 * @weaveintel/workflows — cost-meter.ts
 *
 * Phase 5 — Cost ceiling enforcement contract.
 *
 * The engine is intentionally cost-source-agnostic: any caller (LLM model
 * adapter, tool wrapper, sub-workflow) reports a cost delta to the
 * `CostMeter` keyed by `runId`. After every step boundary the engine asks
 * the meter for the cumulative total and, if a `WorkflowPolicy.costCeiling`
 * is set, halts the run when the ceiling is exceeded.
 *
 * The package ships an in-memory implementation; apps may persist costs
 * to DB / observability pipelines by implementing the same interface.
 */

export interface CostDelta {
  /** USD cost to attribute to the run. */
  costUsd: number;
  /** Optional source label for audit (e.g. "openai:gpt-4o", "tool:web_search"). */
  source?: string;
}

export interface CostMeter {
  record(runId: string, delta: CostDelta): void | Promise<void>;
  total(runId: string): number | Promise<number>;
  reset(runId: string): void | Promise<void>;
}

export class InMemoryCostMeter implements CostMeter {
  private readonly totals = new Map<string, number>();

  record(runId: string, delta: CostDelta): void {
    if (!Number.isFinite(delta.costUsd) || delta.costUsd <= 0) return;
    this.totals.set(runId, (this.totals.get(runId) ?? 0) + delta.costUsd);
  }

  total(runId: string): number {
    return this.totals.get(runId) ?? 0;
  }

  reset(runId: string): void {
    this.totals.delete(runId);
  }
}

// --- Phase 4: durable cost meter via runtime.persistence ---

import type { WeaveRuntime } from '@weaveintel/core';
import { weaveInMemoryPersistence } from '@weaveintel/core';

export interface DurableCostMeterOptions {
  /** When provided and `runtime.persistence` is configured, totals survive
   *  process restarts. Falls back to in-memory KV otherwise. */
  runtime?: WeaveRuntime;
  /** Key namespace under the runtime KV. Defaults to `'cost'`. */
  namespace?: string;
}

/**
 * Durable, runtime-aware cost meter (Phase 4 — Durability everywhere).
 *
 * Totals are stored as integer cents (`Math.round(costUsd * 100)`) under
 * `${namespace}:${runId}` so reads/writes never accumulate float drift.
 * `record()` is a single KV read+write per delta — fine for typical
 * workflow tick rates; high-throughput callers should batch upstream.
 */
export function createDurableCostMeter(opts: DurableCostMeterOptions = {}): CostMeter {
  const namespace = opts.namespace ?? 'cost';
  const slot = opts.runtime?.persistence ?? weaveInMemoryPersistence();
  const kv = slot.kv;
  const k = (runId: string) => `${namespace}:${runId}`;

  return {
    async record(runId, delta) {
      if (!Number.isFinite(delta.costUsd) || delta.costUsd <= 0) return;
      const cents = Math.round(delta.costUsd * 100);
      const cur = await kv.get(k(runId));
      const prev = cur === undefined ? 0 : Number.parseInt(cur, 10);
      await kv.set(k(runId), String((Number.isFinite(prev) ? prev : 0) + cents));
    },
    async total(runId) {
      const cur = await kv.get(k(runId));
      if (cur === undefined) return 0;
      const cents = Number.parseInt(cur, 10);
      return Number.isFinite(cents) ? cents / 100 : 0;
    },
    async reset(runId) {
      await kv.delete(k(runId));
    },
  };
}
