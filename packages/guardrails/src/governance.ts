/**
 * @weaveintel/guardrails — governance.ts
 * GovernanceContext — runtime policy resolution
 */
import type { GovernanceRule, GovernanceContext as IGovernanceContext, GuardrailResult, RuntimePolicy } from '@weaveintel/core';

export class DefaultGovernanceContext implements IGovernanceContext {
  tenantId?: string;
  userId?: string;
  agentId?: string;
  rules: GovernanceRule[];

  constructor(opts: { tenantId?: string; userId?: string; agentId?: string; rules?: GovernanceRule[] }) {
    this.tenantId = opts.tenantId;
    this.userId = opts.userId;
    this.agentId = opts.agentId;
    this.rules = opts.rules ?? [];
  }

  async evaluate(input: unknown): Promise<GuardrailResult[]> {
    const text = typeof input === 'string' ? input : JSON.stringify(input);
    const results: GuardrailResult[] = [];

    const sorted = [...this.rules]
      .filter(r => r.enabled)
      .sort((a, b) => a.priority - b.priority);

    for (const rule of sorted) {
      try {
        const re = new RegExp(rule.condition, 'i');
        if (re.test(text)) {
          results.push({
            decision: rule.action,
            guardrailId: rule.id,
            explanation: rule.description ?? `Governance rule "${rule.name}" matched`,
          });
        }
      } catch {
        continue;
      }
    }

    return results;
  }

  addRule(rule: GovernanceRule): void {
    this.rules.push(rule);
  }

  removeRule(id: string): void {
    this.rules = this.rules.filter(r => r.id !== id);
  }
}

export function createGovernanceContext(opts: {
  tenantId?: string;
  userId?: string;
  agentId?: string;
  rules?: GovernanceRule[];
}): DefaultGovernanceContext {
  return new DefaultGovernanceContext(opts);
}

/** Apply an array of runtime policies to check if an action should proceed. */
export function evaluateRuntimePolicies(
  policies: RuntimePolicy[],
  context: { tokensUsed?: number; costUsd?: number; requestsInWindow?: number; action?: string },
): GuardrailResult[] {
  const results: GuardrailResult[] = [];

  for (const policy of policies.filter(p => p.enabled)) {
    switch (policy.type) {
      case 'cost-ceiling': {
        const ceiling = policy.config['maxCostUsd'] as number | undefined;
        if (ceiling !== undefined && context.costUsd !== undefined && context.costUsd > ceiling) {
          results.push({ decision: 'deny', guardrailId: policy.id, explanation: `Cost ceiling exceeded: $${context.costUsd} > $${ceiling}` });
        }
        break;
      }
      case 'token-limit': {
        const limit = policy.config['maxTokens'] as number | undefined;
        if (limit !== undefined && context.tokensUsed !== undefined && context.tokensUsed > limit) {
          results.push({ decision: 'deny', guardrailId: policy.id, explanation: `Token limit exceeded: ${context.tokensUsed} > ${limit}` });
        }
        break;
      }
      case 'rate-limit': {
        const maxRequests = policy.config['maxRequests'] as number | undefined;
        if (maxRequests !== undefined && context.requestsInWindow !== undefined && context.requestsInWindow > maxRequests) {
          results.push({ decision: 'deny', guardrailId: policy.id, explanation: `Rate limit exceeded: ${context.requestsInWindow} > ${maxRequests}` });
        }
        break;
      }
      case 'tool-restriction': {
        const denied = policy.config['deniedTools'] as string[] | undefined;
        if (denied && context.action && denied.includes(context.action)) {
          results.push({ decision: 'deny', guardrailId: policy.id, explanation: `Tool "${context.action}" is restricted` });
        }
        break;
      }
      default:
        break;
    }
  }

  return results;
}
