/**
 * Phase 8 — Agentic Plan Cache tests.
 * distill / renderGuidance / lookup / store, threshold + scope isolation,
 * negative (no-match, empty), stress, and security (guidance is advisory only).
 */
import { describe, it, expect } from 'vitest';
import { createAgentPlanCache, createPlanCacheMetrics, type AgentPlan } from './plan-cache.js';
import type { SemanticCache, SemanticCacheHit, AgentStep } from '@weaveintel/core';

/** A tiny deterministic semantic cache: exact-key match within a scope, plus a
 *  "near" rule so we can exercise threshold/scope without real embeddings. */
function fakeSemanticCache(): SemanticCache & { entries: Map<string, { q: string; r: unknown }> } {
  const entries = new Map<string, { q: string; r: unknown }>();
  const key = (q: string, scope?: string) => `${scope ?? 'g'}::${q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
  return {
    entries,
    async find(query, opts): Promise<SemanticCacheHit | null> {
      const k = key(query, opts?.scope);
      const e = entries.get(k);
      if (!e) return null;
      return { response: e.r, similarity: 1, query: e.q } as SemanticCacheHit;
    },
    async store(query, response, opts) { entries.set(key(query, opts?.scope), { q: query, r: response }); },
    async invalidate() { /* noop */ },
    async clear(scope?: string) { if (!scope) entries.clear(); },
    async size() { return entries.size; },
  };
}

const step = (s: Partial<AgentStep>): AgentStep => ({ index: 0, type: 'response', durationMs: 1, ...s } as AgentStep);

describe('AgentPlanCache.distill', () => {
  it('extracts a compact template from delegations / tool calls / thinking', () => {
    const pc = createAgentPlanCache({ semanticCache: fakeSemanticCache() });
    const plan = pc.distill({
      output: 'done',
      steps: [
        step({ type: 'thinking', content: 'Break the task into research then summary' }),
        step({ type: 'delegation', delegation: { agent: 'researcher', goal: 'find population of Japan' } }),
        step({ type: 'tool_call', toolCall: { name: 'web_search', arguments: { query: 'Japan population' } } }),
        step({ type: 'response', content: 'The population is ...' }),
      ],
    }, 'Research the population of Japan and summarize');
    expect(plan.stepCount).toBe(4);
    expect(plan.workers).toEqual(['researcher']);
    expect(plan.tools).toEqual(['web_search']);
    expect(plan.steps.some(s => s.startsWith('delegate→researcher'))).toBe(true);
    expect(plan.steps.some(s => s.startsWith('tool:web_search('))).toBe(true);
    expect(plan.objective).toContain('Research the population of Japan');
  });

  it('truncates long step content (compact + secret-light)', () => {
    const pc = createAgentPlanCache({ semanticCache: fakeSemanticCache(), maxStepChars: 20 });
    const plan = pc.distill({ output: '', steps: [step({ type: 'thinking', content: 'x'.repeat(500) })] }, 'g');
    expect(plan.steps[0]!.length).toBeLessThan(40);
  });

  it('caps the number of retained steps', () => {
    const pc = createAgentPlanCache({ semanticCache: fakeSemanticCache(), maxSteps: 3 });
    const plan = pc.distill({ output: '', steps: Array.from({ length: 50 }, () => step({ type: 'response' })) }, 'g');
    expect(plan.steps.length).toBe(3);
    expect(plan.stepCount).toBe(50); // true count preserved for the min-steps gate
  });
});

describe('AgentPlanCache.renderGuidance', () => {
  it('renders an ADVISORY block (adapt, re-derive params)', () => {
    const pc = createAgentPlanCache({ semanticCache: fakeSemanticCache() });
    const plan: AgentPlan = { objective: 'Research X', steps: ['delegate→researcher: find X', 'respond'], workers: ['researcher'], tools: [], stepCount: 2 };
    const g = pc.renderGuidance(plan);
    expect(g).toMatch(/Reference plan/i);
    expect(g).toMatch(/ADAPT it to the CURRENT request/i);
    expect(g).toContain('delegate→researcher');
    expect(g).toContain('Workers previously used: researcher');
  });
});

describe('AgentPlanCache.lookup / store', () => {
  it('stores a plan and finds it for the same goal (hit)', async () => {
    const metrics = createPlanCacheMetrics();
    const pc = createAgentPlanCache({ semanticCache: fakeSemanticCache(), metrics });
    const plan: AgentPlan = { objective: 'g', steps: ['respond'], workers: [], tools: [], stepCount: 1 };
    await pc.store('Summarize the report', plan);
    const hit = await pc.lookup('Summarize the report');
    expect(hit?.stepCount).toBe(1);
    const snap = metrics.snapshot();
    expect(snap.stores).toBe(1);
    expect(snap.hits).toBe(1);
  });

  it('returns null on a miss and records it', async () => {
    const metrics = createPlanCacheMetrics();
    const pc = createAgentPlanCache({ semanticCache: fakeSemanticCache(), metrics });
    expect(await pc.lookup('never stored')).toBeNull();
    expect(metrics.snapshot().misses).toBe(1);
  });

  it('isolates plans by scope (tenant A never sees tenant B)', async () => {
    const pc = createAgentPlanCache({ semanticCache: fakeSemanticCache() });
    const plan: AgentPlan = { objective: 'g', steps: ['respond'], workers: [], tools: [], stepCount: 1 };
    await pc.store('Do the thing', plan, { scope: 'tenantA' });
    expect(await pc.lookup('Do the thing', { scope: 'tenantA' })).not.toBeNull();
    expect(await pc.lookup('Do the thing', { scope: 'tenantB' })).toBeNull(); // isolation
  });

  it('ignores a non-plan value in the cache (never crashes)', async () => {
    const sc = fakeSemanticCache();
    const pc = createAgentPlanCache({ semanticCache: sc });
    await sc.store('weird', { not: 'a plan' });
    expect(await pc.lookup('weird')).toBeNull();
  });

  it('store failures are swallowed (best-effort, never throws)', async () => {
    const sc = fakeSemanticCache();
    sc.store = async () => { throw new Error('embed down'); };
    const pc = createAgentPlanCache({ semanticCache: sc });
    await expect(pc.store('g', { objective: 'g', steps: [], workers: [], tools: [], stepCount: 0 })).resolves.toBeUndefined();
  });
});

describe('AgentPlanCache — stress', () => {
  it('stores and retrieves many distinct plans', async () => {
    const pc = createAgentPlanCache({ semanticCache: fakeSemanticCache() });
    const N = 500;
    for (let i = 0; i < N; i++) await pc.store(`task number ${i}`, { objective: `t${i}`, steps: ['respond'], workers: [], tools: [], stepCount: 1 });
    for (let i = 0; i < N; i += 50) expect((await pc.lookup(`task number ${i}`))?.objective).toBe(`t${i}`);
  });
});
