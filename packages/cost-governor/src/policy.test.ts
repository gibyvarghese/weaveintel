import { describe, it, expect } from 'vitest';
import {
  TIER_PRESETS,
  resolveCostPolicy,
  weaveCostGovernor,
  weaveStaticCostPolicyResolver,
  composeCostPolicyResolvers,
  resolveCostGovernorBundle,
  CostCeilingExceededError,
  DEFAULT_COST_TIER,
} from './index.js';
import type { CostPolicy, CostPolicyResolver } from './index.js';

describe('TIER_PRESETS', () => {
  it('ships economy/balanced/performance/max', () => {
    expect(Object.keys(TIER_PRESETS).sort()).toEqual(['balanced', 'economy', 'max', 'performance']);
  });
  it('preset budget ceilings escalate by tier', () => {
    expect(TIER_PRESETS.economy.budgetCeilingUsd).toBeLessThan(TIER_PRESETS.balanced.budgetCeilingUsd);
    expect(TIER_PRESETS.balanced.budgetCeilingUsd).toBeLessThan(TIER_PRESETS.performance.budgetCeilingUsd);
    expect(TIER_PRESETS.performance.budgetCeilingUsd).toBeLessThan(TIER_PRESETS.max.budgetCeilingUsd);
  });
});

describe('resolveCostPolicy', () => {
  it('returns the preset when no overrides supplied', () => {
    const r = resolveCostPolicy({ tier: 'balanced' });
    expect(r.budgetCeilingUsd).toBe(TIER_PRESETS.balanced.budgetCeilingUsd);
    expect(r.maxStepsCap).toBe(TIER_PRESETS.balanced.maxStepsCap);
  });
  it('per-field overrides win over preset', () => {
    const r = resolveCostPolicy({ tier: 'economy', budgetCeilingUsd: 99, maxStepsCap: 7 });
    expect(r.budgetCeilingUsd).toBe(99);
    expect(r.maxStepsCap).toBe(7);
    // unrelated fields preserved
    expect(r.reasoningEffort).toBe(TIER_PRESETS.economy.reasoningEffort);
  });
  it('nested overrides shallow-merge', () => {
    const r = resolveCostPolicy({
      tier: 'balanced',
      historyCompaction: { strategy: 'summary' },
    });
    expect(r.historyCompaction.strategy).toBe('summary');
  });
  it('custom tier does not pull preset values', () => {
    const r = resolveCostPolicy({ tier: 'custom', maxStepsCap: 5 });
    expect(r.tier).toBe('custom');
    expect(r.maxStepsCap).toBe(5);
    expect(r.intelGating.enabled).toBe(false);
  });
});

describe('weaveCostGovernor (no-op stubs)', () => {
  it('captures the resolved policy on the bundle', () => {
    const b = weaveCostGovernor({ tier: 'performance' });
    expect(b.policy.tier).toBe('performance');
    expect(b.policy.maxStepsCap).toBe(TIER_PRESETS.performance.maxStepsCap);
  });
  it('modelResolver returns null (no override)', async () => {
    const b = weaveCostGovernor({ tier: 'balanced' });
    expect(await b.modelResolver({ runId: 'r1' })).toBeNull();
  });
  it('toolFilter returns null (keep all)', async () => {
    const b = weaveCostGovernor({ tier: 'balanced' });
    expect(await b.toolFilter(['a', 'b'], { runId: 'r1' })).toBeNull();
  });
  it('promptShaper returns null (no shaping)', async () => {
    const b = weaveCostGovernor({ tier: 'balanced' });
    expect(await b.promptShaper({ runId: 'r1' })).toBeNull();
  });
  it('historyCompactor returns history unchanged', async () => {
    const b = weaveCostGovernor({ tier: 'balanced' });
    const h = [{ role: 'user', content: 'x' }];
    expect(await b.historyCompactor(h, { runId: 'r1' })).toBe(h);
  });
  it('budgetGate.check is a no-op', async () => {
    const b = weaveCostGovernor({ tier: 'economy' });
    await Promise.resolve(b.budgetGate.check({ runId: 'r1' }));
  });
});

describe('CostCeilingExceededError', () => {
  it('captures runId, costUsd, ceilingUsd', () => {
    const e = new CostCeilingExceededError('r1', 1.5, 1.0);
    expect(e.runId).toBe('r1');
    expect(e.costUsd).toBe(1.5);
    expect(e.ceilingUsd).toBe(1.0);
    expect(e.message).toContain('r1');
  });
});

describe('weaveStaticCostPolicyResolver', () => {
  it('always returns the pinned policy with source=static', async () => {
    const policy: CostPolicy = { tier: 'performance' };
    const r = weaveStaticCostPolicyResolver(policy);
    const out = await r.resolve({ agentId: 'a1' });
    expect(out?.policy).toBe(policy);
    expect(out?.source).toBe('static');
  });
});

describe('composeCostPolicyResolvers', () => {
  it('first non-null wins', async () => {
    const a: CostPolicyResolver = { async resolve() { return null; } };
    const b: CostPolicyResolver = { async resolve() { return { policy: { tier: 'economy' }, source: 'agent_binding' }; } };
    const c: CostPolicyResolver = { async resolve() { return { policy: { tier: 'max' }, source: 'mesh_binding' }; } };
    const composed = composeCostPolicyResolvers([a, b, c]);
    const out = await composed.resolve({});
    expect(out?.source).toBe('agent_binding');
    expect(out?.policy.tier).toBe('economy');
  });
  it('throwing resolver is treated as null', async () => {
    const a: CostPolicyResolver = { async resolve() { throw new Error('boom'); } };
    const b: CostPolicyResolver = { async resolve() { return { policy: { tier: 'economy' }, source: 'workflow_binding' }; } };
    const composed = composeCostPolicyResolvers([a, b]);
    const out = await composed.resolve({});
    expect(out?.source).toBe('workflow_binding');
  });
  it('returns null when no resolver matches', async () => {
    const composed = composeCostPolicyResolvers([{ async resolve() { return null; } }]);
    expect(await composed.resolve({})).toBeNull();
  });
});

describe('resolveCostGovernorBundle', () => {
  it('per-run override beats resolver', async () => {
    const r = weaveStaticCostPolicyResolver({ tier: 'economy' });
    const out = await resolveCostGovernorBundle(r, { perRunOverride: { tier: 'max' } });
    expect(out.binding.source).toBe('per_run_override');
    expect(out.bundle.policy.tier).toBe('max');
  });
  it('falls back to package default when no resolver and no override', async () => {
    const out = await resolveCostGovernorBundle(undefined, {});
    expect(out.binding.source).toBe('package_default');
    expect(out.bundle.policy.tier).toBe(DEFAULT_COST_TIER);
  });
  it('uses resolver when provided', async () => {
    const r = weaveStaticCostPolicyResolver({ tier: 'performance' });
    const out = await resolveCostGovernorBundle(r, { agentId: 'a1' });
    expect(out.binding.source).toBe('static');
    expect(out.bundle.policy.tier).toBe('performance');
  });
});
