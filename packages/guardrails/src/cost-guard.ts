/**
 * @weaveintel/guardrails — cost-guard.ts
 * Token and cost ceiling enforcement
 */
import type { GuardrailResult, RuntimePolicy } from '@weaveintel/core';

export interface CostTracker {
  totalTokens: number;
  totalCostUsd: number;
  requestCount: number;
}

export interface CostGuardConfig {
  maxTokensPerRequest?: number;
  maxTokensTotal?: number;
  maxCostUsd?: number;
  maxRequestsPerMinute?: number;
}

export class CostGuard {
  private config: CostGuardConfig;
  private tracker: CostTracker = { totalTokens: 0, totalCostUsd: 0, requestCount: 0 };
  private windowStart = Date.now();

  constructor(config: CostGuardConfig) {
    this.config = config;
  }

  /** Check if a request should be allowed based on current usage. */
  check(requestTokens?: number): GuardrailResult[] {
    const results: GuardrailResult[] = [];
    const id = 'cost-guard';

    // Per-request token limit
    if (this.config.maxTokensPerRequest && requestTokens && requestTokens > this.config.maxTokensPerRequest) {
      results.push({
        decision: 'deny',
        guardrailId: id,
        explanation: `Request tokens (${requestTokens}) exceed per-request limit (${this.config.maxTokensPerRequest})`,
      });
    }

    // Total token limit
    if (this.config.maxTokensTotal && this.tracker.totalTokens > this.config.maxTokensTotal) {
      results.push({
        decision: 'deny',
        guardrailId: id,
        explanation: `Total tokens (${this.tracker.totalTokens}) exceed limit (${this.config.maxTokensTotal})`,
      });
    }

    // Cost ceiling
    if (this.config.maxCostUsd && this.tracker.totalCostUsd > this.config.maxCostUsd) {
      results.push({
        decision: 'deny',
        guardrailId: id,
        explanation: `Total cost ($${this.tracker.totalCostUsd.toFixed(4)}) exceeds ceiling ($${this.config.maxCostUsd})`,
      });
    }

    // Rate limit
    if (this.config.maxRequestsPerMinute) {
      const elapsed = Date.now() - this.windowStart;
      if (elapsed > 60_000) {
        this.tracker.requestCount = 0;
        this.windowStart = Date.now();
      }
      if (this.tracker.requestCount > this.config.maxRequestsPerMinute) {
        results.push({
          decision: 'deny',
          guardrailId: id,
          explanation: `Rate limit exceeded: ${this.tracker.requestCount} requests in window (max: ${this.config.maxRequestsPerMinute}/min)`,
        });
      }
    }

    return results;
  }

  /** Record token/cost usage after a request. */
  record(tokens: number, costUsd: number): void {
    this.tracker.totalTokens += tokens;
    this.tracker.totalCostUsd += costUsd;
    this.tracker.requestCount++;
  }

  /** Reset all tracked usage. */
  reset(): void {
    this.tracker = { totalTokens: 0, totalCostUsd: 0, requestCount: 0 };
    this.windowStart = Date.now();
  }

  getTracker(): Readonly<CostTracker> {
    return { ...this.tracker };
  }
}

export function createCostGuard(config: CostGuardConfig): CostGuard {
  return new CostGuard(config);
}

/** Convert RuntimePolicy objects into a CostGuardConfig. */
export function costGuardFromPolicies(policies: RuntimePolicy[]): CostGuardConfig {
  const config: CostGuardConfig = {};
  for (const p of policies.filter(p => p.enabled)) {
    if (p.type === 'cost-ceiling') {
      config.maxCostUsd = p.config['maxCostUsd'] as number;
    } else if (p.type === 'token-limit') {
      config.maxTokensTotal = p.config['maxTokens'] as number;
      config.maxTokensPerRequest = p.config['maxTokensPerRequest'] as number;
    } else if (p.type === 'rate-limit') {
      config.maxRequestsPerMinute = p.config['maxRequests'] as number;
    }
  }
  return config;
}
