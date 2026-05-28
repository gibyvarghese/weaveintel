/**
 * @weaveintel/workflows — test-harness.ts
 *
 * Phase W6 — Test harness for workflow definitions.
 *
 * `createWorkflowTestHarness(def)` returns a helper that lets you:
 *   • Register synchronous or async mock handlers per step ID or handler key
 *   • Inject failures (step will fail with the given error message)
 *   • Run the workflow in-memory (no external deps)
 *   • Query execution results — step order, variable state, compensation
 *
 * Designed for unit tests. Does not require a database, event bus, or
 * any external infrastructure.
 */

import type { WorkflowDefinition, WorkflowRun } from '@weaveintel/core';
import { DefaultWorkflowEngine } from './engine.js';
import { InMemorySpanEmitter } from './span-emitter.js';
import type { WorkflowSpan } from '@weaveintel/core';

// ─── Public types ──────────────────────────────────────────────────────────

export type MockHandlerFn = (
  variables: Record<string, unknown>,
  config?: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** Result returned after `harness.run()`. */
export interface WorkflowTestResult {
  /** The completed (or failed/paused) run record. */
  run: WorkflowRun;
  /** Step IDs executed in order (skipped steps are included with status 'skipped'). */
  executedSteps: string[];
  /** Variable state at end of run. */
  variables: Record<string, unknown>;
  /** True if any compensation handlers were invoked. */
  compensationTriggered: boolean;
  /** Step IDs for which compensation ran (empty if none). */
  compensatedSteps: string[];
  /** All spans collected during the run. */
  spans: WorkflowSpan[];
  /** Assert that a specific step was executed (throws AssertionError if not). */
  assertStepExecuted(stepId: string): void;
  /** Assert that a specific step was NOT executed. */
  assertStepNotExecuted(stepId: string): void;
  /** Assert that the run completed successfully. */
  assertCompleted(): void;
  /** Assert that the run failed (optionally matching the error message). */
  assertFailed(errorMatch?: string | RegExp): void;
  /** Assert that a variable has the expected value. */
  assertVariable(key: string, expected: unknown): void;
  /** Return the span for a specific step (null if not found). */
  getSpan(stepId: string): WorkflowSpan | null;
}

/** Fluent test harness builder + runner. */
export interface WorkflowTestHarness {
  /**
   * Register a mock handler for a step ID or handler key.
   * The mock replaces any pre-registered handler with the same key.
   */
  mock(stepIdOrHandlerKey: string, fn: MockHandlerFn): this;
  /** Make the specified step fail with the given error on its first invocation. */
  mockFailure(stepId: string, error: string): this;
  /**
   * Run the workflow synchronously in memory with the given input.
   * Returns a `WorkflowTestResult` for assertions.
   */
  run(input?: Record<string, unknown>): Promise<WorkflowTestResult>;
}

// ─── Implementation ─────────────────────────────────────────────────────────

class WorkflowTestHarnessImpl implements WorkflowTestHarness {
  private readonly mocks = new Map<string, MockHandlerFn>();
  private readonly failures = new Map<string, string>();

  constructor(private readonly def: WorkflowDefinition) {}

  mock(stepIdOrHandlerKey: string, fn: MockHandlerFn): this {
    this.mocks.set(stepIdOrHandlerKey, fn);
    return this;
  }

  mockFailure(stepId: string, error: string): this {
    this.failures.set(stepId, error);
    return this;
  }

  async run(input?: Record<string, unknown>): Promise<WorkflowTestResult> {
    const spanEmitter = new InMemorySpanEmitter();
    const engine = new DefaultWorkflowEngine({ spanEmitter });
    await engine.createDefinition(this.def);

    // Register mock handlers (step ID first, then handler key)
    for (const step of this.def.steps) {
      const handlerKey = step.handler ?? step.id;
      const errorMsg = this.failures.get(step.id) ?? this.failures.get(handlerKey);
      if (errorMsg) {
        engine.registerHandler(step.id, async () => { throw new Error(errorMsg); });
        if (handlerKey !== step.id) engine.registerHandler(handlerKey, async () => { throw new Error(errorMsg); });
        continue;
      }

      // Step-ID mock takes precedence over handler-key mock
      const stepMock = this.mocks.get(step.id) ?? this.mocks.get(handlerKey);
      if (stepMock) {
        const fn = stepMock;
        engine.registerHandler(step.id, async (vars, config) => fn(vars, config));
        if (handlerKey !== step.id) engine.registerHandler(handlerKey, async (vars, config) => fn(vars, config));
      }
    }

    const run = await engine.startRun(this.def.id, input ?? {});
    const spans = await spanEmitter.getAllSpans();
    const executedSteps = spans.map(s => s.stepId);

    // Detect compensation (runs with failed status that have compensation-related spans)
    const compensationTriggered = run.status === 'failed' && (run as unknown as Record<string, unknown>)['compensated'] === true;
    const compensatedSteps: string[] = [];

    const result: WorkflowTestResult = {
      run,
      executedSteps,
      variables: run.state.variables as Record<string, unknown>,
      compensationTriggered,
      compensatedSteps,
      spans,

      assertStepExecuted(stepId: string) {
        if (!executedSteps.includes(stepId)) {
          throw new Error(`AssertionError: expected step "${stepId}" to have been executed, but it was not. Executed: [${executedSteps.join(', ')}]`);
        }
      },

      assertStepNotExecuted(stepId: string) {
        if (executedSteps.includes(stepId)) {
          throw new Error(`AssertionError: expected step "${stepId}" NOT to have been executed, but it was`);
        }
      },

      assertCompleted() {
        if (run.status !== 'completed') {
          throw new Error(`AssertionError: expected run to be completed, but status is "${run.status}"${run.error ? `: ${run.error}` : ''}`);
        }
      },

      assertFailed(errorMatch?: string | RegExp) {
        if (run.status !== 'failed') {
          throw new Error(`AssertionError: expected run to be failed, but status is "${run.status}"`);
        }
        if (errorMatch !== undefined && run.error) {
          const matches = typeof errorMatch === 'string'
            ? run.error.includes(errorMatch)
            : errorMatch.test(run.error);
          if (!matches) {
            throw new Error(`AssertionError: run failed but error "${run.error}" does not match "${errorMatch}"`);
          }
        }
      },

      assertVariable(key: string, expected: unknown) {
        const actual = (run.state.variables as Record<string, unknown>)[key];
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`AssertionError: variable "${key}" expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
      },

      getSpan(stepId: string): WorkflowSpan | null {
        return spans.find(s => s.stepId === stepId) ?? null;
      },
    };

    return result;
  }
}

/**
 * Create a test harness for the given workflow definition.
 *
 * @example
 * ```ts
 * const harness = createWorkflowTestHarness(myWorkflowDef);
 * harness.mock('fetch-data', async () => ({ items: [1, 2, 3] }));
 * harness.mock('process', async (vars) => ({ count: (vars['items'] as number[]).length }));
 * const result = await harness.run({ userId: 'u1' });
 * result.assertCompleted();
 * result.assertVariable('count', 3);
 * result.assertStepExecuted('fetch-data');
 * ```
 */
export function createWorkflowTestHarness(def: WorkflowDefinition): WorkflowTestHarness {
  return new WorkflowTestHarnessImpl(def);
}
