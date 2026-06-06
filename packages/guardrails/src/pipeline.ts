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
      // W9: skip model-graded guardrails when the pipeline budget is exceeded.
      const elapsed = Date.now() - pipelineStart;
      if (this.opts.budgetMs !== undefined && elapsed >= this.opts.budgetMs && guardrail.type === 'model-graded') {
        results.push({
          decision: 'allow',
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
