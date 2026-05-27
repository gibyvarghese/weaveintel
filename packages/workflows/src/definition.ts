/**
 * @weaveintel/workflows — definition.ts
 * Fluent builder API for creating WorkflowDefinition objects
 */
import type { WorkflowDefinition, WorkflowStep, WorkflowStepType, WorkflowPolicy, WorkflowCompensation } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

export class WorkflowBuilder {
  private id: string;
  private name = 'Untitled Workflow';
  private version = '1.0.0';
  private description?: string;
  private steps: WorkflowStep[] = [];
  private entryStepId?: string;
  private metadata: Record<string, unknown> = {};
  private policyConfig?: WorkflowPolicy;
  private compensations: WorkflowCompensation[] = [];

  constructor(name?: string) {
    this.id = newUUIDv7();
    if (name) this.name = name;
  }

  setId(id: string): this { this.id = id; return this; }
  setName(name: string): this { this.name = name; return this; }
  setVersion(version: string): this { this.version = version; return this; }
  setDescription(desc: string): this { this.description = desc; return this; }
  setMetadata(meta: Record<string, unknown>): this { this.metadata = meta; return this; }
  setPolicy(policy: WorkflowPolicy): this { this.policyConfig = policy; return this; }

  addStep(step: WorkflowStep): this {
    this.steps.push(step);
    if (!this.entryStepId) this.entryStepId = step.id;
    return this;
  }

  setEntry(stepId: string): this {
    this.entryStepId = stepId;
    return this;
  }

  addCompensation(comp: WorkflowCompensation): this {
    this.compensations.push(comp);
    return this;
  }

  /** Shared retry + W3 data options across step shortcuts. */
  private static retryFields(opts: {
    timeout?: number;
    retries?: number;
    retryDelayMs?: number;
    retryBackoffMultiplier?: number;
    retryMaxDelayMs?: number;
    retryJitter?: boolean;
    globalTimeoutMs?: number;
    idempotencyKey?: unknown;
    fallbackHandler?: string;
    onError?: string;
    skipIf?: unknown;
    // Phase W3
    outputSchema?: Record<string, unknown>;
    outputSchemaAction?: 'warn' | 'fail' | 'coerce';
    maskFields?: string[];
    outputScope?: 'global' | 'step';
  }) {
    return {
      timeout: opts.timeout,
      retries: opts.retries,
      retryDelayMs: opts.retryDelayMs,
      retryBackoffMultiplier: opts.retryBackoffMultiplier,
      retryMaxDelayMs: opts.retryMaxDelayMs,
      retryJitter: opts.retryJitter,
      globalTimeoutMs: opts.globalTimeoutMs,
      idempotencyKey: opts.idempotencyKey,
      fallbackHandler: opts.fallbackHandler,
      onError: opts.onError,
      skipIf: opts.skipIf,
      outputSchema: opts.outputSchema,
      outputSchemaAction: opts.outputSchemaAction,
      maskFields: opts.maskFields,
      outputScope: opts.outputScope,
    };
  }

  /** Shortcut: add a deterministic step. */
  deterministic(
    id: string,
    name: string,
    opts?: {
      handler?: string;
      next?: string | string[];
      config?: Record<string, unknown>;
      timeout?: number;
      retries?: number;
      retryDelayMs?: number;
      retryBackoffMultiplier?: number;
      retryMaxDelayMs?: number;
      retryJitter?: boolean;
      globalTimeoutMs?: number;
      idempotencyKey?: unknown;
      fallbackHandler?: string;
      onError?: string;
      skipIf?: unknown;
      outputSchema?: Record<string, unknown>;
      outputSchemaAction?: 'warn' | 'fail' | 'coerce';
      maskFields?: string[];
      outputScope?: 'global' | 'step';
    },
  ): this {
    return this.addStep({
      id,
      name,
      type: 'deterministic',
      handler: opts?.handler,
      next: opts?.next,
      config: opts?.config,
      ...WorkflowBuilder.retryFields(opts ?? {}),
    });
  }

  /** Shortcut: add an agentic step. */
  agentic(
    id: string,
    name: string,
    opts?: {
      handler?: string;
      next?: string | string[];
      config?: Record<string, unknown>;
      timeout?: number;
      retries?: number;
      retryDelayMs?: number;
      retryBackoffMultiplier?: number;
      retryMaxDelayMs?: number;
      retryJitter?: boolean;
      globalTimeoutMs?: number;
      idempotencyKey?: unknown;
      fallbackHandler?: string;
      onError?: string;
      skipIf?: unknown;
      outputSchema?: Record<string, unknown>;
      outputSchemaAction?: 'warn' | 'fail' | 'coerce';
      maskFields?: string[];
      outputScope?: 'global' | 'step';
    },
  ): this {
    return this.addStep({
      id,
      name,
      type: 'agentic',
      handler: opts?.handler,
      next: opts?.next,
      config: opts?.config,
      ...WorkflowBuilder.retryFields(opts ?? {}),
    });
  }

