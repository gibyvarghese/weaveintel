/**
 * @weaveintel/guardrails — pipeline.ts
 * GuardrailPipeline — ordered evaluation chain with short-circuit.
 *
 * W1: evaluate() now calls evaluateGuardrailAsync so model-graded guardrails
 *     with a registered evaluator run their actual async logic. Sync types
 *     resolve immediately — zero behaviour change for existing callers.
 * W9: durationMs recorded in every GuardrailResult.metadata. Optional
 *     budgetMs skips remaining model-graded guardrails when exceeded.
 */
import type {
  AsyncGuardrailContext,
  Guardrail,
  GuardrailPipeline as IPipeline,
  GuardrailResult,
  GuardrailStage,
  Model,
  EmbeddingModel,
  ModerationModel,
} from '@weaveintel/core';
import { evaluateGuardrailAsync, type AsyncEvaluatorRegistry } from './async-evaluator.js';
import { type GuardrailConditionContext } from './condition-context.js';
import { evaluateCondition } from './condition-evaluator.js';

export interface PipelineOptions {
  id?: string;
  name?: string;
  shortCircuitOnDeny?: boolean;
  /** LLM for model-graded evaluators (W2). */
  model?: Model;
  /** Moderation API client for moderation-type evaluators (W2). */
  moderationModel?: ModerationModel;
  /** Embedding model for semantic-grounding evaluators (W3). */
  embeddingModel?: EmbeddingModel;
  /** Override the default built-in evaluator registry (W1). */
  registry?: AsyncEvaluatorRegistry;
  /**
   * Total wall-clock budget in ms for the pipeline evaluation (W9).
   * When exceeded, remaining model-graded guardrails are skipped (they record
   * a metadata.skipped: 'budget_exceeded' note). Cheap sync guardrails always
   * run. Default: no budget.
   */
  budgetMs?: number;
  /**
   * M-8: Controls how budget-exhausted (skipped) guardrail results are
   * treated by `hasSkipped()` and downstream callers.
   *
   * - `'allow'` (default): a skipped guardrail is not counted as a denial —
   *   permissive pipelines accept this trade-off for latency reasons.
   * - `'deny'`: a skipped guardrail is treated as a denial — use for security-
   *   sensitive pipelines where running out of budget must block the response.
   *
   * Note: the `decision` field in the `GuardrailResult` is always `'skipped'`
   * regardless of this policy; `budgetExhaustedPolicy` only affects the
   * `hasSkippedViolation()` helper and any caller that inspects it.
   */
  budgetExhaustedPolicy?: 'allow' | 'deny';
  /**
   * Condition context for conditional trigger evaluation (Phase 1/2).
   * When provided, each guardrail's triggerConditions tree is evaluated against
   * this context before invocation. A guardrail whose condition is not met is
   * skipped and recorded with metadata.skipped: 'condition_not_met'.
   * When absent, all guardrails run regardless of their triggerConditions.
   */
  conditionContext?: GuardrailConditionContext;
}

export class DefaultGuardrailPipeline implements IPipeline {
  id: string;
  name: string;
  guardrails: Guardrail[];
  shortCircuitOnDeny: boolean;
  private readonly opts: PipelineOptions;

  constructor(guardrails: Guardrail[], opts?: PipelineOptions) {
    this.id = opts?.id ?? 'default-pipeline';
    this.name = opts?.name ?? 'Default Guardrail Pipeline';
    this.guardrails = [...guardrails].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    this.shortCircuitOnDeny = opts?.shortCircuitOnDeny ?? true;
    this.opts = opts ?? {};
  }

