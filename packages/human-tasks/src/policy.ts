/**
 * @weaveintel/human-tasks — Policy engine
 *
 * Determines when human approval/review is required based on configurable policies.
 */

import type { HumanTaskPolicy, HumanTaskType, HumanTaskPriority } from '@weaveintel/core';
import { randomUUID } from 'node:crypto';

export interface PolicyCheckContext {
  trigger: string;
  riskLevel?: string;
  confidence?: number;
  estimatedImpact?: string;
  metadata?: Record<string, unknown>;
}

export interface PolicyCheckResult {
  required: boolean;
  policy?: HumanTaskPolicy;
  reason?: string;
}

/**
 * Create a HumanTaskPolicy.
 */
export function createPolicy(input: {
  name: string;
  description?: string;
  trigger: string;
  taskType: HumanTaskType;
  defaultPriority?: HumanTaskPriority;
  slaHours?: number;
  autoEscalateAfterHours?: number;
  assignmentStrategy?: HumanTaskPolicy['assignmentStrategy'];
  assignTo?: string;
  enabled?: boolean;
}): HumanTaskPolicy {
  return {
    id: randomUUID(),
    name: input.name,
    description: input.description,
    trigger: input.trigger,
    taskType: input.taskType,
    defaultPriority: input.defaultPriority ?? 'normal',
    slaHours: input.slaHours,
    autoEscalateAfterHours: input.autoEscalateAfterHours,
    assignmentStrategy: input.assignmentStrategy ?? 'round-robin',
    assignTo: input.assignTo,
    enabled: input.enabled !== false,
  };
}

/**
 * Policy evaluator — checks whether a given action/trigger matches any active policy.
 */
export class PolicyEvaluator {
  private readonly policies: HumanTaskPolicy[] = [];

  addPolicy(policy: HumanTaskPolicy): void {
    this.policies.push(policy);
  }

  removePolicy(policyId: string): boolean {
    const idx = this.policies.findIndex(p => p.id === policyId);
    if (idx === -1) return false;
    this.policies.splice(idx, 1);
    return true;
  }

  listPolicies(): HumanTaskPolicy[] {
    return [...this.policies];
  }

  /**
   * Check if the given context triggers any policy.
   * Returns the first matching enabled policy, or null.
   */
  check(ctx: PolicyCheckContext): PolicyCheckResult {
    for (const policy of this.policies) {
      if (!policy.enabled) continue;

      // Trigger match: exact or wildcard '*'
      if (policy.trigger !== '*' && policy.trigger !== ctx.trigger) continue;

      return {
        required: true,
        policy,
        reason: `Policy "${policy.name}" requires ${policy.taskType} for trigger "${ctx.trigger}"`,
      };
    }

    return { required: false };
  }

  /**
   * Compute the SLA deadline from a policy.
   */
  computeSlaDeadline(policy: HumanTaskPolicy, from?: Date): string | undefined {
    if (!policy.slaHours) return undefined;
    const start = from ?? new Date();
    return new Date(start.getTime() + policy.slaHours * 3600_000).toISOString();
  }
}
