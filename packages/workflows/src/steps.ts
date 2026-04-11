/**
 * @weaveintel/workflows — steps.ts
 * Step type executors: deterministic, agentic, branch, loop, condition, wait, parallel, sub-workflow
 */
import type { WorkflowStep, WorkflowState, WorkflowStepResult } from '@weaveintel/core';

export type StepExecutor = (
  step: WorkflowStep,
  state: WorkflowState,
  handlers: StepHandlerMap,
) => Promise<WorkflowStepResult>;

export type StepHandler = (
  variables: Record<string, unknown>,
  config?: Record<string, unknown>,
) => Promise<unknown>;

export type StepHandlerMap = Map<string, StepHandler>;

function now(): string {
  return new Date().toISOString();
}

function result(
  stepId: string,
  status: 'completed' | 'failed' | 'skipped',
  output?: unknown,
  error?: string,
  startedAt?: string,
): WorkflowStepResult {
  return { stepId, status, output, error, startedAt: startedAt ?? now(), completedAt: now() };
}

/** Execute a deterministic step using its registered handler. */
async function executeDeterministic(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const handlerKey = step.handler ?? step.id;
  const fn = handlers.get(handlerKey);
  if (!fn) return result(step.id, 'failed', undefined, `No handler registered for "${handlerKey}"`, start);
  try {
    const output = await fn(state.variables, step.config);
    return result(step.id, 'completed', output, undefined, start);
  } catch (err) {
    return result(step.id, 'failed', undefined, String(err), start);
  }
}

/** Execute an agentic step — same as deterministic but semantically implies model call. */
async function executeAgentic(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  return executeDeterministic(step, state, handlers);
}

/** Evaluate a condition step — runs handler, output is truthy/falsy. */
async function executeCondition(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const handlerKey = step.handler ?? step.id;
  const fn = handlers.get(handlerKey);
  if (!fn) return result(step.id, 'failed', undefined, `No condition handler for "${handlerKey}"`, start);
  try {
    const output = await fn(state.variables, step.config);
    return result(step.id, 'completed', Boolean(output), undefined, start);
  } catch (err) {
    return result(step.id, 'failed', undefined, String(err), start);
  }
}

/** Branch step — evaluates handler to pick which next step to take. */
async function executeBranch(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const handlerKey = step.handler ?? step.id;
  const fn = handlers.get(handlerKey);
  if (!fn) return result(step.id, 'failed', undefined, `No branch handler for "${handlerKey}"`, start);
  try {
    const output = await fn(state.variables, step.config);
    return result(step.id, 'completed', output, undefined, start);
  } catch (err) {
    return result(step.id, 'failed', undefined, String(err), start);
  }
}

/** Loop step — handler returns items to iterate; engine handles iteration. */
async function executeLoop(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const handlerKey = step.handler ?? step.id;
  const fn = handlers.get(handlerKey);
  if (!fn) return result(step.id, 'failed', undefined, `No loop handler for "${handlerKey}"`, start);
  try {
    const output = await fn(state.variables, step.config);
    return result(step.id, 'completed', output, undefined, start);
  } catch (err) {
    return result(step.id, 'failed', undefined, String(err), start);
  }
}

/** Wait step — pauses the workflow. Engine is responsible for resumption. */
async function executeWait(step: WorkflowStep, _state: WorkflowState, _handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  return result(step.id, 'completed', { paused: true });
}

/** Parallel step — conceptual; actual parallel dispatch is handled by the engine. */
async function executeParallel(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  return executeDeterministic(step, state, handlers);
}

/** Sub-workflow step — handled by the engine referencing another workflow definition. */
async function executeSubWorkflow(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  return executeDeterministic(step, state, handlers);
}

const executors: Record<string, StepExecutor> = {
  deterministic: executeDeterministic,
  agentic: executeAgentic,
  condition: executeCondition,
  branch: executeBranch,
  loop: executeLoop,
  wait: executeWait,
  parallel: executeParallel,
  'sub-workflow': executeSubWorkflow,
};

export function getStepExecutor(type: string): StepExecutor | undefined {
  return executors[type];
}

export function executeStep(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const executor = executors[step.type];
  if (!executor) {
    return Promise.resolve(result(step.id, 'failed', undefined, `Unknown step type: ${step.type}`));
  }
  return executor(step, state, handlers);
}
