/**
 * @weaveintel/workflows — engine.ts
 * WorkflowEngine — runs workflow definitions step-by-step
 */
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowState,
  WorkflowStepResult,
  WorkflowStep,
  WorkflowEvent,
  WorkflowPolicy,
  WorkflowEngine as IWorkflowEngine,
  EventBus,
  HumanTaskQueue,
  HumanTaskType,
  HumanTaskPriority,
  HumanDecision,
} from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import { executeStep, type StepHandler, type StepHandlerMap } from './steps.js';
import { createInitialState, advanceState, resolveNextStep, isTerminal } from './state.js';
import { type CheckpointStore, InMemoryCheckpointStore } from './checkpoint-store.js';
import { type CompensationRegistry, DefaultCompensationRegistry, runCompensations, type CompensationHandler } from './compensation.js';
import { type WorkflowRunRepository, InMemoryWorkflowRunRepository } from './run-repository.js';
import type { HandlerResolverRegistry } from './handler-resolver.js';
import type { WorkflowDefinitionStore } from './definition-store.js';
import { applyInputMap, applyOutputMap } from './path.js';
import { evaluateBoolean, evaluateExpression, hasExpression } from './expressions.js';
import { type ContractEmitter, buildEmittedContract } from './contract-emitter.js';
import { validateWorkflowInput, WorkflowInputValidationError } from './input-validator.js';
import { type CostMeter, InMemoryCostMeter } from './cost-meter.js';
import { type WorkflowEngineOptions } from './engine-types.js';
import { now, sleep, computeRetryDelay } from './engine-sleep.js';
import { resolveResumeNextId } from './engine-runner.js';
import { type StepIdempotencyStore } from './idempotency-store.js';
import { type CircuitBreakerRegistry } from './circuit-breaker.js';
import { type BulkheadRegistry } from './bulkhead.js';

export type { WorkflowEngineOptions } from './engine-types.js';

export class DefaultWorkflowEngine implements IWorkflowEngine {
  private definitions = new Map<string, WorkflowDefinition>();
  private runCache = new Map<string, WorkflowRun>();
  private handlers: StepHandlerMap = new Map();
  private checkpointStore: CheckpointStore;
  private runRepository: WorkflowRunRepository;
  private compensationRegistry: CompensationRegistry;
  private bus?: EventBus;
  private defaultPolicy?: WorkflowPolicy;
  private humanTaskQueue?: HumanTaskQueue;
  private resolverRegistry?: HandlerResolverRegistry;
  private resolverDeps?: Record<string, unknown>;
  private definitionStore?: WorkflowDefinitionStore;
  private contractEmitter?: ContractEmitter;
  private costMeter: CostMeter;
  // Phase W2
  private idempotencyStore?: StepIdempotencyStore;
  private circuitBreakerRegistry?: CircuitBreakerRegistry;
  private bulkheadRegistry?: BulkheadRegistry;

  constructor(opts?: WorkflowEngineOptions) {
    this.checkpointStore = opts?.checkpointStore ?? new InMemoryCheckpointStore();
    this.runRepository = opts?.runRepository ?? new InMemoryWorkflowRunRepository();
    this.bus = opts?.bus;
    this.defaultPolicy = opts?.defaultPolicy;
    this.compensationRegistry = new DefaultCompensationRegistry();
    this.humanTaskQueue = opts?.humanTaskQueue;
    this.resolverRegistry = opts?.resolverRegistry;
    this.resolverDeps = opts?.resolverDeps;
    this.definitionStore = opts?.definitionStore;
    this.contractEmitter = opts?.contractEmitter;
    this.costMeter = opts?.costMeter ?? new InMemoryCostMeter();
    this.idempotencyStore = opts?.idempotencyStore;
    this.circuitBreakerRegistry = opts?.circuitBreakerRegistry;
    this.bulkheadRegistry = opts?.bulkheadRegistry;
  }

