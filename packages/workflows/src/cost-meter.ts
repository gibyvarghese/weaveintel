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
