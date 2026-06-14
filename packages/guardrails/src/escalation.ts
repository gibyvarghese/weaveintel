/**
 * @weaveintel/guardrails — escalation.ts  (W4)
 *
 * Warn → action escalation. Evaluates accumulated guardrail results against
 * operator-defined escalation policies and either blocks the turn or triggers
 * a human-approval task via a caller-provided handler.
 *
 * Design: the task handler is a callback so this module has NO hard dependency
 * on `@weaveintel/human-tasks`. geneWeave's chat pipeline can supply a handler
 * that calls `createApprovalTask`; standalone consumers can wire their own.
 *
 * Usage:
 *   const esc = await evaluateEscalation(pipelineResults, policies, ctx, handler);
 *   if (esc.escalated && esc.decision !== 'allow') {
 *     // block or hold pending approval
 *   }
 */
import type { EscalationPolicy, EscalationResult, GuardrailDecision, GuardrailResult, RiskLevel } from '@weaveintel/core';

export type { EscalationPolicy, EscalationResult };

export interface EscalationContext {
  /** The action/turn being evaluated (for logging / task metadata). */
  readonly action?: string;
  /** All guardrail results from the pipeline run. */
  readonly results: readonly GuardrailResult[];
}

export type EscalationTaskHandler = (
  policy: EscalationPolicy,
  ctx: EscalationContext,
) => Promise<{ taskId: string }>;

function countWarnsByCategory(results: readonly GuardrailResult[], categories?: readonly string[]): number {
  return results.filter(r => {
    if (r.decision !== 'warn') return false;
    if (!categories?.length) return true;
    const cat = typeof r.metadata?.['category'] === 'string' ? r.metadata['category'] : '';
    return categories.includes(cat);
  }).length;
}

function hasRiskLevel(results: readonly GuardrailResult[], levels: readonly RiskLevel[]): boolean {
  return results.some(r => {
    const rl = r.metadata?.['riskLevel'];
    return typeof rl === 'string' && levels.includes(rl as RiskLevel);
  });
}

/**
 * Evaluate escalation policies against a set of guardrail results.
 *
 * Returns the first policy that fires (highest-priority first if sorted by
 * caller). When `handler` is provided, calls it to create an approval task
 * and includes the returned `taskId` in the result.
 */
export async function evaluateEscalation(
  results: readonly GuardrailResult[],
  policies: readonly EscalationPolicy[],
  ctx: EscalationContext,
  handler?: EscalationTaskHandler,
): Promise<EscalationResult> {
  const enabledPolicies = policies.filter(p => p.enabled);

  for (const policy of enabledPolicies) {
    const { trigger } = policy;
    let triggered = false;

    if (trigger.minWarnCount !== undefined) {
      const warnCount = countWarnsByCategory(results, trigger.categories);
      if (warnCount >= trigger.minWarnCount) triggered = true;
    }

    if (!triggered && trigger.riskLevels?.length) {
      if (hasRiskLevel(results, trigger.riskLevels)) triggered = true;
    }

    if (triggered) {
      // 'block' → deny immediately.
      // 'require-approval' → warn (hold); caller should await human approval
      //   rather than hard-blocking. The approval task is created below.
      const decision: GuardrailDecision = policy.onEscalate === 'block' ? 'deny' : 'warn';
      let taskId: string | undefined;

      if (handler && policy.onEscalate === 'require-approval') {
        try {
          const task = await handler(policy, ctx);
          taskId = task.taskId;
        } catch {
          // Handler failure does not prevent the hold — the turn stays at warn.
        }
      }

      return {
        escalated: true,
        decision,
        policy,
        taskId,
        reason: `Escalated by policy "${policy.name}": ${policy.description ?? policy.onEscalate}`,
      };
    }
  }

  return { escalated: false, decision: 'allow' };
}