  /** Phase 5 — Public access to the cost meter so callers (LLM adapters,
   * tool wrappers, sub-workflows) can report cost deltas keyed by runId. */
  getCostMeter(): CostMeter { return this.costMeter; }
  /** Phase W2 — Access the idempotency store (if configured). */
  getIdempotencyStore(): StepIdempotencyStore | undefined { return this.idempotencyStore; }
  /** Phase W2 — Access the circuit breaker registry (if configured). */
  getCircuitBreakerRegistry(): CircuitBreakerRegistry | undefined { return this.circuitBreakerRegistry; }
  /** Phase W2 — Access the bulkhead registry (if configured). */
  getBulkheadRegistry(): BulkheadRegistry | undefined { return this.bulkheadRegistry; }

  // ─── Handler Registration ──────────────────────────────────

  registerHandler(name: string, handler: StepHandler): void {
    this.handlers.set(name, handler);
  }

  registerCompensation(stepId: string, handlerName: string, handler: CompensationHandler, description?: string): void {
    this.compensationRegistry.register({ stepId, handler: handlerName, description }, handler);
  }

  // ─── Definition CRUD ───────────────────────────────────────

  async createDefinition(def: WorkflowDefinition): Promise<WorkflowDefinition> {
    const saved = { ...def, createdAt: def.createdAt ?? now(), updatedAt: now() };
    this.definitions.set(saved.id, saved);
    return saved;
  }

  async getDefinition(id: string): Promise<WorkflowDefinition | null> {
    const cached = this.definitions.get(id);
    if (cached) return cached;
    if (this.definitionStore) {
      const fromStore = await this.definitionStore.get(id);
      if (fromStore) {
        this.definitions.set(fromStore.id, fromStore);
        return fromStore;
      }
    }
    return null;
  }

  async listDefinitions(): Promise<WorkflowDefinition[]> {
    if (!this.definitionStore) return [...this.definitions.values()];
    const stored = await this.definitionStore.list();
    // Merge in-memory + store; in-memory wins on id collision.
    const out = new Map<string, WorkflowDefinition>();
    for (const d of stored) out.set(d.id, d);
    for (const d of this.definitions.values()) out.set(d.id, d);
    return [...out.values()];
  }

  // ─── Run Management ────────────────────────────────────────

  async startRun(workflowId: string, input?: Record<string, unknown>): Promise<WorkflowRun> {
    let def = this.definitions.get(workflowId);
    if (!def && this.definitionStore) {
      const fromStore = await this.definitionStore.get(workflowId);
      if (fromStore) {
        this.definitions.set(fromStore.id, fromStore);
        def = fromStore;
      }
    }
    if (!def) throw new Error(`Workflow definition not found: ${workflowId}`);

    // Phase 5 — input schema gate. Reject malformed inputs BEFORE creating
    // a run row, so callers get a synchronous validation error rather than
    // a half-created failed run.
    if (def.inputSchema) {
      const result = validateWorkflowInput(input ?? {}, def.inputSchema);
      if (!result.valid) {
        throw new WorkflowInputValidationError(workflowId, result.errors);
      }
    }

    const run: WorkflowRun = {
      id: newUUIDv7(),
      workflowId,
      status: 'running',
      state: createInitialState(def, input),
      startedAt: now(),
      costTotal: 0,
    };
    await this.runRepository.save(run);
    this.runCache.set(run.id, run);
    this.emit({ type: 'workflow:started', runId: run.id, timestamp: now() });

    return this.executeRun(run, def);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    const cached = this.runCache.get(runId);
    if (cached) return cached;
    const run = await this.runRepository.get(runId);
    if (run) this.runCache.set(run.id, run);
    return run;
  }

  async resumeRun(runId: string, data?: unknown): Promise<WorkflowRun> {
    const run = await this.runRepository.get(runId);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    if (run.status !== 'paused') throw new Error(`Run ${runId} is not paused (status: ${run.status})`);

    const def = this.definitions.get(run.workflowId);
    if (!def) throw new Error(`Workflow definition not found: ${run.workflowId}`);

    if (data !== undefined) {
      run.state.variables['__resumeData'] = data;
    }
    (run as { status: WorkflowRunStatus }).status = 'running';
    await this.runRepository.save(run);
    this.runCache.set(run.id, run);

    // Advance to the correct next step, respecting branch selectors in resume data.
    const currentStep = def.steps.find(s => s.id === run.state.currentStepId);
    if (currentStep) {
      const nextId = resolveResumeNextId(currentStep, data);
      if (nextId) {
        (run.state as { currentStepId: string }).currentStepId = nextId;
      }
    }

    return this.executeRun(run, def);
  }

