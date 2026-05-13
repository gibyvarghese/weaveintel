/**
 * Phase 2 — Cost Governor Bundle (no-op stubs).
 *
 * `weaveCostGovernor(policy)` returns a `CostGovernorBundle` whose lever
 * resolvers are pass-through stubs. Future phases (3..7) replace each stub
 * with a real implementation, but the *shape* and *wiring point* are stable
 * from Phase 2 forward — apps that wire the bundle now will pick up real
 * cost savings as later phases land, with zero call-site changes.
 *
 * The bundle is deliberately consumer-agnostic: it does not import from
 * `@weaveintel/live-agents` or `@weaveintel/agents`. Consumers compose the
 * pieces into whatever runtime they own.
 */

import type {
  CostPolicy,
  ResolvedCostPolicy,
} from './policy.js';
import { resolveCostPolicy } from './policy.js';
import type { CacheShaper } from './cache-shaper.js';
import { noopCacheShaper, weavePromptCachingShaper } from './cache-shaper.js';
import { weaveToolSubsetFilter } from './tool-subset.js';
import type { IntelScoreProvider } from './intel-gating.js';
import { weaveIntelGate } from './intel-gating.js';
import type { HistorySummarizer } from './history-compactor.js';
import { weaveHistoryCompactor } from './history-compactor.js';
import type { ReasoningEffort } from './reasoning-effort.js';
import type { ToolOutputTruncator } from './output-truncation.js';
import { weaveToolOutputTruncator } from './output-truncation.js';
import { weaveBudgetGate } from './budget-gate.js';
import type { CostLedger } from './types.js';

/** Per-tick context every lever resolver receives. */
export interface CostLeverContext {
  readonly runId?: string;
  readonly meshId?: string;
  readonly agentId?: string;
  readonly agentRole?: string;
  /** Optional logical phase (e.g. discovery / kernel / submit for kaggle). */
  readonly phase?: string;
  /** Optional intel score (0..1) supplied by the consumer. */
  readonly intelScore?: number;
}

/** L1 — model cascade. Stub returns `null` (no override). */
export interface CostModelDecision {
  /** When set, the runtime should prefer this model id over its default. */
  readonly modelIdOverride?: string;
  /** When set, forwarded to model.options.reasoning_effort. */
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
}

export type CostModelResolver = (ctx: CostLeverContext) => Promise<CostModelDecision | null> | CostModelDecision | null;

/** L3 — tool subset. Stub returns `null` (= keep all tools). */
export type CostToolFilter = (
  toolKeys: ReadonlyArray<string>,
  ctx: CostLeverContext,
) => Promise<ReadonlyArray<string> | null> | ReadonlyArray<string> | null;

/** L4 — prompt-section gating. Stub is identity. */
export interface PromptShape {
  /** Section keys the prepare() should keep. `null` = keep all. */
  readonly keepSections?: ReadonlyArray<string> | null;
  /** Section keys the prepare() should drop entirely. */
  readonly dropSections?: ReadonlyArray<string>;
}

export type CostPromptShaper = (ctx: CostLeverContext) => Promise<PromptShape | null> | PromptShape | null;

/** L5 — history compaction. Stub returns input unchanged. */
export interface HistoryItem {
  readonly role: string;
  readonly content: unknown;
  readonly metadata?: Record<string, unknown>;
}

export type CostHistoryCompactor = (
  history: ReadonlyArray<HistoryItem>,
  ctx: CostLeverContext,
) => Promise<ReadonlyArray<HistoryItem>> | ReadonlyArray<HistoryItem>;

/** L9 — budget gate. Stub never throws. */
export class CostCeilingExceededError extends Error {
  readonly runId: string;
  readonly costUsd: number;
  readonly ceilingUsd: number;
  constructor(runId: string, costUsd: number, ceilingUsd: number) {
    super(`Cost ceiling exceeded for run ${runId}: $${costUsd.toFixed(4)} > $${ceilingUsd.toFixed(2)}`);
    this.name = 'CostCeilingExceededError';
    this.runId = runId;
    this.costUsd = costUsd;
    this.ceilingUsd = ceilingUsd;
  }
}

export interface CostBudgetGate {
  /**
   * Called between steps. If the run has exceeded its ceiling, the gate
   * MUST throw `CostCeilingExceededError`. Stub is a no-op.
   */
  check(ctx: CostLeverContext): Promise<void> | void;
}

/** The composed bundle returned by `weaveCostGovernor`. */
export interface CostGovernorBundle {
  /** The fully merged policy this bundle was built from. */
  readonly policy: ResolvedCostPolicy;
  readonly modelResolver: CostModelResolver;
  readonly toolFilter: CostToolFilter;
  readonly promptShaper: CostPromptShaper;
  /**
   * Phase 3 — prompt-caching shaper (lever L2). Real implementation:
   * computes a stable `prompt_cache_key` per call from the policy's
   * `promptCaching.keyStrategy`. When `promptCaching.enabled === false`,
   * resolves to a no-op.
   */
  readonly cacheShaper: CacheShaper;
  readonly historyCompactor: CostHistoryCompactor;
  readonly budgetGate: CostBudgetGate;
  /** Phase 7 — L6 max-steps cap (resolved from policy). */
  readonly maxStepsCap: number;
  /** Phase 7 — L7 reasoning effort hint (resolved from policy). */
  readonly reasoningEffort: ReasoningEffort;
  /** Phase 7 — L8 tool output truncator. No-op when policy disables. */
  readonly toolOutputTruncator: ToolOutputTruncator;
}

