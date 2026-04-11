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
  WorkflowEvent,
  WorkflowPolicy,
  WorkflowEngine as IWorkflowEngine,
  EventBus,
} from '@weaveintel/core';
import { randomUUID } from 'node:crypto';
import { executeStep, type StepHandler, type StepHandlerMap } from './steps.js';
import { createInitialState, advanceState, resolveNextStep, isTerminal } from './state.js';
import { type CheckpointStore, InMemoryCheckpointStore } from './checkpoint-store.js';
import { type CompensationRegistry, DefaultCompensationRegistry, runCompensations, type CompensationHandler } from './compensation.js';

export interface WorkflowEngineOptions {
  checkpointStore?: CheckpointStore;
  bus?: EventBus;
  defaultPolicy?: WorkflowPolicy;
}

function now(): string { return new Date().toISOString(); }

export class DefaultWorkflowEngine implements IWorkflowEngine {
  private definitions = new Map<string, WorkflowDefinition>();
  private runs = new Map<string, WorkflowRun>();
  private handlers: StepHandlerMap = new Map();
  private checkpointStore: CheckpointStore;
  private compensationRegistry: CompensationRegistry;
  private bus?: EventBus;
  private defaultPolicy?: WorkflowPolicy;

  constructor(opts?: WorkflowEngineOptions) {
    this.checkpointStore = opts?.checkpointStore ?? new InMemoryCheckpointStore();
    this.bus = opts?.bus;
    this.defaultPolicy = opts?.defaultPolicy;
    this.compensationRegistry = new DefaultCompensationRegistry();
  }

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
    return this.definitions.get(id) ?? null;
  }

  async listDefinitions(): Promise<WorkflowDefinition[]> {
    return [...this.definitions.values()];
  }

  // ─── Run Management ────────────────────────────────────────

  async startRun(workflowId: string, input?: Record<string, unknown>): Promise<WorkflowRun> {
    const def = this.definitions.get(workflowId);
    if (!def) throw new Error(`Workflow definition not found: ${workflowId}`);

    const run: WorkflowRun = {
      id: randomUUID(),
      workflowId,
      status: 'running',
      state: createInitialState(def, input),
      startedAt: now(),
    };
    this.runs.set(run.id, run);
    this.emit({ type: 'workflow:started', runId: run.id, timestamp: now() });

    return this.executeRun(run, def);
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async resumeRun(runId: string, data?: unknown): Promise<WorkflowRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    if (run.status !== 'paused') throw new Error(`Run ${runId} is not paused (status: ${run.status})`);

    const def = this.definitions.get(run.workflowId);
    if (!def) throw new Error(`Workflow definition not found: ${run.workflowId}`);

    if (data !== undefined) {
      run.state.variables['__resumeData'] = data;
    }
    (run as { status: WorkflowRunStatus }).status = 'running';
    this.runs.set(run.id, run);

    // Advance to next step from the paused (wait) step
    const currentStep = def.steps.find(s => s.id === run.state.currentStepId);
    if (currentStep) {
      const nextId = typeof currentStep.next === 'string' ? currentStep.next
        : Array.isArray(currentStep.next) ? currentStep.next[0]
        : undefined;
      if (nextId) {
        (run.state as { currentStepId: string }).currentStepId = nextId;
      }
    }

    return this.executeRun(run, def);
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    (run as { status: WorkflowRunStatus }).status = 'cancelled';
    run.completedAt = now();
    this.runs.set(run.id, run);
    this.emit({ type: 'workflow:failed', runId, timestamp: now(), data: { reason: 'cancelled' } });
  }

  listRuns(workflowId?: string): WorkflowRun[] {
    const all = [...this.runs.values()];
    return workflowId ? all.filter(r => r.workflowId === workflowId) : all;
  }

  // ─── Core Loop ─────────────────────────────────────────────

  private async executeRun(run: WorkflowRun, def: WorkflowDefinition): Promise<WorkflowRun> {
    const policy = this.defaultPolicy ?? (def.metadata?.['policy'] as WorkflowPolicy | undefined);
    let stepsExecuted = 0;
    const maxSteps = policy?.maxSteps ?? 100;

    while (run.status === 'running') {
      const step = def.steps.find(s => s.id === run.state.currentStepId);
      if (!step) {
        this.failRun(run, `Step not found: ${run.state.currentStepId}`);
        break;
      }

      stepsExecuted++;
      if (stepsExecuted > maxSteps) {
        this.failRun(run, `Exceeded max steps (${maxSteps})`);
        break;
      }

      this.emit({ type: 'step:started', runId: run.id, stepId: step.id, timestamp: now() });

      const stepResult = await executeStep(step, run.state, this.handlers);

      if (stepResult.status === 'failed') {
        this.emit({ type: 'step:failed', runId: run.id, stepId: step.id, timestamp: now(), data: { error: stepResult.error } });

        // Retry logic
        if (step.retries && step.retries > 0) {
          let retries = step.retries;
          let retryResult = stepResult;
          while (retries > 0 && retryResult.status === 'failed') {
            retries--;
            retryResult = await executeStep(step, run.state, this.handlers);
          }
          if (retryResult.status === 'completed') {
            (run as { state: WorkflowState }).state = advanceState(run.state, retryResult, resolveNextStep(def, step.id, retryResult));
            this.emit({ type: 'step:completed', runId: run.id, stepId: step.id, timestamp: now() });
            await this.checkpointStore.save(run.id, step.id, run.state);
            if (isTerminal(def, run.state)) {
              this.completeRun(run);
            }
            continue;
          }
        }

        // Compensate
        await runCompensations(
          this.compensationRegistry,
          run.state.history.filter(h => h.status === 'completed'),
          run.state.variables,
        );

        this.failRun(run, stepResult.error ?? 'Step failed');
        break;
      }

      this.emit({ type: 'step:completed', runId: run.id, stepId: step.id, timestamp: now() });

      // Wait step => pause
      if (step.type === 'wait') {
        (run.state as { currentStepId: string }).currentStepId = step.id;
        run.state.history.push(stepResult);
        (run as { status: WorkflowRunStatus }).status = 'paused';
        this.runs.set(run.id, run);
        this.emit({ type: 'workflow:paused', runId: run.id, timestamp: now() });
        await this.checkpointStore.save(run.id, step.id, run.state);
        return run;
      }

      const nextStepId = resolveNextStep(def, step.id, stepResult);
      (run as { state: WorkflowState }).state = advanceState(run.state, stepResult, nextStepId);
      await this.checkpointStore.save(run.id, step.id, run.state);

      if (!nextStepId || isTerminal(def, run.state)) {
        this.completeRun(run);
      }
    }

    this.runs.set(run.id, run);
    return run;
  }

  private completeRun(run: WorkflowRun): void {
    (run as { status: WorkflowRunStatus }).status = 'completed';
    run.completedAt = now();
    this.emit({ type: 'workflow:completed', runId: run.id, timestamp: now() });
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
        data: event as unknown as Record<string, unknown>,
      });
    }
  }
}

export function createWorkflowEngine(opts?: WorkflowEngineOptions): DefaultWorkflowEngine {
  return new DefaultWorkflowEngine(opts);
}
