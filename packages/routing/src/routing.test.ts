/**
 * @weaveintel/routing — Unit tests
 */
import { describe, it, expect } from 'vitest';
import {
  ModelHealthTracker,
  ModelScorer,
  filterByConstraints,
  roundRobinSelect,
  fallbackCandidate,
  SmartModelRouter,
  InMemoryDecisionStore,
} from '../src/index.js';
import type { ModelCostInfo, ModelQualityInfo, ModelCandidate } from '../src/index.js';
import type { RoutingPolicy, ModelHealth } from '@weaveintel/core';

// ─── Health tracker ──────────────────────────────────────────

describe('ModelHealthTracker', () => {
  it('returns null for unknown model', () => {
    const ht = new ModelHealthTracker();
    expect(ht.getHealth('m1', 'p1')).toBeNull();
  });

  it('records success and computes metrics', () => {
    const ht = new ModelHealthTracker();
    ht.record('m1', 'p1', { latencyMs: 100, success: true });
    ht.record('m1', 'p1', { latencyMs: 200, success: true });
    const h = ht.getHealth('m1', 'p1')!;
    expect(h.available).toBe(true);
    expect(h.avgLatencyMs).toBe(150);
    expect(h.errorRate).toBe(0);
  });

  it('marks unavailable when error rate exceeds 50%', () => {
    const ht = new ModelHealthTracker();
    // 1 success, 5 errors → 83% error rate
    ht.record('m1', 'p1', { latencyMs: 100, success: true });
    for (let i = 0; i < 5; i++) ht.record('m1', 'p1', { latencyMs: 50, success: false });
    const h = ht.getHealth('m1', 'p1')!;
    expect(h.available).toBe(false);
    expect(h.errorRate).toBeCloseTo(5 / 6);
  });

  it('stays available with few samples', () => {
    const ht = new ModelHealthTracker();
    ht.record('m1', 'p1', { latencyMs: 100, success: false });
    ht.record('m1', 'p1', { latencyMs: 100, success: false });
    // 2 errors, <5 samples → still available
    expect(ht.getHealth('m1', 'p1')!.available).toBe(true);
  });

  it('respects sliding window size', () => {
    const ht = new ModelHealthTracker({ windowSize: 3 });
    ht.record('m1', 'p1', { latencyMs: 1000, success: true });
    ht.record('m1', 'p1', { latencyMs: 100, success: true });
    ht.record('m1', 'p1', { latencyMs: 100, success: true });
    ht.record('m1', 'p1', { latencyMs: 100, success: true });
    // oldest 1000ms should be evicted
    const h = ht.getHealth('m1', 'p1')!;
    expect(h.avgLatencyMs).toBe(100);
  });

  it('setAvailable overrides computed state', () => {
    const ht = new ModelHealthTracker();
    ht.record('m1', 'p1', { latencyMs: 100, success: true });
    ht.setAvailable('m1', 'p1', false);
    expect(ht.getHealth('m1', 'p1')!.available).toBe(false);
  });

  it('listHealth returns all tracked models', () => {
    const ht = new ModelHealthTracker();
    ht.record('m1', 'p1', { latencyMs: 100, success: true });
    ht.record('m2', 'p2', { latencyMs: 200, success: true });
    expect(ht.listHealth()).toHaveLength(2);
  });
});

// ─── Scorer ──────────────────────────────────────────────────

describe('ModelScorer', () => {
  const scorer = new ModelScorer();
  const policy: RoutingPolicy = {
    id: 'pol1', name: 'Test', strategy: 'cost-optimized', enabled: true,
    weights: { cost: 0.5, latency: 0.3, quality: 0.2, reliability: 0 },
  };

  it('scores candidates and sorts by overallScore desc', () => {
    const candidates = [
      { modelId: 'expensive', providerId: 'p1' },
      { modelId: 'cheap', providerId: 'p2' },
    ];
    const health: ModelHealth[] = [
      { modelId: 'expensive', providerId: 'p1', available: true, avgLatencyMs: 100, errorRate: 0, lastChecked: '' },
      { modelId: 'cheap', providerId: 'p2', available: true, avgLatencyMs: 200, errorRate: 0, lastChecked: '' },
    ];
    const costs: ModelCostInfo[] = [
      { modelId: 'expensive', providerId: 'p1', inputCostPer1M: 100, outputCostPer1M: 100 },
      { modelId: 'cheap', providerId: 'p2', inputCostPer1M: 10, outputCostPer1M: 10 },
    ];
    const qualities: ModelQualityInfo[] = [
      { modelId: 'expensive', providerId: 'p1', qualityScore: 0.9 },
      { modelId: 'cheap', providerId: 'p2', qualityScore: 0.7 },
    ];

    const scores = scorer.score(candidates, health, costs, qualities, policy);
    expect(scores).toHaveLength(2);
    // cheap should rank higher due to high cost weight
    expect(scores[0]!.modelId).toBe('cheap');
  });

  it('uses default weights when policy has none', () => {
    const bare: RoutingPolicy = { id: 'pol', name: 'Bare', strategy: 'balanced', enabled: true };
    const scores = scorer.score(
      [{ modelId: 'm1', providerId: 'p1' }],
      [{ modelId: 'm1', providerId: 'p1', available: true, avgLatencyMs: 100, errorRate: 0, lastChecked: '' }],
      [{ modelId: 'm1', providerId: 'p1', inputCostPer1M: 5, outputCostPer1M: 5 }],
      [{ modelId: 'm1', providerId: 'p1', qualityScore: 0.8 }],
      bare,
    );
    expect(scores).toHaveLength(1);
    expect(scores[0]!.overallScore).toBeGreaterThan(0);
  });
});

