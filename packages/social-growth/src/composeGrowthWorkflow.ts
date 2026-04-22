import type { WorkflowDefinition, WorkflowStep } from '@weaveintel/core';
import type { SgStepConfig, SgWorkflowTemplate } from './types.js';

function toStep(step: SgStepConfig): WorkflowStep {
  return {
    id: step.id,
    name: step.name,
    type: 'deterministic',
    handler: step.type,
    config: step.config,
    retries: 0,
  };
}

export function composeGrowthWorkflow(template: SgWorkflowTemplate): WorkflowDefinition {
  const steps = template.steps.map(toStep);
  const entryStepId = steps[0]?.id ?? 'start';
  return {
    id: template.id,
    name: template.name,
    version: '1.0',
    steps,
    entryStepId,
    metadata: {
      domain: 'social-growth',
      triggerType: template.triggerType,
    },
  };
}
