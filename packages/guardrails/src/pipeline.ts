/**
 * @weaveintel/guardrails — pipeline.ts
 * GuardrailPipeline — ordered evaluation chain with short-circuit
 */
import type { Guardrail, GuardrailEvaluationContext, GuardrailPipeline as IPipeline, GuardrailResult, GuardrailStage } from '@weaveintel/core';
import { evaluateGuardrail } from './guardrail.js';

export interface PipelineOptions {
  id?: string;
  name?: string;
  shortCircuitOnDeny?: boolean;
}

export class DefaultGuardrailPipeline implements IPipeline {
  id: string;
  name: string;
  guardrails: Guardrail[];
  shortCircuitOnDeny: boolean;

  constructor(guardrails: Guardrail[], opts?: PipelineOptions) {
    this.id = opts?.id ?? 'default-pipeline';
    this.name = opts?.name ?? 'Default Guardrail Pipeline';
    this.guardrails = [...guardrails].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    this.shortCircuitOnDeny = opts?.shortCircuitOnDeny ?? true;
  }

  async evaluate(input: unknown, stage: GuardrailStage, context?: GuardrailEvaluationContext): Promise<GuardrailResult[]> {
    const applicableGuardrails = this.guardrails.filter(g => g.stage === stage && g.enabled);
    const results: GuardrailResult[] = [];

    for (const guardrail of applicableGuardrails) {
      const result = evaluateGuardrail(guardrail, input, stage, { ...context, previousResults: results });
      results.push(result);

      if (this.shortCircuitOnDeny && result.decision === 'deny') {
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

export function createGuardrailPipeline(guardrails: Guardrail[], opts?: PipelineOptions): DefaultGuardrailPipeline {
  return new DefaultGuardrailPipeline(guardrails, opts);
}

/** Helper: check if any result denies. */
export function hasDeny(results: GuardrailResult[]): boolean {
  return results.some(r => r.decision === 'deny');
}

/** Helper: check if any result warns. */
export function hasWarning(results: GuardrailResult[]): boolean {
  return results.some(r => r.decision === 'warn');
}

/** Helper: get the first deny result's explanation. */
export function getDenyReason(results: GuardrailResult[]): string | undefined {
  return results.find(r => r.decision === 'deny')?.explanation;
}