  async cancelRun(runId: string): Promise<void> {
    const run = await this.runRepository.get(runId);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    (run as { status: WorkflowRunStatus }).status = 'cancelled';
    run.completedAt = now();
    await this.runRepository.save(run);
    this.runCache.set(run.id, run);
    this.emit({ type: 'workflow:failed', runId, timestamp: now(), data: { reason: 'cancelled' } });
  }

  listRuns(workflowId?: string): WorkflowRun[] {
    const all = [...this.runCache.values()];
    return workflowId ? all.filter(r => r.workflowId === workflowId) : all;
  }

  // ─── Core Loop ─────────────────────────────────────────────

  /**
   * Build a per-run handler map by merging the engine's globally registered
   * handlers with handlers produced on-demand by the resolver registry for
   * any step whose `handler` references a kind:ref pair (or matches a bare-
   * kind resolver such as `'noop'`). Pre-registered handlers always win.
   *
   * Also resolves embedded handler refs from composite step configs:
   *   fork     — config.branches values
   *   parallel — config.lanes values + config.parallelHandlers items
   *   forEach  — config.bodyHandler
   */
  private async resolveHandlersForRun(def: WorkflowDefinition): Promise<StepHandlerMap> {
    const map: StepHandlerMap = new Map(this.handlers);
    if (!this.resolverRegistry) return map;

    // Collect all handler refs to resolve, including embedded refs inside config.
    const toResolve: Array<{ handlerRef: string; stepId: string; step: WorkflowStep }> = [];
    for (const step of def.steps) {
      toResolve.push({ handlerRef: step.handler ?? step.id, stepId: step.id, step });
      if (step.type === 'fork') {
        const branches = step.config?.['branches'] as Record<string, string> | undefined;
        if (branches) {
          for (const hRef of Object.values(branches)) {
            toResolve.push({ handlerRef: hRef, stepId: step.id, step });
          }
        }
      } else if (step.type === 'parallel') {
        const lanes = step.config?.['lanes'] as Record<string, string> | undefined;
        if (lanes) {
          for (const hRef of Object.values(lanes)) {
            toResolve.push({ handlerRef: hRef, stepId: step.id, step });
          }
        }
        const phList = step.config?.['parallelHandlers'] as string[] | undefined;
        if (phList) {
          for (const hRef of phList) toResolve.push({ handlerRef: hRef, stepId: step.id, step });
        }
      } else if (step.type === 'forEach') {
        const bh = step.config?.['bodyHandler'] as string | undefined;
        if (bh) toResolve.push({ handlerRef: bh, stepId: step.id, step });
      }
    }

    const seen = new Set<string>();
    for (const { handlerRef, stepId, step } of toResolve) {
      if (seen.has(handlerRef)) continue;
      seen.add(handlerRef);
      if (map.has(handlerRef)) continue;
      const match = this.resolverRegistry.forHandler(handlerRef);
      if (!match) continue;
      try {
        let fn = await match.resolver.resolve({
          workflowId: def.id,
          stepId,
          ref: match.ref,
          config: step.config ?? {},
          deps: this.resolverDeps,
          step,
        });

        // Phase W2 — wrap with circuit breaker (per resolver kind)
        const cb = this.circuitBreakerRegistry?.get(match.resolver.kind);
        if (cb) {
          const inner = fn;
          fn = async (vars, config) => {
            if (!cb.canExecute()) {
              const stats = cb.getStats();
              throw new Error(
                `Circuit breaker OPEN for handler kind "${match.resolver.kind}"` +
                ` (failures: ${stats.failures}, opened: ${stats.openedAt ? new Date(stats.openedAt).toISOString() : 'unknown'})`,
              );
            }
            try {
              const result = await inner(vars, config);
              cb.recordSuccess();
              return result;
            } catch (err) {
              cb.recordFailure();
              throw err;
            }
          };
        }

        // Phase W2 — wrap with bulkhead (per resolver kind)
        const bulkhead = this.bulkheadRegistry?.get(match.resolver.kind);
        if (bulkhead) {
          const wrapped = fn;
          fn = (vars, config) => bulkhead.execute(() => wrapped(vars, config));
        }

        map.set(handlerRef, fn);
      } catch (err) {
        // Make the failure visible at run-time rather than aborting startRun.
        const error = err instanceof Error ? err.message : String(err);
        map.set(handlerRef, async () => {
          throw new Error(`HandlerResolver failed for step "${stepId}" (${handlerRef}): ${error}`);
        });
      }
    }
    return map;
  }