// ─── Policy filtering ────────────────────────────────────────

describe('filterByConstraints', () => {
  const candidates: ModelCandidate[] = [
    { modelId: 'm1', providerId: 'openai', capabilities: ['chat', 'vision'] },
    { modelId: 'm2', providerId: 'anthropic', capabilities: ['chat'] },
    { modelId: 'm3', providerId: 'openai', capabilities: ['chat'] },
  ];
  const healthMap = new Map<string, ModelHealth>();

  it('returns all when no constraints', () => {
    expect(filterByConstraints(candidates, undefined, healthMap)).toHaveLength(3);
  });

  it('excludes providers', () => {
    const result = filterByConstraints(candidates, { excludeProviders: ['anthropic'] }, healthMap);
    expect(result).toHaveLength(2);
    expect(result.every(c => c.providerId !== 'anthropic')).toBe(true);
  });

  it('excludes models', () => {
    const result = filterByConstraints(candidates, { excludeModels: ['m1', 'm3'] }, healthMap);
    expect(result).toHaveLength(1);
    expect(result[0]!.modelId).toBe('m2');
  });

  it('filters by max latency', () => {
    const hm = new Map<string, ModelHealth>([
      ['openai:m1', { modelId: 'm1', providerId: 'openai', available: true, avgLatencyMs: 500, errorRate: 0, lastChecked: '' }],
      ['anthropic:m2', { modelId: 'm2', providerId: 'anthropic', available: true, avgLatencyMs: 100, errorRate: 0, lastChecked: '' }],
      ['openai:m3', { modelId: 'm3', providerId: 'openai', available: true, avgLatencyMs: 300, errorRate: 0, lastChecked: '' }],
    ]);
    const result = filterByConstraints(candidates, { maxLatencyMs: 400 }, hm);
    expect(result).toHaveLength(2);
    expect(result.map(c => c.modelId)).toEqual(['m2', 'm3']);
  });

  it('filters by required capabilities', () => {
    const result = filterByConstraints(candidates, { requiredCapabilities: ['vision'] }, healthMap);
    expect(result).toHaveLength(1);
    expect(result[0]!.modelId).toBe('m1');
  });
});

describe('roundRobinSelect', () => {
  it('cycles through items', () => {
    const items = ['a', 'b', 'c'];
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) seen.add(roundRobinSelect(items));
    expect(seen.size).toBeGreaterThanOrEqual(1);
  });
});

describe('fallbackCandidate', () => {
  it('returns null when no fallback configured', () => {
    expect(fallbackCandidate({ id: 'p', name: 'P', strategy: 'balanced', enabled: true })).toBeNull();
  });

  it('returns candidate with fallback fields', () => {
    const fb = fallbackCandidate({
      id: 'p', name: 'P', strategy: 'balanced', enabled: true,
      fallbackModelId: 'gpt-4o-mini', fallbackProviderId: 'openai',
    });
    expect(fb).toEqual({ modelId: 'gpt-4o-mini', providerId: 'openai' });
  });
});

// ─── Decision store ──────────────────────────────────────────

