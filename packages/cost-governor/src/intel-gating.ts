/**
 * Phase 6a — Intel-Gated Prompt Sections (lever L4).
 *
 * Per-tick decision that asks "how much intel do we already have on this
 * task?" and uses the answer to drop expensive prompt sections (intel
 * headers, retrieved snippets) when the agent has enough context to
 * proceed without them.
 *
 * The `IntelScore` is a single 0..1 number provided by the consumer via an
 * `IntelScoreProvider`. The package never computes the score — different
 * domains (kaggle, scientific-validation, customer-support) have totally
 * different signals. The package owns the *decision* (cheap → cheap → drop).
 *
 * Decision table (using `thresholds.high` and `thresholds.low` from
 * `IntelGatingConfig`; defaults: high=0.7, low=0.4):
 *
 *   score === null              → keep header + snippets (no signal)
 *   score >= thresholds.high    → drop header + drop snippets (rich context)
 *   score >= thresholds.low     → keep header,  drop snippets (some context)
 *   score <  thresholds.low     → keep header + keep snippets  (cold-start)
 *
 * Reusability invariant: this module imports only from `@weaveintel/core`
 * and the cost-governor's own types. Apps wire it via the
 * `bundle.promptShaper` slot returned by `weaveCostGovernor()`.
 *
 * Graceful-degradation invariant (HARD): the gate is NEVER load-bearing.
 * Null score, null config, disabled config, missing thresholds, or thrown
 * errors all fall through to KEEP-EVERYTHING. Tests assert each branch.
 */

import type { CostLeverContext, CostPromptShaper, PromptShape } from './governor.js';
import type { IntelGatingConfig, IntelThresholds } from './policy.js';

/** A normalised intel-confidence score in `[0, 1]`. */
export type IntelScore = number;

/** Per-call signal carried alongside the lever context for score lookup. */
export interface IntelScoreContext extends CostLeverContext {
  /** Optional task identifier — useful when one mesh runs multiple tasks. */
  readonly taskRef?: string;
}

/**
 * Pluggable provider that returns the consumer-specific score for a given
 * context. Returning `null` means "no score available" → the gate keeps
 * everything (cold-start safety).
 *
 * Implementations MUST NOT throw — but the gate catches and treats throws
 * as null anyway (defence in depth).
 */
export interface IntelScoreProvider {
  compute(ctx: IntelScoreContext): Promise<IntelScore | null> | IntelScore | null;
}

/** Section keys the gate may drop. Apps decide which keys map to which
 *  sections in their `prepare()` — these names are conventional only. */
export const INTEL_HEADER_SECTION = 'intel_header';
export const INTEL_SNIPPETS_SECTION = 'intel_snippets';

/** Pure decision returned by `decideIntelGating`. */
export interface IntelGatingDecision {
  /** When `false`, the prepare() should drop the intel header section. */
  readonly keepIntelHeader: boolean;
  /** When `false`, the prepare() should drop the retrieved-snippets section. */
  readonly keepSnippets: boolean;
  /** The score this decision was based on (null when no signal). */
  readonly score: IntelScore | null;
  /** Human-readable reason — useful for audit logs. */
  readonly reason: string;
}

/** Defaults applied when the operator config omits `thresholds`. */
const DEFAULT_THRESHOLDS: Required<IntelThresholds> = { low: 0.4, high: 0.7 };

/**
 * Pure decision: given a config and a score, return what to drop. Never
 * throws. When config is missing/disabled OR score is null, returns the
 * conservative "keep everything" decision.
 */
export function decideIntelGating(
  config: IntelGatingConfig | null | undefined,
  score: IntelScore | null,
): IntelGatingDecision {
  if (!config || config.enabled === false) {
    return {
      keepIntelHeader: true,
      keepSnippets: true,
      score,
      reason: !config ? 'no-config' : 'disabled',
    };
  }
  if (score === null || typeof score !== 'number' || Number.isNaN(score)) {
    return {
      keepIntelHeader: true,
      keepSnippets: true,
      score: null,
      reason: 'score=null',
    };
  }
  const clamped = Math.max(0, Math.min(1, score));
  const thresholds: Required<IntelThresholds> = {
    low: config.thresholds?.low ?? DEFAULT_THRESHOLDS.low,
    high: config.thresholds?.high ?? DEFAULT_THRESHOLDS.high,
  };
  if (clamped >= thresholds.high) {
    return {
      keepIntelHeader: false,
      keepSnippets: false,
      score: clamped,
      reason: `score=${clamped.toFixed(2)} >= high=${thresholds.high}`,
    };
  }
  if (clamped >= thresholds.low) {
    return {
      keepIntelHeader: true,
      keepSnippets: false,
      score: clamped,
      reason: `score=${clamped.toFixed(2)} >= low=${thresholds.low}`,
    };
  }
  return {
    keepIntelHeader: true,
    keepSnippets: true,
    score: clamped,
    reason: `score=${clamped.toFixed(2)} < low=${thresholds.low}`,
  };
}

/**
 * Builds a `CostPromptShaper` (the `bundle.promptShaper` slot) that:
 *   1. Calls `provider.compute(ctx)` to get the intel score.
 *   2. Calls `decideIntelGating(config, score)` to get the keep/drop verdict.
 *   3. Translates the verdict into a `PromptShape` (`dropSections` array).
 *
 * Returns `null` (= no shape change) when both sections should be kept,
 * so apps that don't want to declare "keep all" sections explicitly can
 * just pass through. Errors thrown by `provider.compute` are caught,
 * logged to `console.warn`, and treated as `score=null`.
 */
export function weaveIntelGate(
  config: IntelGatingConfig,
  provider: IntelScoreProvider,
  opts?: { log?: (msg: string) => void },
): CostPromptShaper {
  const log = opts?.log ?? ((m) => console.warn(`[cost-governor:intel-gate] ${m}`));
  return async (ctx: CostLeverContext): Promise<PromptShape | null> => {
    let score: IntelScore | null = null;
    try {
      const result = await provider.compute(ctx as IntelScoreContext);
      if (typeof result === 'number' && !Number.isNaN(result)) {
        score = Math.max(0, Math.min(1, result));
      }
    } catch (err) {
      log(`provider.compute threw: ${err instanceof Error ? err.message : String(err)} — treating as score=null`);
      score = null;
    }
    const decision = decideIntelGating(config, score);
    if (decision.keepIntelHeader && decision.keepSnippets) return null;
    const drop: string[] = [];
    if (!decision.keepIntelHeader) drop.push(INTEL_HEADER_SECTION);
    if (!decision.keepSnippets) drop.push(INTEL_SNIPPETS_SECTION);
    return { dropSections: drop };
  };
}

/**
 * Convenience: turn a `PromptShape` into a quick-check for a section key.
 * Apps in `prepare()` can write:
 *   `if (shouldKeepSection(shape, INTEL_HEADER_SECTION)) { ...append header... }`
 */
export function shouldKeepSection(shape: PromptShape | null, sectionKey: string): boolean {
  if (!shape) return true;
  const drop = shape.dropSections ?? [];
  if (drop.includes(sectionKey)) return false;
  const keep = shape.keepSections;
  if (keep === null || keep === undefined) return true;
  return keep.includes(sectionKey);
}
