/**
 * @weaveintel/cache — prompt-cache planner tests.
 * Positive, negative, boundary, stress, and a security/abuse case.
 */
import { describe, it, expect } from 'vitest';
import { planPromptCacheBreakpoints, estimatePromptTokens } from '../src/index.js';

describe('estimatePromptTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimatePromptTokens('')).toBe(0);
    expect(estimatePromptTokens('abcd')).toBe(1);
    expect(estimatePromptTokens('a'.repeat(4096))).toBe(1024);
  });
});

describe('planPromptCacheBreakpoints', () => {
  it('enables caching when the prefix exceeds the minimum', () => {
    const plan = planPromptCacheBreakpoints({ systemText: 'x'.repeat(5000), minTokens: 1024 });
    expect(plan.enabled).toBe(true);
    expect(plan.estimatedPrefixTokens).toBeGreaterThanOrEqual(1024);
    expect(plan.ttl).toBe('5m');
  });

  it('does NOT cache a sub-minimum prefix (avoids a wasted cache-write)', () => {
    const plan = planPromptCacheBreakpoints({ systemText: 'short system prompt', minTokens: 1024 });
    expect(plan.enabled).toBe(false);
    expect(plan.reason).toMatch(/< min/);
  });

  it('counts tools text toward the prefix', () => {
    const plan = planPromptCacheBreakpoints({ systemText: 'x'.repeat(2000), toolsText: 'y'.repeat(2200), minTokens: 1024 });
    // (2000+2200)/4 = 1050 ≥ 1024
    expect(plan.enabled).toBe(true);
    expect(plan.estimatedPrefixTokens).toBe(1050);
  });

  it('respects an explicit estimatedPrefixTokens override', () => {
    const plan = planPromptCacheBreakpoints({ systemText: 'tiny', estimatedPrefixTokens: 4096, minTokens: 1024 });
    expect(plan.enabled).toBe(true);
    expect(plan.estimatedPrefixTokens).toBe(4096);
  });

  it('honours the 1h TTL', () => {
    const plan = planPromptCacheBreakpoints({ estimatedPrefixTokens: 5000, ttl: '1h' });
    expect(plan.ttl).toBe('1h');
    expect(plan.enabled).toBe(true);
  });

  it('disabled by policy → never caches even for a large prefix', () => {
    const plan = planPromptCacheBreakpoints({ estimatedPrefixTokens: 100_000, enabled: false });
    expect(plan.enabled).toBe(false);
    expect(plan.reason).toMatch(/disabled by policy/);
  });

  it('provider not supported → no explicit caching', () => {
    const plan = planPromptCacheBreakpoints({ estimatedPrefixTokens: 100_000, providerSupported: false });
    expect(plan.enabled).toBe(false);
    expect(plan.reason).toMatch(/provider/);
  });

  it('boundary: exactly minTokens enables; one below disables', () => {
    expect(planPromptCacheBreakpoints({ estimatedPrefixTokens: 1024, minTokens: 1024 }).enabled).toBe(true);
    expect(planPromptCacheBreakpoints({ estimatedPrefixTokens: 1023, minTokens: 1024 }).enabled).toBe(false);
  });

  it('stress: a very large prefix is decided in O(1) and stays enabled', () => {
    const plan = planPromptCacheBreakpoints({ estimatedPrefixTokens: 2_000_000, minTokens: 1024 });
    expect(plan.enabled).toBe(true);
    expect(plan.estimatedPrefixTokens).toBe(2_000_000);
  });

  it('security: a custom minTokens of 0 cannot be tricked into caching an empty prefix when policy is off', () => {
    // Even with minTokens 0, an off-policy plan must not enable.
    const plan = planPromptCacheBreakpoints({ systemText: '', minTokens: 0, enabled: false });
    expect(plan.enabled).toBe(false);
  });
});