  async evaluate(
    input: unknown,
    stage: GuardrailStage,
    context?: AsyncGuardrailContext,
  ): Promise<GuardrailResult[]> {
    const applicableGuardrails = this.guardrails.filter(g => g.stage === stage && g.enabled);
    const results: GuardrailResult[] = [];
    const pipelineStart = Date.now();

    // Build enriched context with model references from pipeline options.
    const enrichedCtx: AsyncGuardrailContext = {
      ...context,
      model: context?.model ?? this.opts.model,
      moderationModel: context?.moderationModel ?? this.opts.moderationModel,
      embeddingModel: context?.embeddingModel ?? this.opts.embeddingModel,
    };

    for (const guardrail of applicableGuardrails) {
      // Phase 2: skip guardrails whose trigger condition is not met.
      if (this.opts.conditionContext !== undefined) {
        if (!evaluateCondition(guardrail.triggerConditions, this.opts.conditionContext)) {
          results.push({
            decision: 'allow',
            guardrailId: guardrail.id,
            explanation: 'skipped — condition not met',
            metadata: { skipped: 'condition_not_met', durationMs: 0 },
          });
          continue;
        }
      }

      // M-8: skip model-graded guardrails when the pipeline budget is exceeded.
      // Decision is 'skipped' (not 'allow') so callers and audit logs can
      // distinguish "actively evaluated and passed" from "never ran". Whether
      // a skipped result counts as a violation depends on budgetExhaustedPolicy
      // (checked by hasSkippedViolation below). Default policy is 'allow' to
      // preserve existing behaviour; set to 'deny' for security-sensitive pipelines.
      const elapsed = Date.now() - pipelineStart;
      if (this.opts.budgetMs !== undefined && elapsed >= this.opts.budgetMs && guardrail.type === 'model-graded') {
        results.push({
          decision: 'skipped',
          guardrailId: guardrail.id,
          explanation: `Skipped: pipeline budget of ${this.opts.budgetMs}ms exceeded (elapsed ${elapsed}ms)`,
          metadata: { skipped: 'budget_exceeded', durationMs: 0 },
        });
        continue;
      }

      const stepStart = Date.now();
      const result = await evaluateGuardrailAsync(
        guardrail,
        input,
        stage,
        { ...enrichedCtx, previousResults: results },
        this.opts.registry,
      );

      // W9: record step timing.
      const durationMs = Date.now() - stepStart;
      const enrichedResult: GuardrailResult = {
        ...result,
        metadata: { ...result.metadata, durationMs },
      };

      results.push(enrichedResult);

      if (this.shortCircuitOnDeny && enrichedResult.decision === 'deny') {
        break;
      }
    }

    return results;
  }

  addGuardrail(g: Guardrail): void {
    this.guardrails.push(g);
    this.guardrails.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }

  removeGuardrail(id: string): void {
    this.guardrails = this.guardrails.filter(g => g.id !== id);
  }
}

export function createGuardrailPipeline(
  guardrails: Guardrail[],
  opts?: PipelineOptions,
): DefaultGuardrailPipeline {
  return new DefaultGuardrailPipeline(guardrails, opts);
}

export function hasDeny(results: GuardrailResult[]): boolean {
  return results.some(r => r.decision === 'deny');
}

export function hasWarning(results: GuardrailResult[]): boolean {
  return results.some(r => r.decision === 'warn');
}

export function getDenyReason(results: GuardrailResult[]): string | undefined {
  return results.find(r => r.decision === 'deny')?.explanation;
}

/**
 * M-8: Returns true when any result has `decision: 'skipped'` AND the
 * pipeline's `budgetExhaustedPolicy` is `'deny'`.
 *
 * Use this alongside `hasDeny` when the caller must enforce a strict posture
 * (no unevaluated guardrails allowed):
 *
 *   if (hasDeny(results) || hasSkippedViolation(results, pipeline.opts)) { ... }
 *
 * @param results  The array returned by `pipeline.evaluate()`.
 * @param policy   The `budgetExhaustedPolicy` value from `PipelineOptions`.
 *                 Defaults to `'allow'` when absent (backward-compatible).
 */
export function hasSkippedViolation(
  results: GuardrailResult[],
  policy: PipelineOptions['budgetExhaustedPolicy'] = 'allow',
): boolean {
  if (policy !== 'deny') return false;
  return results.some(r => r.decision === 'skipped');
}
