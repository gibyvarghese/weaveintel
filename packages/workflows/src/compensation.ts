/**
 * @weaveintel/workflows — compensation.ts
 * Rollback and compensation handlers for failed workflow runs
 */
import type { WorkflowCompensation, WorkflowStepResult } from '@weaveintel/core';

export type CompensationHandler = (
  stepId: string,
  stepResult: WorkflowStepResult,
  variables: Record<string, unknown>,
) => Promise<void>;

export interface CompensationRegistry {
  register(comp: WorkflowCompensation, handler: CompensationHandler): void;
  get(stepId: string): { comp: WorkflowCompensation; handler: CompensationHandler } | undefined;
  has(stepId: string): boolean;
}

export class DefaultCompensationRegistry implements CompensationRegistry {
  private handlers = new Map<string, { comp: WorkflowCompensation; handler: CompensationHandler }>();

  register(comp: WorkflowCompensation, handler: CompensationHandler): void {
    this.handlers.set(comp.stepId, { comp, handler });
  }

  get(stepId: string) {
    return this.handlers.get(stepId);
  }

  has(stepId: string): boolean {
    return this.handlers.has(stepId);
  }
}

/**
 * Execute compensation handlers in reverse order for completed steps.
 */
export async function runCompensations(
  registry: CompensationRegistry,
  completedSteps: WorkflowStepResult[],
  variables: Record<string, unknown>,
): Promise<{ compensated: string[]; errors: Array<{ stepId: string; error: string }> }> {
  const compensated: string[] = [];
  const errors: Array<{ stepId: string; error: string }> = [];

  // Run in reverse (most recent first)
  const reversed = [...completedSteps].reverse();
  for (const step of reversed) {
    const entry = registry.get(step.stepId);
    if (!entry) continue;
    try {
      await entry.handler(step.stepId, step, variables);
      compensated.push(step.stepId);
    } catch (err) {
      errors.push({ stepId: step.stepId, error: String(err) });
    }
  }
  return { compensated, errors };
}
