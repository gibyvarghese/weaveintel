/**
 * @weaveintel/agents — Reflection critics
 *
 * Two built-in Critic implementations for W1 (reflection mode):
 *
 * - `createSelfCritic`  — re-prompts the same model with the FRAMEWORK_CRITIQUE
 *   template, returning accept/feedback based on the model's own evaluation.
 *
 * - `createRubricCritic` — wraps a RubricJudgeAdapter from @weaveintel/testing/evals
 *   and accepts when `score >= minScore`.
 *
 * Both share the `Critic` contract from @weaveintel/core so callers can swap
 * implementations without touching the reflection loop in agent.ts.
 */

import type { Critic, CritiqueResult, ExecutionContext } from '@weaveintel/core';
import type { Model } from '@weaveintel/core';
import type { RubricJudgeAdapter, RubricCriterion } from '@weaveintel/testing/evals';
import { FRAMEWORK_CRITIQUE, renderFramework } from '@weaveintel/prompts';

// ─── Self-critique critic ────────────────────────────────────

export interface SelfCriticOptions {
  /** The model to use for self-evaluation (typically the same model as the agent). */
  model: Model;
  /**
   * Human-readable criteria text injected into the FRAMEWORK_CRITIQUE prompt.
   * Defaults to a general quality rubric if omitted.
   */
  criteria?: string;
  /**
   * Minimum score [0,1] below which the self-critic rejects.
   * The self-critic asks the model to rate the draft 0–10; score = rating/10.
   * Defaults to 0.7 (a rating of 7/10 or above is accepted).
   */
  minScore?: number;
}

/**
 * Self-critique critic — asks the same model to review its own draft using
 * the built-in FRAMEWORK_CRITIQUE prompt framework. Returns a `CritiqueResult`
 * with `accepted: false` and actionable `feedback` when the draft falls short.
 */
export function createSelfCritic(opts: SelfCriticOptions): Critic {
  const { model, criteria, minScore = 0.7 } = opts;
  const defaultCriteria = 'Is the response accurate, complete, clear, and directly useful to the user?';

  return {
    async critique(ctx: ExecutionContext, input: string, draft: string): Promise<CritiqueResult> {
      const rendered = renderFramework(FRAMEWORK_CRITIQUE, {
        role: 'You are a rigorous quality reviewer. Your job is to evaluate the draft response below and decide if it is good enough to be sent to the user.',
        task: [
          'Review the draft response against the following criteria.',
          'Output a JSON object with exactly these fields:',
          '  { "rating": <integer 0-10>, "accepted": <boolean>, "feedback": "<string>" }',
          '`rating` is your 0–10 quality score.',
          '`accepted` is true when rating >= 7 and the response genuinely addresses the input.',
          '`feedback` is a short, actionable note on what to improve (empty string when accepted).',
        ].join('\n'),
        context: `**User input:**\n${input}\n\n**Draft response:**\n${draft}`,
        constraints: criteria ?? defaultCriteria,
        output_contract: 'Respond with ONLY the JSON object — no prose, no markdown fences.',
      });

      const response = await model.generate(ctx, {
        messages: [
          { role: 'system', content: rendered.text },
          { role: 'user', content: 'Evaluate the draft.' },
        ],
      });

      let parsed: { rating?: number; accepted?: boolean; feedback?: string } = {};
      try {
        const raw = response.content.trim().replace(/^```[a-z]*\n?|\n?```$/g, '');
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        // Model produced non-JSON — treat as rejected with raw content as feedback.
        return { accepted: false, feedback: response.content.trim(), score: 0 };
      }

      const rating = typeof parsed.rating === 'number' ? parsed.rating : 5;
      const score = Math.min(1, Math.max(0, rating / 10));
      const accepted = score >= minScore && (parsed.accepted !== false);

      return {
        accepted,
        feedback: accepted ? undefined : (parsed.feedback ?? 'The response did not meet quality criteria. Please revise.'),
        score,
      };
    },
  };
}

// ─── Rubric critic ───────────────────────────────────────────

export interface RubricCriticOptions {
  /** The rubric judge adapter (e.g. an LLM-backed scorer). */
  adapter: RubricJudgeAdapter;
  /** Criteria to score the draft against. At least one criterion required. */
  criteria: RubricCriterion[];
  /**
   * Minimum weighted score [0,1] to accept the draft.
   * Defaults to 0.7.
   */
  minScore?: number;
}

/**
 * Rubric critic — scores the draft via a `RubricJudgeAdapter` and accepts when
 * the weighted score meets `minScore`. Returns the judge's `reason` as feedback
 * when rejected so the agent knows specifically what to fix.
 */
export function createRubricCritic(opts: RubricCriticOptions): Critic {
  const { adapter, criteria, minScore = 0.7 } = opts;

  return {
    async critique(_ctx: ExecutionContext, input: string, draft: string): Promise<CritiqueResult> {
      const response = await adapter.score({
        content: draft,
        criteria,
        context: { userInput: input },
      });

      const score = typeof response.score === 'number' ? Math.min(1, Math.max(0, response.score)) : 0;
      const accepted = score >= minScore;

      return {
        accepted,
        feedback: accepted ? undefined : (response.reason ?? `Score ${score.toFixed(2)} below threshold ${minScore}. Please improve the response quality.`),
        score,
      };
    },
  };
}
