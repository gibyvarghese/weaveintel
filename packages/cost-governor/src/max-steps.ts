/**
 * Phase 7 — Max-Steps Cap (lever L6).
 *
 * Pure decision: clamp a caller-requested ReAct iteration cap against the
 * policy's `maxStepsCap`. Tier presets (economy=20, balanced=40,
 * performance=60, max=80) supply the default cap; operators can override
 * via `cost_policies.levers_json.maxStepsCap`.
 *
 * Reusability invariant: this module imports only from the cost-governor's
 * own types. No core, no provider, no DB. Apps wire it via the
 * `bundle.maxStepsCap` slot returned by `weaveCostGovernor()`.
 *
 * NEVER load-bearing: invalid inputs (negative, NaN, undefined) fall back
 * to the cap. The clamp only narrows; it never widens.
 */

import type { ResolvedCostPolicy } from './policy.js';

export interface MaxStepsDecision {
  /** Effective step cap after clamping. */
  readonly maxSteps: number;
  /** True when the requested value was reduced by the cap. */
  readonly clamped: boolean;
  /** The original requested value (when supplied) for audit logging. */
  readonly requested?: number;
  /** The cap that was applied. */
  readonly cap: number;
}

/**
 * Pure decision. Returns a `MaxStepsDecision` describing the effective
 * step cap. When `requested` is missing, non-positive, or non-finite, the
 * cap is returned as-is. Otherwise `min(requested, cap)`.
 */
export function decideMaxStepsDetailed(
  policy: Pick<ResolvedCostPolicy, 'maxStepsCap'>,
  requested?: number,
): MaxStepsDecision {
  const cap = Math.max(1, policy.maxStepsCap);
  const reqValid = typeof requested === 'number' && Number.isFinite(requested) && requested > 0;
  if (!reqValid) {
    return { maxSteps: cap, clamped: false, cap };
  }
  const eff = Math.min(requested, cap);
  return {
    maxSteps: eff,
    clamped: eff < requested,
    requested,
    cap,
  };
}

/** Convenience wrapper returning only the effective cap. */
export function decideMaxSteps(
  policy: Pick<ResolvedCostPolicy, 'maxStepsCap'>,
  requested?: number,
): number {
  return decideMaxStepsDetailed(policy, requested).maxSteps;
}