  /** Shortcut: add a condition step. */
  condition(id: string, name: string, opts: { handler?: string; trueBranch: string; falseBranch: string }): this {
    return this.addStep({ id, name, type: 'condition', handler: opts.handler, next: [opts.trueBranch, opts.falseBranch] });
  }

  /** Shortcut: add a branch step. */
  branch(id: string, name: string, opts: { handler?: string; branches: string[] }): this {
    return this.addStep({ id, name, type: 'branch', handler: opts.handler, next: opts.branches });
  }

  /** Shortcut: add a wait step (pauses for approval or external input). */
  wait(id: string, name: string, opts?: { next?: string }): this {
    return this.addStep({ id, name, type: 'wait', next: opts?.next });
  }

  /** Shortcut: add a parallel step that executes named handlers concurrently. */
  parallel(
    id: string,
    name: string,
    opts: { parallelHandlers: string[]; next?: string },
  ): this {
    return this.addStep({
      id,
      name,
      type: 'parallel',
      next: opts.next,
      config: { parallelHandlers: opts.parallelHandlers },
    });
  }

  // ─── Phase W1 shortcuts ──────────────────────────────────────

  /** Shortcut: add a switch step. Handler returns a string case key; routing is driven by config.cases. */
  switch(
    id: string,
    name: string,
    opts: {
      handler?: string;
      cases: Record<string, string>;
      next?: string | string[];
      config?: Record<string, unknown>;
      onError?: string;
      skipIf?: unknown;
    },
  ): this {
    return this.addStep({
      id,
      name,
      type: 'switch',
      handler: opts.handler,
      next: opts.next,
      config: { ...opts.config, cases: opts.cases },
      onError: opts.onError,
      skipIf: opts.skipIf,
    });
  }

  /** Shortcut: add a forEach step. Handler returns an array; bodyHandler runs per item. */
  forEach(
    id: string,
    name: string,
    opts: {
      handler: string;
      bodyHandler?: string;
      maxConcurrency?: number;
      next?: string;
      config?: Record<string, unknown>;
      onError?: string;
      skipIf?: unknown;
    },
  ): this {
    return this.addStep({
      id,
      name,
      type: 'forEach',
      handler: opts.handler,
      next: opts.next,
      config: {
        ...opts.config,
        ...(opts.bodyHandler ? { bodyHandler: opts.bodyHandler } : {}),
        ...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
      },
      onError: opts.onError,
      skipIf: opts.skipIf,
    });
  }

  /** Shortcut: add a parallel step with named lanes. Results are keyed by lane name. */
  parallelLanes(
    id: string,
    name: string,
    opts: { lanes: Record<string, string>; next?: string; onError?: string },
  ): this {
    return this.addStep({
      id,
      name,
      type: 'parallel',
      next: opts.next,
      config: { lanes: opts.lanes },
      onError: opts.onError,
    });
  }

  /** Shortcut: add a fork step. Fires N named branch handlers concurrently. */
  fork(
    id: string,
    name: string,
    opts: { branches: Record<string, string>; next?: string; onError?: string },
  ): this {
    return this.addStep({
      id,
      name,
      type: 'fork',
      next: opts.next,
      config: { branches: opts.branches },
      onError: opts.onError,
    });
  }

  /** Shortcut: add a join step. Aggregates results from the matching fork step. */
  join(
    id: string,
    name: string,
    opts: { forkStepId: string; branches?: string[]; next?: string; onError?: string },
  ): this {
    return this.addStep({
      id,
      name,
      type: 'join',
      next: opts.next,
      config: {
        forkStepId: opts.forkStepId,
        ...(opts.branches ? { branches: opts.branches } : {}),
      },
      onError: opts.onError,
    });
  }

  /** Shortcut: add a human-task step that creates a task in the queue and pauses. */
  humanTask(
    id: string,
    name: string,
    opts?: {
      taskType?: string;
      title?: string;
      description?: string;
      priority?: string;
      next?: string;
    },
  ): this {
    return this.addStep({
      id,
      name,
      type: 'human-task',
      next: opts?.next,
      config: {
        taskType: opts?.taskType ?? 'approval',
        title: opts?.title ?? name,
        description: opts?.description,
        priority: opts?.priority ?? 'normal',
      },
    });
  }

  build(): WorkflowDefinition & { policy?: WorkflowPolicy; compensations?: WorkflowCompensation[] } {
    if (!this.entryStepId) throw new Error('Workflow must have at least one step');
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      steps: this.steps,
      entryStepId: this.entryStepId,
      metadata: {
        ...this.metadata,
        ...(this.policyConfig ? { policy: this.policyConfig } : {}),
        ...(this.compensations.length ? { compensations: this.compensations } : {}),
      },
      createdAt: new Date().toISOString(),
      policy: this.policyConfig,
      compensations: this.compensations,
    };
  }
}

export function defineWorkflow(name?: string): WorkflowBuilder {
  return new WorkflowBuilder(name);
}
