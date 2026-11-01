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
 *
 * Fails closed: when the ledger cannot say what a run has spent (it throws or
 * returns a non-finite total), `check()` throws `CostLedgerUnavailableError`
 * unless the operator explicitly chose `onLedgerError: 'allow'`. A ledger
 * outage must never switch the budget off (GAPS G-WI-11).
 */

import type { CostBreakdown, CostLedger, CostLedgerEntry } from './types.js';
import {
  CostCeilingExceededError,
  type CostBudgetGate,
  type CostLeverContext,
} from './governor.js';

/**
 * Thrown when the budget gate refuses a step because the ledger could not report the
 * run's spend. Like `CostCeilingExceededError` it carries `runId` and `ceilingUsd`, so a
 * handler that stops a run on a budget breach can treat both the same way.
 */
export class CostLedgerUnavailableError extends Error {
  readonly runId: string;
  readonly ceilingUsd: number;
  readonly ledgerError: unknown;
  constructor(runId: string, ceilingUsd: number, ledgerError?: unknown) {
    super(`Cost ledger unavailable for run ${runId}; refusing the step (ceiling $${ceilingUsd.toFixed(2)})`);
    this.name = 'CostLedgerUnavailableError';
    this.runId = runId;
    this.ceilingUsd = ceilingUsd;
    this.ledgerError = ledgerError;
  }
}

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
  /**
   * What to do when the ledger throws or returns a non-finite total. `'deny'` (the
   * default) throws `CostLedgerUnavailableError`; `'allow'` logs and lets the step run,
   * which switches the budget off for as long as the ledger is down.
   */
  readonly onLedgerError?: 'deny' | 'allow';
  /** Best-effort callback fired whenever the ledger fails, so the host can alert. */
  readonly onLedgerFailure?: (info: { runId: string; error: unknown; ctx: CostLeverContext }) => void | Promise<void>;
  readonly log?: (msg: string) => void;
}

export function weaveBudgetGate(opts: WeaveBudgetGateOptions): CostBudgetGate {
  if (!Number.isFinite(opts.ceilingUsd) || opts.ceilingUsd <= 0) {
    return { check: () => undefined };
  }
  const log = opts.log ?? ((m: string) => console.warn(`[cost-governor:budget-gate] ${m}`));
  const throwOnExceed = opts.throwOnExceed !== false;
  const onLedgerError = opts.onLedgerError ?? 'deny';

  return {
    async check(ctx: CostLeverContext): Promise<void> {
      const runId = opts.runIdResolver(ctx);
      if (!runId) return;
      let total: number;
      let ledgerError: unknown;
      try {
        total = await Promise.resolve(opts.ledger.total(runId));
        if (!Number.isFinite(total)) ledgerError = new Error(`ledger returned a non-finite total (${String(total)})`);
      } catch (err) {
        total = Number.NaN;
        ledgerError = err;
      }
      if (ledgerError !== undefined) {
        const reason = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
        try {
          await opts.onLedgerFailure?.({ runId, error: ledgerError, ctx });
        } catch (err) {
          log(`onLedgerFailure callback threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (onLedgerError === 'allow') {
          log(`ledger unavailable for run ${runId}; onLedgerError=allow, continuing: ${reason}`);
          return;
        }
        log(`ledger unavailable for run ${runId}; denying: ${reason}`);
        throw new CostLedgerUnavailableError(runId, opts.ceilingUsd, ledgerError);
      }
      if (total <= opts.ceilingUsd) return;
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
 * `total()` rethrows a read failure so the gate can fail closed.
 */
export function weaveCostLedgerFromBreakdown(opts: WeaveCostLedgerFromBreakdownOptions): CostLedger {
  return {
    async record(_entry: CostLedgerEntry): Promise<void> {
      /* writer of record is the sink; this adapter is reader-only */
    },
    async total(runId: string): Promise<number> {
      // A read failure propagates: reporting $0 would let the gate wave the run through.
      const bd = await opts.readBreakdown(runId);
      return bd.totalUsd ?? 0;
    },
    async breakdown(runId: string): Promise<CostBreakdown> {
      return opts.readBreakdown(runId);
    },
  };
}