/**
 * Phase 6 — `weaveCostGovernor` accepts optional `intelScoreProvider` and
 * `historySummarizer` slots so the bundle can flip on the L4 (intel
 * gating) and L5 (history compaction) levers when the policy enables
 * them. Both are optional: without `intelScoreProvider` the L4 lever
 * stays a no-op even when the policy enables it (graceful — the gate
 * needs a domain-specific score source). The summariser is optional even
 * for `strategy=summary` (compactor falls back to sliding).
 *
 * Phase 7 — adds optional `costLedger` + `runIdResolver` so the L9 budget
 * gate can flip on. When omitted, the gate stays a no-op even when the
 * policy sets `budgetCeilingUsd > 0` (graceful — the gate needs a ledger).
 */
export interface CostGovernorOptions {
  readonly intelScoreProvider?: IntelScoreProvider;
  readonly historySummarizer?: HistorySummarizer;
  /**
   * Phase 7 — supply a `CostLedger` reader so the L9 budget gate can
   * query the per-run total. When omitted, the gate stays a no-op even
   * when the policy sets `budgetCeilingUsd > 0`.
   */
  readonly costLedger?: Pick<CostLedger, 'total'>;
  /**
   * Phase 7 — resolves runId from the per-tick context. Required for the
   * budget gate. Live-agent consumers typically supply
   * `(ctx) => ctx.agentId ?? ctx.runId`.
   */
  readonly runIdResolver?: (ctx: CostLeverContext) => string | null | undefined;
  /**
   * Phase 7 — best-effort callback fired on budget breach BEFORE throw.
   * Use for emitting `live_run_events.kind='cost.exceeded'` audit rows.
   */
  readonly onBudgetExceeded?: (info: { runId: string; total: number; ceiling: number; ctx: CostLeverContext }) => void | Promise<void>;
  /**
   * When false the budget gate logs the breach and continues instead of
   * throwing. Default true.
   */
  readonly throwOnBudgetExceeded?: boolean;
  readonly log?: (msg: string) => void;
}

/**
 * Returns a `CostGovernorBundle` from the given policy. Phase 3 ships the
 * `cacheShaper` lever as a real implementation; Phase 5 ships toolSubset;
 * Phase 6 ships intel-gating + history-compaction; Phase 7 ships
 * maxStepsCap + reasoningEffort + toolOutputTruncator + budgetGate.
 */
export function weaveCostGovernor(
  policy: CostPolicy,
  opts?: CostGovernorOptions,
): CostGovernorBundle {
  const resolved = resolveCostPolicy(policy);
  const intelEnabled = resolved.intelGating.enabled === true && opts?.intelScoreProvider != null;
  const histEnabled = resolved.historyCompaction.strategy !== 'none';
  const budgetEnabled =
    resolved.budgetCeilingUsd > 0 && opts?.costLedger != null && opts?.runIdResolver != null;
  const budgetGate: CostBudgetGate = budgetEnabled
    ? weaveBudgetGate({
        ledger: opts!.costLedger!,
        ceilingUsd: resolved.budgetCeilingUsd,
        runIdResolver: opts!.runIdResolver!,
        ...(opts?.onBudgetExceeded ? { onExceed: opts.onBudgetExceeded } : {}),
        ...(opts?.throwOnBudgetExceeded !== undefined ? { throwOnExceed: opts.throwOnBudgetExceeded } : {}),
        ...(opts?.log ? { log: opts.log } : {}),
      })
    : noopBudgetGate;
  return {
    policy: resolved,
    modelResolver: noopModelResolver,
    toolFilter:
      resolved.toolSubset.strategy === 'all'
        ? noopToolFilter
        : weaveToolSubsetFilter(resolved.toolSubset),
    promptShaper: intelEnabled
      ? weaveIntelGate(resolved.intelGating, opts!.intelScoreProvider!, opts?.log ? { log: opts.log } : undefined)
      : noopPromptShaper,
    cacheShaper: resolved.promptCaching.enabled
      ? weavePromptCachingShaper(resolved.promptCaching)
      : noopCacheShaper,
    historyCompactor: histEnabled
      ? weaveHistoryCompactor(resolved.historyCompaction, opts?.historySummarizer, opts?.log ? { log: opts.log } : undefined)
      : noopHistoryCompactor,
    budgetGate,
    maxStepsCap: resolved.maxStepsCap,
    reasoningEffort: resolved.reasoningEffort,
    toolOutputTruncator: weaveToolOutputTruncator(resolved.toolOutputTruncation),
  };
}

export const noopModelResolver: CostModelResolver = () => null;
export const noopToolFilter: CostToolFilter = () => null;
export const noopPromptShaper: CostPromptShaper = () => null;
export const noopHistoryCompactor: CostHistoryCompactor = (history) => history;
export const noopBudgetGate: CostBudgetGate = { check: () => undefined };
