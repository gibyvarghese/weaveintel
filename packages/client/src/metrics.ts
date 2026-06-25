/**
 * Run metrics rollup — client-side observability (Phase 6).
 *
 * Mirrors `@weaveintel/cache`'s `createCacheMetrics` shape (a tiny in-process
 * sink with `record* / snapshot / reset`) so hosts get one consistent metrics
 * idiom. Folds terminal runs' usage/cost (already surfaced on the view model as
 * `vm.usage`) into running totals: run counts by outcome, error rate, token
 * totals, USD cost, and average latency.
 *
 * Browser-safe: no Node.js APIs.
 */
import type { RunViewModel, UsageView } from './reducer.js';
import type { RunSessionStatus } from './run-session.js';

/** A single run's terminal outcome for the rollup. */
export type RunOutcome = 'completed' | 'failed' | 'cancelled';

export interface RunMetricsSnapshot {
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** failed / runs (0 when no runs). */
  errorRate: number;
  tokens: { prompt: number; completion: number; total: number };
  costUsd: number;
  /** Average completed-run latency (ms), 0 when none recorded. */
  avgLatencyMs: number;
  /** Average USD per recorded run, 0 when none. */
  avgCostPerRun: number;
  startedAt: string;
}

export interface RunMetrics {
  /** Record a terminal run from its outcome + (optional) usage snapshot. */
  recordRun(outcome: RunOutcome, usage?: UsageView): void;
  /** Convenience: record from a settled session state (status + vm.usage). */
  recordSession(status: RunSessionStatus, vm: RunViewModel): void;
  snapshot(): RunMetricsSnapshot;
  reset(): void;
}

const STATUS_TO_OUTCOME: Partial<Record<RunSessionStatus, RunOutcome>> = {
  ready: 'completed',
  error: 'failed',
};

export function createRunMetrics(opts?: { startedAt?: string }): RunMetrics {
  const startedAt = opts?.startedAt ?? new Date().toISOString();
  let runs = 0, completed = 0, failed = 0, cancelled = 0;
  let prompt = 0, completion = 0, total = 0, costUsd = 0;
  let latencySum = 0, latencyCount = 0;

  const num = (v: number | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

  function recordRun(outcome: RunOutcome, usage?: UsageView): void {
    runs++;
    if (outcome === 'completed') completed++;
    else if (outcome === 'failed') failed++;
    else cancelled++;

    if (usage) {
      prompt += num(usage.promptTokens);
      completion += num(usage.completionTokens);
      // Prefer the explicit total; else derive from prompt+completion.
      total += num(usage.totalTokens) || (num(usage.promptTokens) + num(usage.completionTokens));
      costUsd += num(usage.costUsd);
      const lat = num(usage.latencyMs);
      if (lat > 0) { latencySum += lat; latencyCount++; }
    }
  }

  return {
    recordRun,
    recordSession(status, vm) {
      // Only terminal session states roll up; 'cancelled' arrives as a settled
      // 'ready' status whose run was cancelled — callers that distinguish it
      // should use recordRun('cancelled', …) directly.
      const outcome = STATUS_TO_OUTCOME[status];
      if (!outcome) return;
      recordRun(outcome, vm.usage);
    },
    snapshot(): RunMetricsSnapshot {
      return {
        runs, completed, failed, cancelled,
        errorRate: runs > 0 ? failed / runs : 0,
        tokens: { prompt, completion, total },
        costUsd,
        avgLatencyMs: latencyCount > 0 ? latencySum / latencyCount : 0,
        avgCostPerRun: runs > 0 ? costUsd / runs : 0,
        startedAt,
      };
    },
    reset() {
      runs = completed = failed = cancelled = 0;
      prompt = completion = total = costUsd = 0;
      latencySum = latencyCount = 0;
    },
  };
}
