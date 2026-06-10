/**
 * @weaveintel/agents — Verifier implementations (W2)
 *
 * `weaveRubricVerifier` wraps a `RubricJudgeAdapter` as a `Verifier`.
 * The verify→regenerate loop in `weaveAgent` calls `verifier.verify()` on
 * each terminal response and regenerates when `passed: false`.
 *
 * The `Critic` from reflect.ts is a superset of `Verifier` — every critic
 * is also a verifier. `weaveRubricVerifier` exposes the simpler pass/fail
 * surface without requiring feedback text.
 */

import type { Verifier, VerifyResult, ExecutionContext } from '@weaveintel/core';
import type { RubricJudgeAdapter, RubricCriterion } from '@weaveintel/evals';

export interface RubricVerifierOptions {
  /** Rubric judge to score the output. */
  adapter: RubricJudgeAdapter;
  /** Criteria to evaluate against. */
  criteria: RubricCriterion[];
  /**
   * Minimum weighted score [0,1] to pass.
   * Defaults to 0.7.
   */
  minScore?: number;
}

/**
 * Build a `Verifier` backed by a `RubricJudgeAdapter`.
 * Use this when you want automatic regeneration on quality failures without
 * the conversational feedback-loop of the W1 self-critique critic.
 *
 * @example
 * const verifier = weaveRubricVerifier(myAdapter, {
 *   criteria: [{ id: 'relevance', description: 'Directly answers the question', weight: 1 }],
 *   minScore: 0.8,
 * });
 * const agent = weaveAgent({ model, verify: { verifier, maxAttempts: 2 } });
 */
export function weaveRubricVerifier(
  adapter: RubricJudgeAdapter,
  opts: Omit<RubricVerifierOptions, 'adapter'>,
): Verifier {
  const { criteria, minScore = 0.7 } = opts;

  return {
    async verify(_ctx: ExecutionContext, output: string, context?: Record<string, unknown>): Promise<VerifyResult> {
      const response = await adapter.score({
        content: output,
        criteria,
        context,
      });

      const score = typeof response.score === 'number' ? Math.min(1, Math.max(0, response.score)) : 0;
      const passed = score >= minScore;

      return {
        passed,
        reason: passed ? undefined : (response.reason ?? `Score ${score.toFixed(2)} below threshold ${minScore}`),
        score,
      };
    },
  };
}
