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
 * Parallel step — two modes:
 *  1. Named lanes: `config.lanes: Record<name, handlerKey>` — results are a Record<name, output>.
 *  2. Positional: `config.parallelHandlers: string[]` — results are a positional array.
 * Falls back to deterministic execution if neither config is set.
 */
async function executeParallel(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();

  // Named-lane mode
  const lanes = step.config?.['lanes'] as Record<string, string> | undefined;
  if (lanes && Object.keys(lanes).length > 0) {
    try {
      const entries = Object.entries(lanes);
      const laneResults = await Promise.all(
        entries.map(async ([laneName, handlerKey]) => {
          const fn = handlers.get(handlerKey);
          if (!fn) throw new Error(`No handler registered for parallel lane "${laneName}" (handler: "${handlerKey}")`);
          const r = await fn(state.variables, step.config);
          return [laneName, r] as [string, unknown];
        }),
      );
      return result(step.id, 'completed', Object.fromEntries(laneResults), undefined, start);
    } catch (err) {
      return result(step.id, 'failed', undefined, String(err), start);
    }
  }

  // Positional mode (existing behaviour)
  const parallelHandlers = step.config?.['parallelHandlers'] as string[] | undefined;
  if (!parallelHandlers?.length) {
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

// ─── Phase W1 — New step executors ────────────────────────────

/**
 * Switch step — handler returns a string case key.
 * Routing is resolved in `state.ts` via `config.cases: Record<key, stepId>`.
 * The step itself just evaluates the handler and returns the case key as output.
 */
async function executeSwitch(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const handlerKey = step.handler ?? step.id;
  const fn = handlers.get(handlerKey);
  if (!fn) return result(step.id, 'failed', undefined, `No switch handler for "${handlerKey}"`, start);
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

/**
 * forEach step — iterates over an array returned by the main handler.
 * Options (from config):
 *   bodyHandler   — handler key run per item; receives `__forEachItem` and `__forEachIndex`
 *   maxConcurrency — 1 (default, serial with break support) or N (batched parallel)
 * A body handler that returns `{ __break: true }` stops iteration early.
 */
async function executeForEach(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const handlerKey = step.handler ?? step.id;
  const fn = handlers.get(handlerKey);
  if (!fn) return result(step.id, 'failed', undefined, `No forEach handler for "${handlerKey}"`, start);

  try {
    const items = await fn(state.variables, step.config);
    if (!Array.isArray(items)) {
      return result(step.id, 'completed', items, undefined, start);
    }

    const bodyHandlerKey = step.config?.['bodyHandler'] as string | undefined;
    if (!bodyHandlerKey) {
      return result(step.id, 'completed', { count: items.length, items }, undefined, start);
    }

    const bodyFn = handlers.get(bodyHandlerKey);
    if (!bodyFn) {
      return result(step.id, 'failed', undefined, `No forEach body handler for "${bodyHandlerKey}"`, start);
    }

    const maxConcurrency = Math.max(1, (step.config?.['maxConcurrency'] as number | undefined) ?? 1);
    const results: unknown[] = [];
    let broke = false;

    if (maxConcurrency === 1) {
      for (const item of items) {
        const r = await bodyFn(
          { ...state.variables, __forEachItem: item, __forEachIndex: results.length },
          step.config,
        );
        if (r !== null && typeof r === 'object' && (r as Record<string, unknown>)['__break'] === true) {
          broke = true;
          break;
        }
        results.push(r);
      }
    } else {
      for (let i = 0; i < items.length && !broke; i += maxConcurrency) {
        const batch = items.slice(i, i + maxConcurrency);
        const batchResults = await Promise.all(
          batch.map((item, batchIdx) =>
            bodyFn({ ...state.variables, __forEachItem: item, __forEachIndex: i + batchIdx }, step.config),
          ),
        );
        for (const r of batchResults) {
          if (r !== null && typeof r === 'object' && (r as Record<string, unknown>)['__break'] === true) {
            broke = true;
            break;
          }
          results.push(r);
        }
      }
    }

    return result(step.id, 'completed', { count: results.length, results, broke }, undefined, start);
  } catch (err) {
    return result(step.id, 'failed', undefined, String(err), start);
  }
}

/**
 * Fork step — fires N named branches concurrently via Promise.all.
 * `config.branches: Record<name, handlerKey>` — each branch handler receives
 * the current variables plus `__forkBranch` set to the branch name.
 * Output is `Record<name, result>`, stored as `__step_<forkId>` by advanceState.
 * A paired `join` step reads this variable to aggregate results.
 */
async function executeFork(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const branches = step.config?.['branches'] as Record<string, string> | undefined;
  if (!branches || Object.keys(branches).length === 0) {
    return result(step.id, 'failed', undefined, 'fork step requires config.branches: Record<branchName, handlerKey>', start);
  }
  try {
    const entries = Object.entries(branches);
    const branchResults = await Promise.all(
      entries.map(async ([branchName, handlerKey]) => {
        const fn = handlers.get(handlerKey);
        if (!fn) throw new Error(`No handler for fork branch "${branchName}" (handler: "${handlerKey}")`);
        const r = await fn({ ...state.variables, __forkBranch: branchName }, step.config);
        return [branchName, r] as [string, unknown];
      }),
    );
    return result(step.id, 'completed', Object.fromEntries(branchResults), undefined, start);
  } catch (err) {
    return result(step.id, 'failed', undefined, String(err), start);
  }
}

/**
 * Join step — aggregates results from a prior fork step.
 * `config.forkStepId: string` — the step ID of the matching fork step.
 * Reads `state.variables.__step_<forkStepId>` (populated by advanceState after fork).
 * Optional `config.branches: string[]` filters to specific branch names.
 */
async function executeJoin(step: WorkflowStep, state: WorkflowState, _handlers: StepHandlerMap): Promise<WorkflowStepResult> {
  const start = now();
  const forkStepId = step.config?.['forkStepId'] as string | undefined;
  if (!forkStepId) {
    return result(step.id, 'failed', undefined, 'join step requires config.forkStepId', start);
  }
  const forkOutput = state.variables[`__step_${forkStepId}`];
  if (forkOutput === undefined) {
    return result(step.id, 'failed', undefined, `join: no output found for fork step "${forkStepId}"`, start);
  }
  const branchFilter = step.config?.['branches'] as string[] | undefined;
  if (branchFilter && typeof forkOutput === 'object' && forkOutput !== null) {
    const filtered = Object.fromEntries(
      branchFilter.map(name => [name, (forkOutput as Record<string, unknown>)[name]]),
    );
    return result(step.id, 'completed', filtered, undefined, start);
  }
  return result(step.id, 'completed', forkOutput, undefined, start);
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

// ─── Phase W7 — Dynamic Graph ─────────────────────────────────

/**
 * Dynamic step executor — calls the registered handler and returns its output.
 * The engine inspects the output (a `DynamicExpansion` or
 * `{ __expansion: DynamicExpansion }`) and splices the generated sub-graph
 * into the run AFTER this executor returns. The executor itself is identical
 * in behaviour to `executeDeterministic`; the routing magic lives in the
 * engine's run loop, not here.
 */
async function executeDynamic(step: WorkflowStep, state: WorkflowState, handlers: StepHandlerMap): Promise<WorkflowStepResult> {
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
  'human-task': executeHumanTask,
  // Phase W1
  switch: executeSwitch,
  forEach: executeForEach,
  fork: executeFork,
  join: executeJoin,
  // ─── Phase W7 — Dynamic Graph ─────────────────────────────
  dynamic: executeDynamic,
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
