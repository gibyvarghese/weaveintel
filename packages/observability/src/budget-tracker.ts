/**
 * Budget tracker — monitors token/cost budgets and raises alerts when thresholds exceeded
 */
import type { UsageRecord } from '@weaveintel/core';

export interface BudgetConfig {
  /** Max tokens per hour */
  maxTokensPerHour?: number;
  /** Max cost (cents) per hour */
  maxCostPerHour?: number;
  /** Max tokens per request */
  maxTokensPerRequest?: number;
  /** Alert callback */
  onAlert?: (alert: BudgetAlert) => void;
}

export interface BudgetAlert {
  type: 'tokens_per_hour' | 'cost_per_hour' | 'tokens_per_request';
  current: number;
  limit: number;
  timestamp: number;
}

export interface BudgetSnapshot {
  tokensThisHour: number;
  costThisHour: number;
  requestsThisHour: number;
  alerts: BudgetAlert[];
}

export function weaveBudgetTracker(config: BudgetConfig) {
  const records: Array<{ tokens: number; cost: number; timestamp: number }> = [];
  const alerts: BudgetAlert[] = [];

  function hourRecords(): typeof records {
    const hourAgo = Date.now() - 3_600_000;
    return records.filter(r => r.timestamp >= hourAgo);
  }

  function checkBudget(usage: UsageRecord) {
    const tokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
    const cost = usage.costUsd ?? 0;
    records.push({ tokens, cost, timestamp: Date.now() });

    // Per-request check
    if (config.maxTokensPerRequest && tokens > config.maxTokensPerRequest) {
      const alert: BudgetAlert = {
        type: 'tokens_per_request',
        current: tokens,
        limit: config.maxTokensPerRequest,
        timestamp: Date.now(),
      };
      alerts.push(alert);
      config.onAlert?.(alert);
    }

    // Hourly checks
    const hourly = hourRecords();
    const hourlyTokens = hourly.reduce((s, r) => s + r.tokens, 0);
    const hourlyCost = hourly.reduce((s, r) => s + r.cost, 0);

    if (config.maxTokensPerHour && hourlyTokens > config.maxTokensPerHour) {
      const alert: BudgetAlert = {
        type: 'tokens_per_hour',
        current: hourlyTokens,
        limit: config.maxTokensPerHour,
        timestamp: Date.now(),
      };
      alerts.push(alert);
      config.onAlert?.(alert);
    }

    if (config.maxCostPerHour && hourlyCost > config.maxCostPerHour) {
      const alert: BudgetAlert = {
        type: 'cost_per_hour',
        current: hourlyCost,
        limit: config.maxCostPerHour,
        timestamp: Date.now(),
      };
      alerts.push(alert);
      config.onAlert?.(alert);
    }
  }

  function snapshot(): BudgetSnapshot {
    const hourly = hourRecords();
    return {
      tokensThisHour: hourly.reduce((s, r) => s + r.tokens, 0),
      costThisHour: hourly.reduce((s, r) => s + r.cost, 0),
      requestsThisHour: hourly.length,
      alerts: alerts.slice(-50),
    };
  }

  return { checkBudget, snapshot, alerts };
}

export type BudgetTracker = ReturnType<typeof weaveBudgetTracker>;