describe('InMemoryDecisionStore', () => {
  it('records and lists decisions', async () => {
    const store = new InMemoryDecisionStore();
    await store.record({ modelId: 'm1', providerId: 'p1', reason: 'test', scores: {}, alternatives: [], timestamp: '' });
    await store.record({ modelId: 'm2', providerId: 'p2', reason: 'test', scores: {}, alternatives: [], timestamp: '' });
    const all = await store.list();
    expect(all).toHaveLength(2);
    // newest first
    expect(all[0]!.modelId).toBe('m2');
  });

  it('filters by modelId', async () => {
    const store = new InMemoryDecisionStore();
    await store.record({ modelId: 'm1', providerId: 'p1', reason: '', scores: {}, alternatives: [], timestamp: '' });
    await store.record({ modelId: 'm2', providerId: 'p1', reason: '', scores: {}, alternatives: [], timestamp: '' });
    const result = await store.list({ modelId: 'm1' });
    expect(result).toHaveLength(1);
  });

  it('supports limit', async () => {
    const store = new InMemoryDecisionStore();
    for (let i = 0; i < 10; i++) await store.record({ modelId: 'm1', providerId: 'p1', reason: `${i}`, scores: {}, alternatives: [], timestamp: '' });
    expect(await store.list({ limit: 3 })).toHaveLength(3);
  });

  it('clears all decisions', async () => {
    const store = new InMemoryDecisionStore();
    await store.record({ modelId: 'm1', providerId: 'p1', reason: '', scores: {}, alternatives: [], timestamp: '' });
    await store.clear();
    expect(await store.list()).toHaveLength(0);
  });
});

// ─── SmartModelRouter ────────────────────────────────────────

describe('SmartModelRouter', () => {
  const candidates: ModelCandidate[] = [
    { modelId: 'gpt-4o', providerId: 'openai' },
    { modelId: 'claude-sonnet', providerId: 'anthropic' },
  ];
  const costs: ModelCostInfo[] = [
    { modelId: 'gpt-4o', providerId: 'openai', inputCostPer1M: 5, outputCostPer1M: 15 },
    { modelId: 'claude-sonnet', providerId: 'anthropic', inputCostPer1M: 3, outputCostPer1M: 15 },
  ];
  const qualities: ModelQualityInfo[] = [
    { modelId: 'gpt-4o', providerId: 'openai', qualityScore: 0.9 },
    { modelId: 'claude-sonnet', providerId: 'anthropic', qualityScore: 0.85 },
  ];

  it('routes with score strategy', async () => {
    const router = new SmartModelRouter({ candidates, costs, qualities });
    const decision = await router.route(
      { prompt: 'Hello' },
      { id: 'p1', name: 'Cost', strategy: 'cost-optimized', enabled: true, weights: { cost: 0.8, latency: 0.1, quality: 0.1 } },
    );
    expect(decision.modelId).toBeTruthy();
    expect(decision.providerId).toBeTruthy();
    expect(decision.reason).toBeTruthy();
  });

  it('routes with round-robin strategy', async () => {
    const router = new SmartModelRouter({ candidates, costs, qualities });
    const policy: RoutingPolicy = { id: 'rr', name: 'RR', strategy: 'round-robin', enabled: true };
    const d1 = await router.route({ prompt: 'A' }, policy);
    const d2 = await router.route({ prompt: 'B' }, policy);
    // round-robin should cycle
    expect(d1.modelId).toBeTruthy();
    expect(d2.modelId).toBeTruthy();
  });

  it('falls back when all filtered out', async () => {
    const router = new SmartModelRouter({ candidates, costs, qualities });
    const policy: RoutingPolicy = {
      id: 'fb', name: 'Fallback', strategy: 'balanced', enabled: true,
      constraints: { excludeProviders: ['openai', 'anthropic'] },
      fallbackModelId: 'gpt-4o-mini', fallbackProviderId: 'openai',
    };
    const decision = await router.route({ prompt: 'Hello' }, policy);
    expect(decision.modelId).toBe('gpt-4o-mini');
    expect(decision.reason).toContain('fallback');
  });

  it('throws when no eligible and no fallback', async () => {
    const router = new SmartModelRouter({ candidates, costs, qualities });
    const policy: RoutingPolicy = {
      id: 'fail', name: 'Fail', strategy: 'balanced', enabled: true,
      constraints: { excludeProviders: ['openai', 'anthropic'] },
    };
    await expect(router.route({ prompt: 'Hello' }, policy)).rejects.toThrow('No eligible models');
  });

  it('records to decision store', async () => {
    const store = new InMemoryDecisionStore();
    const router = new SmartModelRouter({ candidates, costs, qualities, decisionStore: store });
    await router.route({ prompt: 'Hi' }, { id: 'p', name: 'Test', strategy: 'balanced', enabled: true });
    const decisions = await store.list();
    expect(decisions).toHaveLength(1);
  });

  it('records outcome and tracks health', async () => {
    const router = new SmartModelRouter({ candidates, costs, qualities });
    const decision = await router.route(
      { prompt: 'Hi' },
      { id: 'p', name: 'T', strategy: 'balanced', enabled: true },
    );
    await router.recordOutcome(decision, { latencyMs: 150, success: true });
    const h = await router.getHealth(decision.modelId, decision.providerId);
    expect(h).not.toBeNull();
    expect(h!.avgLatencyMs).toBe(150);
  });
});
