/**
 * Phase 7 — Budget Gate (lever L9).
 *
 * Real implementation of `CostBudgetGate.check`. Reads the per-run total
 * from a `CostLedger` and throws `CostCeilingExceededError` when the
 * accumulated $ cost exceeds `policy.budgetCeilingUsd`.
 *
 * Two integration shapes:
 *
 *   - Push-style:  `weaveBudgetGate({ ledger, ceilingUsd, runIdResolver })`
 *                  builds a gate consumers call between ReAct steps.
 *
 *   - Adapter:     `weaveCostLedgerFromBreakdown({ readBreakdown })` is a
 *                  thin DB-backed `CostLedger` adapter for apps that
 *                  persist entries via `CostLedgerSink` (append-only) but
 *                  need a `total(runId)` reader for the gate. A host
 *                  application uses this on top of `readCostBreakdown(db, runId)`.
 *
 * Reusability invariant: imports only from the cost-governor's own types.
 * NEVER blocks the pipeline on ledger errors — `check()` swallows ledger
 * failures (logged) and returns. Only a real ceiling breach throws.
 */

import type { CostBreakdown, CostLedger, CostLedgerEntry } from './types.js';
import {
  CostCeilingExceededError,
  type CostBudgetGate,
  type CostLeverContext,
} from './governor.js';

export interface WeaveBudgetGateOptions {
  /** The ledger to query for per-run totals. */
  readonly ledger: Pick<CostLedger, 'total'>;
  /** Ceiling in USD. ≤ 0 disables the gate (returns no-op). */
  readonly ceilingUsd: number;
  /**
   * Resolves the runId from the per-tick context. Apps that key on
   * `agentId` (live-agents default) supply `(ctx) => ctx.agentId`.
   * Returning null/undefined → gate skips this call.
   */
  readonly runIdResolver: (ctx: CostLeverContext) => string | null | undefined;
  /** Best-effort callback fired on breach BEFORE the throw. */
  readonly onExceed?: (info: { runId: string; total: number; ceiling: number; ctx: CostLeverContext }) => void | Promise<void>;
  /** When false the gate logs the breach and returns instead of throwing. Default true. */
  readonly throwOnExceed?: boolean;
  readonly log?: (msg: string) => void;
}

export function weaveBudgetGate(opts: WeaveBudgetGateOptions): CostBudgetGate {
  if (!Number.isFinite(opts.ceilingUsd) || opts.ceilingUsd <= 0) {
    return { check: () => undefined };
  }
  const log = opts.log ?? ((m: string) => console.warn(`[cost-governor:budget-gate] ${m}`));
  const throwOnExceed = opts.throwOnExceed !== false;

  return {
    async check(ctx: CostLeverContext): Promise<void> {
      const runId = opts.runIdResolver(ctx);
      if (!runId) return;
      let total = 0;
      try {
        total = await Promise.resolve(opts.ledger.total(runId));
      } catch (err) {
        log(`ledger.total threw for run ${runId}; skip: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!Number.isFinite(total) || total <= opts.ceilingUsd) return;
      try {
        await opts.onExceed?.({ runId, total, ceiling: opts.ceilingUsd, ctx });
      } catch (err) {
        log(`onExceed callback threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (throwOnExceed) {
        throw new CostCeilingExceededError(runId, total, opts.ceilingUsd);
      }
      log(`run ${runId} exceeded ceiling $${opts.ceilingUsd.toFixed(2)} (total=$${total.toFixed(4)}) — throwOnExceed=false; continuing`);
    },
  };
}

// ─── DB-backed ledger adapter ─────────────────────────────────

export interface WeaveCostLedgerFromBreakdownOptions {
  /** Reads a `CostBreakdown` for the given runId. App-supplied. */
  readonly readBreakdown: (runId: string) => Promise<CostBreakdown>;
}

/**
 * Thin `CostLedger` adapter for apps that write via `CostLedgerSink`
 * (append-only) but need a `total(runId)` reader for the budget gate.
 * `record()` is a no-op (the underlying sink is the writer of record).
 */
export function weaveCostLedgerFromBreakdown(opts: WeaveCostLedgerFromBreakdownOptions): CostLedger {
  return {
    async record(_entry: CostLedgerEntry): Promise<void> {
      /* writer of record is the sink; this adapter is reader-only */
    },
    async total(runId: string): Promise<number> {
      try {
        const bd = await opts.readBreakdown(runId);
        return bd.totalUsd ?? 0;
      } catch {
        return 0;
      }
    },
    async breakdown(runId: string): Promise<CostBreakdown> {
      return opts.readBreakdown(runId);
    },
  };
}
