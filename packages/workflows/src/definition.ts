/**
 * @weaveintel/workflows — definition.ts
 * Fluent builder API for creating WorkflowDefinition objects
 */
import type { WorkflowDefinition, WorkflowStep, WorkflowStepType, WorkflowPolicy, WorkflowCompensation } from '@weaveintel/core';
import { randomUUID } from 'node:crypto';

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
    this.id = randomUUID();
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

  /** Shortcut: add a deterministic step. */
  deterministic(id: string, name: string, opts?: { handler?: string; next?: string | string[]; config?: Record<string, unknown> }): this {
    return this.addStep({ id, name, type: 'deterministic', handler: opts?.handler, next: opts?.next, config: opts?.config });
  }

  /** Shortcut: add an agentic step. */
  agentic(id: string, name: string, opts?: { handler?: string; next?: string | string[]; config?: Record<string, unknown>; timeout?: number }): this {
    return this.addStep({ id, name, type: 'agentic', handler: opts?.handler, next: opts?.next, config: opts?.config, timeout: opts?.timeout });
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
