/**
 * @weaveintel/identity/tenancy — durable budget enforcer.
 *
 * The in-memory `createBudgetEnforcer()` resets every tenant's usage
 * counters on restart (every tenant gets a free month after a deploy).
 * `createDurableBudgetEnforcer({runtime?, namespace?})` persists usage
 * to `runtime.persistence.kv`.
 *
 * Usage counters store integer microUSD (`Math.round(costUsd * 1e6)`)
 * to avoid float drift across many recordUsage() calls.
 */
import type { ExecutionBudget } from '@weaveintel/core';
import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
} from '@weaveintel/core';
import type { TenantBudget, BudgetUsage, BudgetCheckResult } from './budget.js';

export interface DurableBudgetEnforcerOptions {
  runtime?: WeaveRuntime;
  namespace?: string;
}

export interface DurableBudgetEnforcer {
  setBudget(budget: TenantBudget): Promise<void>;
  getBudget(tenantId: string): Promise<TenantBudget | undefined>;
  deleteBudget(tenantId: string): Promise<void>;
  listBudgets(): Promise<TenantBudget[]>;
  recordUsage(tenantId: string, tokens: number, costUsd: number, steps: number): Promise<void>;
  getUsage(tenantId: string, period: 'daily' | 'monthly'): Promise<BudgetUsage | undefined>;
  checkBudget(tenantId: string): Promise<BudgetCheckResult>;
  resetPeriod(tenantId: string, period: 'daily' | 'monthly'): Promise<void>;
}

interface PersistedUsage {
  readonly tenantId: string;
  readonly period: 'daily' | 'monthly';
  readonly tokens: number;
  /** Cost stored as integer microUSD to avoid float drift. */
  readonly costMicroUsd: number;
  readonly steps: number;
  readonly runs: number;
  readonly periodStart: number;
}

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

function toUsage(p: PersistedUsage): BudgetUsage {
  return {
    tenantId: p.tenantId,
    period: p.period,
    tokens: p.tokens,
    costUsd: p.costMicroUsd / 1e6,
    steps: p.steps,
    runs: p.runs,
    periodStart: p.periodStart,
  };
}

export function createDurableBudgetEnforcer(
  opts: DurableBudgetEnforcerOptions = {},
): DurableBudgetEnforcer {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'tenant-budget';
  const budgetNs = `${ns}:b`;
  const usageNs = `${ns}:u`;
  const usageKey = (t: string, p: 'daily' | 'monthly') => `${usageNs}:${t}::${p}`;

  async function loadUsage(tenantId: string, period: 'daily' | 'monthly'): Promise<PersistedUsage> {
    const v = await kv.get(usageKey(tenantId, period));
    if (v) {
      try { return JSON.parse(v) as PersistedUsage; } catch { /* fall through */ }
    }
    return {
      tenantId, period,
      tokens: 0, costMicroUsd: 0, steps: 0, runs: 0,
      periodStart: Date.now(),
    };
  }

  return {
    async setBudget(b) { await kv.set(`${budgetNs}:${b.tenantId}`, JSON.stringify(b)); },
    async getBudget(t) {
      const v = await kv.get(`${budgetNs}:${t}`);
      if (!v) return undefined;
      try { return JSON.parse(v) as TenantBudget; } catch { return undefined; }
    },
    async deleteBudget(t) { await kv.delete(`${budgetNs}:${t}`); },
    async listBudgets() {
      const entries = await kv.list(`${budgetNs}:`);
      const out: TenantBudget[] = [];
      for (const e of entries) {
        try { out.push(JSON.parse(e.value) as TenantBudget); } catch { /* skip */ }
      }
      return out;
    },
    async recordUsage(tenantId, tokens, costUsd, steps) {
      const deltaMicro = Math.round(costUsd * 1e6);
      for (const period of ['daily', 'monthly'] as const) {
        const cur = await loadUsage(tenantId, period);
        const updated: PersistedUsage = {
          ...cur,
          tokens: cur.tokens + tokens,
          costMicroUsd: cur.costMicroUsd + deltaMicro,
          steps: cur.steps + steps,
          runs: cur.runs + 1,
        };
        await kv.set(usageKey(tenantId, period), JSON.stringify(updated));
      }
    },
    async getUsage(tenantId, period) {
      const v = await kv.get(usageKey(tenantId, period));
      if (!v) return undefined;
      try { return toUsage(JSON.parse(v) as PersistedUsage); } catch { return undefined; }
    },
    async checkBudget(tenantId) {
      const bRaw = await kv.get(`${budgetNs}:${tenantId}`);
      if (!bRaw) return { allowed: true, reason: 'No budget configured' };
      let budget: TenantBudget;
      try { budget = JSON.parse(bRaw) as TenantBudget; }
      catch { return { allowed: true, reason: 'Budget unreadable' }; }

      const dailyP = await loadUsage(tenantId, 'daily');
      const monthlyP = await loadUsage(tenantId, 'monthly');
      const daily = toUsage(dailyP);
      const monthly = toUsage(monthlyP);

      const check = (b: ExecutionBudget, u: BudgetUsage, label: string): string | null => {
        if (b.maxTokens && u.tokens >= b.maxTokens)
          return `${label} token limit reached (${u.tokens}/${b.maxTokens})`;
        if (b.maxCostUsd && u.costUsd >= b.maxCostUsd)
          return `${label} cost limit reached ($${u.costUsd.toFixed(4)}/$${b.maxCostUsd})`;
        return null;
      };
      const dailyDeny = check(budget.daily, daily, 'Daily');
      if (dailyDeny) return { allowed: false, reason: dailyDeny, dailyUsage: daily, monthlyUsage: monthly };
      const monthlyDeny = check(budget.monthly, monthly, 'Monthly');
      if (monthlyDeny) return { allowed: false, reason: monthlyDeny, dailyUsage: daily, monthlyUsage: monthly };
      return { allowed: true, dailyUsage: daily, monthlyUsage: monthly };
    },
    async resetPeriod(tenantId, period) {
      await kv.delete(usageKey(tenantId, period));
    },
  };
}
