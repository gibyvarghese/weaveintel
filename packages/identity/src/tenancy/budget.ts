import type { ExecutionBudget } from '@weaveintel/core';

export interface TenantBudget {
  readonly tenantId: string;
  readonly daily: ExecutionBudget;
  readonly monthly: ExecutionBudget;
}

export interface BudgetUsage {
  readonly tenantId: string;
  readonly period: 'daily' | 'monthly';
  tokens: number;
  costUsd: number;
  steps: number;
  runs: number;
  readonly periodStart: number;
}

export interface TenantBudgetEnforcer {
  setBudget(budget: TenantBudget): void;
  getBudget(tenantId: string): TenantBudget | undefined;
  deleteBudget(tenantId: string): void;
  listBudgets(): TenantBudget[];
  recordUsage(tenantId: string, tokens: number, costUsd: number, steps: number): void;
  getUsage(tenantId: string, period: 'daily' | 'monthly'): BudgetUsage | undefined;
  checkBudget(tenantId: string): BudgetCheckResult;
  resetPeriod(tenantId: string, period: 'daily' | 'monthly'): void;
}

export interface BudgetCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly dailyUsage?: BudgetUsage;
  readonly monthlyUsage?: BudgetUsage;
}

export function createBudgetEnforcer(): TenantBudgetEnforcer {
  const budgets = new Map<string, TenantBudget>();
  const usage = new Map<string, BudgetUsage>();

  function usageKey(tenantId: string, period: 'daily' | 'monthly'): string {
    return `${tenantId}:${period}`;
  }

  function getOrCreateUsage(tenantId: string, period: 'daily' | 'monthly'): BudgetUsage {
    const key = usageKey(tenantId, period);
    let u = usage.get(key);
    if (!u) {
      u = { tenantId, period, tokens: 0, costUsd: 0, steps: 0, runs: 0, periodStart: Date.now() };
      usage.set(key, u);
    }
    return u;
  }

  return {
    setBudget(budget) { budgets.set(budget.tenantId, budget); },
    getBudget(tenantId) { return budgets.get(tenantId); },
    deleteBudget(tenantId) { budgets.delete(tenantId); },
    listBudgets() { return [...budgets.values()]; },

    recordUsage(tenantId, tokens, costUsd, steps) {
      for (const period of ['daily', 'monthly'] as const) {
        const u = getOrCreateUsage(tenantId, period);
        u.tokens += tokens;
        u.costUsd += costUsd;
        u.steps += steps;
        u.runs++;
      }
    },

    getUsage(tenantId, period) { return usage.get(usageKey(tenantId, period)); },

    checkBudget(tenantId) {
      const budget = budgets.get(tenantId);
      if (!budget) return { allowed: true, reason: 'No budget configured' };

      const daily = getOrCreateUsage(tenantId, 'daily');
      const monthly = getOrCreateUsage(tenantId, 'monthly');

      if (budget.daily.maxTokens && daily.tokens >= budget.daily.maxTokens) {
        return { allowed: false, reason: `Daily token limit reached (${daily.tokens}/${budget.daily.maxTokens})`, dailyUsage: daily, monthlyUsage: monthly };
      }
      if (budget.daily.maxCostUsd && daily.costUsd >= budget.daily.maxCostUsd) {
        return { allowed: false, reason: `Daily cost limit reached ($${daily.costUsd.toFixed(4)}/$${budget.daily.maxCostUsd})`, dailyUsage: daily, monthlyUsage: monthly };
      }
      if (budget.monthly.maxTokens && monthly.tokens >= budget.monthly.maxTokens) {
        return { allowed: false, reason: `Monthly token limit reached (${monthly.tokens}/${budget.monthly.maxTokens})`, dailyUsage: daily, monthlyUsage: monthly };
      }
      if (budget.monthly.maxCostUsd && monthly.costUsd >= budget.monthly.maxCostUsd) {
        return { allowed: false, reason: `Monthly cost limit reached ($${monthly.costUsd.toFixed(4)}/$${budget.monthly.maxCostUsd})`, dailyUsage: daily, monthlyUsage: monthly };
      }

      return { allowed: true, dailyUsage: daily, monthlyUsage: monthly };
    },

    resetPeriod(tenantId, period) {
      const key = usageKey(tenantId, period);
      usage.delete(key);
    },
  };
}
