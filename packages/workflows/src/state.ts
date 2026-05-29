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

/**
 * Advance state to the next step after a result.
 *
 * Phase W3 extensions:
 *  - `ephemeral`: when true the step output is written to
 *    `state.ephemeralVariables` instead of `state.variables`.  Ephemeral
 *    variables are NOT checkpointed or persisted; they are cleared at the
 *    start of every step (see engine.ts).
 *  - The previous step's `ephemeralVariables` are always cleared so they
 *    do not accumulate across steps.
 */
export function advanceState(
  state: WorkflowState,
  stepResult: WorkflowStepResult,
  nextStepId: string | undefined,
  ephemeral = false,
): WorkflowState {
  const newHistory = [...state.history, stepResult];

  if (ephemeral) {
    return {
      currentStepId: nextStepId ?? state.currentStepId,
      variables: { ...state.variables },
      ephemeralVariables: stepResult.output !== undefined
        ? { [`__step_${stepResult.stepId}`]: stepResult.output }
        : {},
      history: newHistory,
      checkpointId: state.checkpointId,
    };
  }

  const newVars = { ...state.variables };
  if (stepResult.output !== undefined) {
    newVars[`__step_${stepResult.stepId}`] = stepResult.output;
  }
  return {
    currentStepId: nextStepId ?? state.currentStepId,
    variables: newVars,
    ephemeralVariables: {},   // clear previous step's ephemeral data
    history: newHistory,
    checkpointId: state.checkpointId,
  };
}

/** Resolve the next step ID from a step definition, considering branching/conditions. */
export function resolveNextStep(
  def: WorkflowDefinition,
  currentStepId: string,
  stepResult: WorkflowStepResult,
  // Phase W7 — when routing within an effectiveDef that includes appended dynamic
  // steps, the declaration-order fallback must not route an original (non-dynamic)
  // step into a dynamic step. Pass the set of dynamic step ids to enable this guard.
  dynamicStepIds?: ReadonlySet<string>,
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

  // Phase W1 — switch: route by string case key returned from the handler.
  // config.cases: Record<caseKey, stepId>; 'default' is the fallback.
  if (step.type === 'switch') {
    const cases = step.config?.['cases'] as Record<string, string> | undefined;
    if (cases) {
      const key = String(stepResult.output ?? '');
      return cases[key] ?? cases['default'];
    }
    // Fallback: treat like branch (positional)
    if (Array.isArray(step.next)) {
      const idx = typeof stepResult.output === 'number' ? stepResult.output : 0;
      return step.next[idx];
    }
  }

  if (typeof step.next === 'string') return step.next;
  if (Array.isArray(step.next)) return step.next[0];

  const isBranchTarget = def.steps.some(s => Array.isArray(s.next) && s.next.includes(currentStepId));
  if (isBranchTarget) {
    return undefined;
  }

  // Default to declaration order when next is not explicitly provided.
  // Phase W7: when dynamic steps are appended to effectiveDef, skip them in the
  // fallback for original (non-dynamic) steps so they don't accidentally route into
  // the generated sub-graph. Dynamic steps may still chain to each other via fallback.
  const currentIsDynamic = dynamicStepIds?.has(currentStepId) ?? false;
  const currentIndex = def.steps.findIndex(s => s.id === currentStepId);
  if (currentIndex >= 0) {
    for (let i = currentIndex + 1; i < def.steps.length; i++) {
      const candidateId = def.steps[i]?.id;
      if (!candidateId) break;
      if (!currentIsDynamic && dynamicStepIds?.has(candidateId)) continue; // skip dynamic
      return candidateId;
    }
  }
  return undefined;
}

/** Check if workflow has reached its terminal state (no more steps). */
export function isTerminal(
  def: WorkflowDefinition,
  state: WorkflowState,
  dynamicStepIds?: ReadonlySet<string>,
): boolean {
  const step = def.steps.find(s => s.id === state.currentStepId);
  if (!step) return true;
  const lastResult = state.history[state.history.length - 1];
  if (!lastResult || lastResult.stepId !== state.currentStepId) return false;
  return resolveNextStep(def, state.currentStepId, lastResult, dynamicStepIds) === undefined;
}
