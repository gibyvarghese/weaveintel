/**
 * @weaveintel/workflows — steps.ts
 * Step type executors: deterministic, agentic, branch, loop, condition, wait, parallel, sub-workflow, human-task
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

/**
 * Wrap a promise with a step timeout. Rejects with a descriptive error on expiry.
 */
function withStepTimeout<T>(promise: Promise<T>, timeoutMs: number, stepId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Step "${stepId}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Execute a deterministic step using its registered handler. Enforces step.timeout if set. */
async function executeDeterministic(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const handlerKey = step.handler ?? step.id;
  const fn = handlers.get(handlerKey);
  if (!fn) return result(step.id, 'failed', undefined, `No handler registered for "${handlerKey}"`, start);
  try {
    let call = fn(state.variables, step.config);
    if (step.timeout && step.timeout > 0) {
      call = withStepTimeout(call, step.timeout, step.id);
    }
    const output = await call;
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
    let call = fn(state.variables, step.config);
    if (step.timeout && step.timeout > 0) {
      call = withStepTimeout(call, step.timeout, step.id);
    }
    const output = await call;
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

/**
 * Loop step — handler returns an array of items; bodyHandler (from config.bodyHandler) runs for each item.
 * If no bodyHandler is specified, returns item count only.
 */
async function executeLoop(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const handlerKey = step.handler ?? step.id;
  const fn = handlers.get(handlerKey);
  if (!fn) return result(step.id, 'failed', undefined, `No loop handler for "${handlerKey}"`, start);
  try {
    const items = await fn(state.variables, step.config);
    if (!Array.isArray(items)) {
      // Not iterable — treat as a no-op loop with the value as output
      return result(step.id, 'completed', items, undefined, start);
    }

    const bodyHandlerKey = step.config?.['bodyHandler'] as string | undefined;
    if (!bodyHandlerKey) {
      // No body handler declared — return summary only
      return result(step.id, 'completed', { count: items.length, items }, undefined, start);
    }

    const bodyFn = handlers.get(bodyHandlerKey);
    if (!bodyFn) {
      return result(step.id, 'failed', undefined, `No loop body handler for "${bodyHandlerKey}"`, start);
    }

    const results: unknown[] = [];
    for (const item of items) {
      const itemResult = await bodyFn({ ...state.variables, __loopItem: item }, step.config);
      results.push(itemResult);
    }
    return result(step.id, 'completed', { count: items.length, results }, undefined, start);
  } catch (err) {
    return result(step.id, 'failed', undefined, String(err), start);
  }
}

/** Wait step — pauses the workflow. Engine is responsible for resumption. */
async function executeWait(step: WorkflowStep, _state: WorkflowState, _handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  return result(step.id, 'completed', { paused: true });
}

/**
 * Parallel step — runs all handlers listed in config.parallelHandlers concurrently.
 * Falls back to deterministic execution if no parallelHandlers config is set.
 */
async function executeParallel(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const parallelHandlers = step.config?.['parallelHandlers'] as string[] | undefined;
  if (!parallelHandlers?.length) {
    // Fallback: treat as a single deterministic step
    return executeDeterministic(step, state, handlers);
  }

  try {
    const results = await Promise.all(
      parallelHandlers.map(hKey => {
        const fn = handlers.get(hKey);
        if (!fn) return Promise.reject(new Error(`No parallel handler registered for "${hKey}"`));
        return fn(state.variables, step.config);
      }),
    );
    return result(step.id, 'completed', { count: results.length, results }, undefined, start);
  } catch (err) {
    return result(step.id, 'failed', undefined, String(err), start);
  }
}

/** Sub-workflow step — handled by the engine referencing another workflow definition. */
async function executeSubWorkflow(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  return executeDeterministic(step, state, handlers);
}

/**
 * Human-task step — signals the engine to create a human task and pause.
 * The engine detects humanTaskRequired in the output and handles queue creation.
 */
async function executeHumanTask(step: WorkflowStep, _state: WorkflowState, _handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  return result(step.id, 'completed', { humanTaskRequired: true });
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
  'human-task': executeHumanTask,
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
