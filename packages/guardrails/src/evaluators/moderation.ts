/**
 * @weaveintel/guardrails — evaluators/moderation.ts  (W2)
 *
 * Async guardrail evaluator that calls a `ModerationModel` (e.g. OpenAI
 * Moderation API) and maps flagged categories to `deny`/`warn` based on
 * the guardrail config.
 *
 * config shape:
 *   categories?: string[]   — which categories trigger the action (default: all flagged)
 *   threshold?: number      — minimum per-category score to trigger (default: 0)
 *   action?: 'deny'|'warn'  — decision when triggered (default: 'deny')
 */
import type { AsyncGuardrailContext, Guardrail, GuardrailResult } from '@weaveintel/core';

export function createModerationEvaluator() {
  return async function moderationEvaluator(
    guardrail: Guardrail,
    input: string,
    ctx: AsyncGuardrailContext,
  ): Promise<GuardrailResult> {
    if (!ctx.moderationModel) {
      return {
        decision: 'allow',
        guardrailId: guardrail.id,
        explanation: 'No moderation model provided — skipping moderation check',
        metadata: { skipped: 'no_moderation_model' },
      };
    }

    const configCategories = guardrail.config['categories'] as string[] | undefined;
    const threshold = typeof guardrail.config['threshold'] === 'number'
      ? guardrail.config['threshold'] : 0;
    const action = guardrail.config['action'] === 'warn' ? 'warn' : 'deny';

    const response = await ctx.moderationModel.moderate(
      // ModerationModel.moderate takes ExecutionContext as first arg — we pass a minimal stub
      // since guardrail evaluators don't carry a full ExecutionContext.
      {} as Parameters<typeof ctx.moderationModel.moderate>[0],
      { input },
    );

    const flaggedCategories: string[] = [];
    let maxScore = 0;

    for (const result of response.results) {
      for (const cat of result.categories) {
        if (cat.flagged && cat.score >= threshold) {
          if (!configCategories || configCategories.includes(cat.category)) {
            flaggedCategories.push(cat.category);
            if (cat.score > maxScore) maxScore = cat.score;
          }
        }
      }
    }

    if (flaggedCategories.length > 0) {
      return {
        decision: action,
        guardrailId: guardrail.id,
        explanation: `Content flagged by moderation: ${flaggedCategories.join(', ')} (max score: ${maxScore.toFixed(3)})`,
        confidence: 1 - maxScore,
        metadata: {
          flaggedCategories,
          maxScore,
          durationMs: 0, // overwritten by pipeline
        },
      };
    }

    return {
      decision: 'allow',
      guardrailId: guardrail.id,
      explanation: 'Content passed moderation check',
      confidence: 1,
      metadata: { maxScore },
    };
  };
}