  /** Apply inputMap before calling the resolved handler and outputMap after. */
  private wrapHandlerWithIO(step: WorkflowStep, fn: StepHandler): StepHandler {
    if (!step.inputMap && !step.outputMap) return fn;
    const inputMap = step.inputMap;
    const outputMap = step.outputMap;
    return async (variables, config) => {
      const args = inputMap ? applyInputMap(inputMap, variables) : variables;
      const out = await fn(args, config);
      if (outputMap) applyOutputMap(outputMap, out, variables);
      return out;
    };
  }

  /**
   * Wrap any handler (including pre-registered ones) with IO mapping if the
   * step declares it. We rebuild the per-step entry inside the run-scoped
   * map so global handlers are not mutated.
   */
  private applyIOMappingForRun(def: WorkflowDefinition, runHandlers: StepHandlerMap): void {
    for (const step of def.steps) {
      if (!step.inputMap && !step.outputMap) continue;
      const handlerRef = step.handler ?? step.id;
      const fn = runHandlers.get(handlerRef);
      if (!fn) continue;
      runHandlers.set(handlerRef, this.wrapHandlerWithIO(step, fn));
    }
  }

  /**
   * Phase 1 \u2014 Run a single iteration of an existing run. Useful for
   * scheduler-driven tick loops. Returns the run after one step (or after
   * the run reaches a terminal/paused state).
   */
  async tickRun(runId: string): Promise<WorkflowRun> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    if (run.status !== 'running') return run;
    const def = await this.getDefinition(run.workflowId);
    if (!def) throw new Error(`Workflow definition not found: ${run.workflowId}`);
    const handlers = await this.resolveHandlersForRun(def);
    this.applyIOMappingForRun(def, handlers);
    return this.executeRun(run, def, { handlers, maxStepsOverride: 1 });
  }

  private async executeRun(
    run: WorkflowRun,
    def: WorkflowDefinition,
    opts?: { handlers?: StepHandlerMap; maxStepsOverride?: number },
  ): Promise<WorkflowRun> {
    const policy = this.defaultPolicy ?? (def.metadata?.['policy'] as WorkflowPolicy | undefined);
    let stepsExecuted = 0;
    const maxSteps = opts?.maxStepsOverride ?? policy?.maxSteps ?? 100;
    let runHandlers = opts?.handlers;
    if (!runHandlers) {
      runHandlers = await this.resolveHandlersForRun(def);
      this.applyIOMappingForRun(def, runHandlers);
    }

    while (run.status === 'running') {
      const step = def.steps.find(s => s.id === run.state.currentStepId);
      if (!step) {
        this.failRun(run, `Step not found: ${run.state.currentStepId}`);
        break;
      }

      stepsExecuted++;
      if (stepsExecuted > maxSteps) {
        if (opts?.maxStepsOverride !== undefined) break; // tickRun: stop without failure
        this.failRun(run, `Exceeded max steps (${maxSteps})`);
        break;
      }

      // Phase W1 — skipIf: evaluate expression; if truthy, skip step and advance.
      if (step.skipIf !== undefined) {
        let shouldSkip = false;
        try { shouldSkip = evaluateBoolean(step.skipIf, run.state.variables); } catch { /* treat as false */ }
        if (shouldSkip) {
          const skippedResult: WorkflowStepResult = {
            stepId: step.id, status: 'skipped', startedAt: now(), completedAt: now(),
          };
          this.emit({ type: 'step:completed', runId: run.id, stepId: step.id, timestamp: now() });
          const nextStepId = resolveNextStep(def, step.id, skippedResult);
          (run as { state: WorkflowState }).state = advanceState(run.state, skippedResult, nextStepId);
          await this.checkpointStore.save(run.id, step.id, run.state, run.workflowId);
          if (!nextStepId || isTerminal(def, run.state)) { await this.completeRun(run, def); }
          continue;
        }
      }

      // Phase W2 — idempotency: check cache before executing; replay if hit.
      if (step.idempotencyKey !== undefined && this.idempotencyStore) {
        const keyVal = String(evaluateExpression(step.idempotencyKey, run.state.variables) ?? '');
        const iKey = `${step.id}:${keyVal}`;
        const cached = await this.idempotencyStore.get(iKey);
        if (cached !== undefined) {
          const cachedResult: WorkflowStepResult = {
            stepId: step.id, status: 'completed', output: cached,
            startedAt: now(), completedAt: now(),
          };
          this.emit({ type: 'step:completed', runId: run.id, stepId: step.id, timestamp: now() });
          const nextId = resolveNextStep(def, step.id, cachedResult);
          (run as { state: WorkflowState }).state = advanceState(run.state, cachedResult, nextId);
          await this.checkpointStore.save(run.id, step.id, run.state, run.workflowId);
          if (!nextId || isTerminal(def, run.state)) await this.completeRun(run, def);
          continue;
        }
      }

      this.emit({ type: 'step:started', runId: run.id, stepId: step.id, timestamp: now() });

      const stepResult = await this.executeStepWithExpressionFallback(step, run.state, runHandlers);

      if (stepResult.status === 'failed') {
        this.emit({ type: 'step:failed', runId: run.id, stepId: step.id, timestamp: now(), data: { error: stepResult.error } });

        // Track the last failed result so onError / fallback receives the terminal error.
        let finalFailedResult = stepResult;

        // Phase W2 — retry with exponential backoff + global timeout budget
        if (step.retries && step.retries > 0) {
          const globalDeadline = step.globalTimeoutMs ? Date.now() + step.globalTimeoutMs : undefined;
          const multiplier  = step.retryBackoffMultiplier ?? 2;
          const maxDelay    = step.retryMaxDelayMs ?? 30_000;
          const jitter      = step.retryJitter ?? false;

          let retries = step.retries;
          let retryResult: WorkflowStepResult = stepResult;
          let retryAttempt = 0;

          while (retries > 0 && retryResult.status === 'failed') {
            // Check global timeout budget before sleeping or retrying
            if (globalDeadline !== undefined && Date.now() >= globalDeadline) {
              retryResult = {
                stepId: step.id,
                status: 'failed',
                error: `Retry budget exhausted: ${step.globalTimeoutMs}ms global timeout exceeded after ${retryAttempt} retries`,
                startedAt: now(),
                completedAt: now(),
              };
              break;
            }

            retries--;
            retryAttempt++;

            const baseDelay = step.retryDelayMs ?? 0;
            if (baseDelay > 0) {
              const delay = computeRetryDelay(retryAttempt, baseDelay, multiplier, maxDelay, jitter);
              const sleepMs = globalDeadline
                ? Math.min(delay, Math.max(0, globalDeadline - Date.now()))
                : delay;
              if (sleepMs > 0) await sleep(sleepMs);
            }

            // Re-check deadline after sleeping
            if (globalDeadline !== undefined && Date.now() >= globalDeadline) {
              retryResult = {
                stepId: step.id,
                status: 'failed',
                error: `Retry budget exhausted: ${step.globalTimeoutMs}ms global timeout exceeded after ${retryAttempt} retries`,
                startedAt: now(),
                completedAt: now(),
              };
              break;
            }

            retryResult = await this.executeStepWithExpressionFallback(step, run.state, runHandlers);
          }

          if (retryResult.status === 'completed') {
            // Cache idempotency key for retry-succeeded result
            if (step.idempotencyKey !== undefined && this.idempotencyStore) {
              const kv = String(evaluateExpression(step.idempotencyKey, run.state.variables) ?? '');
              try { await this.idempotencyStore.set(`${step.id}:${kv}`, retryResult.output); } catch { /* best-effort */ }
            }
            (run as { state: WorkflowState }).state = advanceState(run.state, retryResult, resolveNextStep(def, step.id, retryResult));
            this.emit({ type: 'step:completed', runId: run.id, stepId: step.id, timestamp: now() });
            await this.checkpointStore.save(run.id, step.id, run.state, run.workflowId);
            if (isTerminal(def, run.state)) await this.completeRun(run, def);
            continue;
          }
          finalFailedResult = retryResult;
        }

        // Phase W2 — fallback handler: run alternative instead of compensation.
        if (step.fallbackHandler) {
          const fallbackFn = runHandlers.get(step.fallbackHandler);
          if (fallbackFn) {
            try {
              const fbStart = now();
              const fbOutput = await fallbackFn(
                { ...run.state.variables, __failedError: finalFailedResult.error ?? 'Step failed' },
                step.config,
              );
              const fallbackResult: WorkflowStepResult = {
                stepId: step.id, status: 'completed', output: fbOutput,
                startedAt: fbStart, completedAt: now(),
              };
              if (step.idempotencyKey !== undefined && this.idempotencyStore) {
                const kv = String(evaluateExpression(step.idempotencyKey, run.state.variables) ?? '');
                try { await this.idempotencyStore.set(`${step.id}:${kv}`, fbOutput); } catch { /* best-effort */ }
              }
              this.emit({ type: 'step:completed', runId: run.id, stepId: step.id, timestamp: now() });
              const nextId = resolveNextStep(def, step.id, fallbackResult);
              (run as { state: WorkflowState }).state = advanceState(run.state, fallbackResult, nextId);
              await this.checkpointStore.save(run.id, step.id, run.state, run.workflowId);
              if (isTerminal(def, run.state)) await this.completeRun(run, def);
              continue;
            } catch { /* fallback also failed — fall through to onError/compensation */ }
          }
        }

        // Phase W1 — onError: error boundary — jump to handler step instead of compensation.
        if (step.onError) {
          run.state.variables['__error'] = {
            message: finalFailedResult.error ?? 'Step failed',
            stepId: step.id,
            timestamp: now(),
          };
          (run as { state: WorkflowState }).state = advanceState(run.state, finalFailedResult, step.onError);
          await this.checkpointStore.save(run.id, step.id, run.state, run.workflowId);
          continue;
        }

        // Compensate — run in reverse completion order; record errors but still reach terminal state
        const { errors: compErrors } = await runCompensations(
          this.compensationRegistry,
          run.state.history.filter(h => h.status === 'completed'),
          run.state.variables,
        );

        const errorMsg = finalFailedResult.error ?? 'Step failed';
        const fullError = compErrors.length
          ? `${errorMsg}; compensation errors: ${compErrors.map(e => `${e.stepId}: ${e.error}`).join(', ')}`
          : errorMsg;
        this.failRun(run, fullError);
        break;
      }

      this.emit({ type: 'step:completed', runId: run.id, stepId: step.id, timestamp: now() });

      // Phase W2 — idempotency: cache successful output (first-time execution path)
      if (step.idempotencyKey !== undefined && this.idempotencyStore) {
        const kv = String(evaluateExpression(step.idempotencyKey, run.state.variables) ?? '');
        try { await this.idempotencyStore.set(`${step.id}:${kv}`, stepResult.output); } catch { /* best-effort */ }
      }

      // Phase 5 — cost ceiling check at step boundary (after success, before
      // advancing). Callers report deltas via this.costMeter.record(runId, …);
      // we read the cumulative total and compare against policy.costCeiling.
      if (policy?.costCeiling !== undefined && policy.costCeiling > 0) {
        const total = await Promise.resolve(this.costMeter.total(run.id));
        run.costTotal = total;
        if (total > policy.costCeiling) {
          this.emit({
            type: 'workflow:cost_exceeded',
            runId: run.id,
            stepId: step.id,
            timestamp: now(),
            data: { costTotal: total, ceiling: policy.costCeiling },
          });
          this.failRun(run, `Cost ceiling exceeded: $${total.toFixed(4)} > $${policy.costCeiling.toFixed(4)}`);
          break;
        }
      }

      // human-task step => create task in queue and pause
      if (step.type === 'human-task' &&
          stepResult.output !== null && typeof stepResult.output === 'object' &&
          (stepResult.output as Record<string, unknown>)['humanTaskRequired']) {
        if (this.humanTaskQueue) {
          const cfg = step.config ?? {};
          const task = await this.humanTaskQueue.enqueue({
            type: (cfg['taskType'] as HumanTaskType) ?? 'approval',
            title: (cfg['title'] as string) ?? step.name,
            description: cfg['description'] as string | undefined,
            priority: (cfg['priority'] as HumanTaskPriority) ?? 'normal',
            data: cfg['data'] ?? run.state.variables,
            workflowRunId: run.id,
            workflowStepId: step.id,
            status: 'pending',
          });
          run.state.variables['__humanTaskId'] = task.id;
          run.state.variables['__humanTaskStepId'] = step.id;
        }
        (run.state as { currentStepId: string }).currentStepId = step.id;
        run.state.history.push(stepResult);
        (run as { status: WorkflowRunStatus }).status = 'paused';
        await this.runRepository.save(run);
        this.runCache.set(run.id, run);
        this.emit({ type: 'workflow:paused', runId: run.id, timestamp: now() });
        await this.checkpointStore.save(run.id, step.id, run.state, run.workflowId);
        return run;
      }

      // wait step => pause
      if (step.type === 'wait') {
        (run.state as { currentStepId: string }).currentStepId = step.id;
        run.state.history.push(stepResult);
        (run as { status: WorkflowRunStatus }).status = 'paused';
        await this.runRepository.save(run);
        this.runCache.set(run.id, run);
        this.emit({ type: 'workflow:paused', runId: run.id, timestamp: now() });
        await this.checkpointStore.save(run.id, step.id, run.state, run.workflowId);
        return run;
      }

      const nextStepId = resolveNextStep(def, step.id, stepResult);
      (run as { state: WorkflowState }).state = advanceState(run.state, stepResult, nextStepId);
      await this.checkpointStore.save(run.id, step.id, run.state, run.workflowId);

      if (!nextStepId || isTerminal(def, run.state)) {
        await this.completeRun(run, def);
      }
    }

    await this.runRepository.save(run);
    this.runCache.set(run.id, run);
    return run;
  }

  // ─── Recovery ──────────────────────────────────────────────

  /**
   * Recover a run after process restart from the latest checkpoint.
   * The workflow definition must be registered before calling this method.
   * Returns null if no checkpoint is found for the given runId.
   *
   * NOTE: Recovery resumes execution from the checkpointed step, which means
   * that step will be re-executed (at-least-once semantics). Steps with
   * side effects should be idempotent.
   */
  async recoverRun(runId: string): Promise<WorkflowRun | null> {
    // Already in memory
    const cached = this.runCache.get(runId);
    if (cached) return cached;

    const existing = await this.runRepository.get(runId);
    if (existing) {
      this.runCache.set(existing.id, existing);
      return existing;
    }

    const cp = await this.checkpointStore.latest(runId);
    if (!cp) return null;

    const workflowId = cp.workflowId;
    if (!workflowId) return null;

    const def = this.definitions.get(workflowId);
    if (!def) return null;

    const run: WorkflowRun = {
      id: runId,
      workflowId,
      status: 'running',
      state: structuredClone(cp.state),
      startedAt: cp.createdAt,
    };
    await this.runRepository.save(run);
    this.runCache.set(run.id, run);
    this.emit({ type: 'workflow:started', runId: run.id, timestamp: now() });

    return this.executeRun(run, def);
  }

  /**
   * Complete a human task and resume the linked workflow run.
   * Requires humanTaskQueue to be configured.
   */
  async completeHumanTask(taskId: string, decision: HumanDecision): Promise<WorkflowRun | null> {
    if (!this.humanTaskQueue) throw new Error('No human task queue configured on this engine');
    await this.humanTaskQueue.complete(taskId, decision);
    const task = await this.humanTaskQueue.get(taskId);
    if (!task?.workflowRunId) return null;
    return this.resumeRun(task.workflowRunId, { decision: decision.decision, data: decision.data });
  }

  /**
   * Reject a human task and resume the linked workflow run with the rejection.
   * Requires humanTaskQueue to be configured.
   */
  async rejectHumanTask(taskId: string, decision: HumanDecision): Promise<WorkflowRun | null> {
    if (!this.humanTaskQueue) throw new Error('No human task queue configured on this engine');
    await this.humanTaskQueue.reject(taskId, decision);
    const task = await this.humanTaskQueue.get(taskId);
    if (!task?.workflowRunId) return null;
    return this.resumeRun(task.workflowRunId, { decision: 'rejected', data: decision.data });
  }

  /**
   * Phase 1 — For `condition` and `branch` steps, if the step's
   * `config.expression` is set, evaluate it directly against
   * `state.variables` and return the boolean/value as the step output.
   * Otherwise fall back to the registered handler executor. This keeps
   * apps from having to register one tiny handler per branching decision.
   */
  private async executeStepWithExpressionFallback(
    step: WorkflowStep,
    state: WorkflowState,
    handlers: StepHandlerMap,
  ): Promise<WorkflowStepResult> {
    if ((step.type === 'condition' || step.type === 'branch') && hasExpression(step.config)) {
      const start = now();
      try {
        const expr = (step.config as Record<string, unknown>)['expression'];
        const value =
          step.type === 'condition'
            ? evaluateBoolean(expr, state.variables)
            : (await import('./expressions.js')).evaluateExpression(expr, state.variables);
        return {
          stepId: step.id,
          status: 'completed',
          output: value,
          startedAt: start,
          completedAt: now(),
        };
      } catch (err) {
        return {
          stepId: step.id,
          status: 'failed',
          error: String(err),
          startedAt: start,
          completedAt: now(),
        };
      }
    }
    return executeStep(step, state, handlers);
  }

  private async completeRun(run: WorkflowRun, def: WorkflowDefinition): Promise<void> {
    (run as { status: WorkflowRunStatus }).status = 'completed';
    run.completedAt = now();
    // Phase 5 — capture final cost total before persisting.
    run.costTotal = await Promise.resolve(this.costMeter.total(run.id));
    this.emit({ type: 'workflow:completed', runId: run.id, timestamp: now() });
    // Phase 4 — emit typed mesh contract if declared. Failures are swallowed.
    if (this.contractEmitter && def.outputContract) {
      try {
        const contract = buildEmittedContract(def, run);
        if (contract) {
          await this.contractEmitter.emit(contract);
          this.emit({
            type: 'workflow:contract_emitted',
            runId: run.id,
            timestamp: now(),
            data: { kind: contract.kind, meshId: contract.meta.meshId },
          });
        }
      } catch (err) {
        // Best-effort: log via bus, never fail the run.
        if (this.bus) {
          this.bus.emit({
            type: 'workflow:contract_emit_failed',
            timestamp: Date.now(),
            data: { runId: run.id, error: err instanceof Error ? err.message : String(err) },
          });
        }
      }
    }
  }

  private failRun(run: WorkflowRun, error: string): void {
    (run as { status: WorkflowRunStatus }).status = 'failed';
    (run as { error?: string }).error = error;
    run.completedAt = now();
    this.emit({ type: 'workflow:failed', runId: run.id, timestamp: now(), data: { error } });
  }

  private emit(event: WorkflowEvent): void {
    if (this.bus) {
      this.bus.emit({
        type: event.type,
        timestamp: Date.now(),
        data: { type: event.type, runId: event.runId, stepId: event.stepId, timestamp: event.timestamp, data: event.data },
      });
    }
  }
}

export function createWorkflowEngine(opts?: WorkflowEngineOptions): DefaultWorkflowEngine {
  return new DefaultWorkflowEngine(opts);
}
