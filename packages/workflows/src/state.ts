/**
 * @weaveintel/workflows — state.ts
 * WorkflowState management and utilities
 */
import type { WorkflowState, WorkflowStepResult, WorkflowDefinition } from '@weaveintel/core';

/** Create an initial workflow state from a definition and optional input variables. */
export function createInitialState(
  def: WorkflowDefinition,
  input?: Record<string, unknown>,
): WorkflowState {
  return {
    currentStepId: def.entryStepId,
    variables: { ...input },
    history: [],
  };
}

/** Advance state to the next step after a result. */
export function advanceState(
  state: WorkflowState,
  stepResult: WorkflowStepResult,
  nextStepId: string | undefined,
): WorkflowState {
  const newHistory = [...state.history, stepResult];
  const newVars = { ...state.variables };
  if (stepResult.output !== undefined) {
    newVars[`__step_${stepResult.stepId}`] = stepResult.output;
  }
  return {
    currentStepId: nextStepId ?? state.currentStepId,
    variables: newVars,
    history: newHistory,
    checkpointId: state.checkpointId,
  };
}

/** Resolve the next step ID from a step definition, considering branching/conditions. */
export function resolveNextStep(
  def: WorkflowDefinition,
  currentStepId: string,
  stepResult: WorkflowStepResult,
): string | undefined {
  const step = def.steps.find(s => s.id === currentStepId);
  if (!step) return undefined;

  if (step.type === 'branch' || step.type === 'condition') {
    const branches = step.next;
    if (Array.isArray(branches)) {
      const branchIndex = stepResult.output ? 0 : 1;
      return branches[branchIndex] ?? undefined;
    }
  }

  if (typeof step.next === 'string') return step.next;
  if (Array.isArray(step.next)) return step.next[0];
  return undefined;
}

/** Check if workflow has reached its terminal state (no more steps). */
export function isTerminal(def: WorkflowDefinition, state: WorkflowState): boolean {
  const step = def.steps.find(s => s.id === state.currentStepId);
  if (!step) return true;
  const lastResult = state.history[state.history.length - 1];
  if (!lastResult || lastResult.stepId !== state.currentStepId) return false;
  return resolveNextStep(def, state.currentStepId, lastResult) === undefined;
}
