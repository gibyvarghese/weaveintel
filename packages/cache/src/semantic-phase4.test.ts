/**
 * @weaveintel/cache — Phase 4 semantic cache tests.
 * Positive, negative, scope-isolation (security), TTL, LRU, embedding cache,
 * invalidation, pluggable index, and stress.
 */
import { describe, it, expect, vi } from 'vitest';
import { weaveSemanticCache, createInMemoryVectorIndex, cosineSimilarity } from '../src/index.js';

// Deterministic bag-of-words embedding: paraphrases that share tokens get a high
// cosine; unrelated text gets a low one. No model needed.
function bowEmbed(text: string): number[] {
  const dim = 96;
  const v = new Array(dim).fill(0);
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const c of tok) h = (h * 31 + c.charCodeAt(0)) % dim;
    v[h] += 1;
  }
  return v;
}
const embed = async (t: string) => bowEmbed(t);

describe('weaveSemanticCache — semantic matching', () => {
  it('returns a hit for a paraphrase above threshold', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.6 });
    await sc.store('What is the capital of France?', { answer: 'Paris' });
    const hit = await sc.find('Tell me the capital of France');
    expect(hit).toBeTruthy();
    expect((hit!.response as any).answer).toBe('Paris');
    expect(hit!.similarity).toBeGreaterThanOrEqual(0.6);
  });

  it('misses for an unrelated query', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.6 });
    await sc.store('What is the capital of France?', { answer: 'Paris' });
    expect(await sc.find('How does photosynthesis work in plants?')).toBeNull();
  });

  it('respects a high threshold (near-miss rejected)', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.999 });
    await sc.store('the quick brown fox', { v: 1 });
    expect(await sc.find('the quick brown dog')).toBeNull();
  });

  it('returns null on an empty cache', async () => {
    expect(await weaveSemanticCache({ embed }).find('anything')).toBeNull();
  });
});

describe('weaveSemanticCache — scope isolation (security)', () => {
  it('a query in tenant B never matches tenant A entries', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.5 });
    await sc.store('what is my account balance', { answer: 'TENANT_A_SECRET' }, { scope: 't=A' });
    // Identical query, different tenant scope → no cross-tenant hit.
    expect(await sc.find('what is my account balance', { scope: 't=B' })).toBeNull();
    // Same scope → hit.
    const same = await sc.find('what is my account balance', { scope: 't=A' });
    expect((same!.response as any).answer).toBe('TENANT_A_SECRET');
  });

  it('global (no scope) and scoped entries do not cross', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.5 });
    await sc.store('hello world', { s: 'scoped' }, { scope: 'u=1' });
    expect(await sc.find('hello world')).toBeNull(); // global lookup misses the scoped entry
  });

  it('clear(scope) only clears that partition', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.5 });
    await sc.store('q one', { a: 1 }, { scope: 't=A' });
    await sc.store('q two', { a: 2 }, { scope: 't=B' });
    await sc.clear('t=A');
    expect(await sc.find('q one', { scope: 't=A' })).toBeNull();
    expect(await sc.find('q two', { scope: 't=B' })).toBeTruthy();
  });
});

describe('weaveSemanticCache — TTL & eviction', () => {
  it('expired entries are not returned', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.5, ttlMs: 5 });
    await sc.store('ephemeral query', { v: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(await sc.find('ephemeral query')).toBeNull();
    expect(await sc.size()).toBe(0);
  });

  it('LRU-evicts the oldest once maxEntries is exceeded', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.99, maxEntries: 2 });
    await sc.store('alpha alpha alpha', { v: 'a' });
    await sc.store('bravo bravo bravo', { v: 'b' });
    await sc.find('alpha alpha alpha'); // touch alpha → most recent
    await sc.store('charlie charlie charlie', { v: 'c' }); // evicts bravo (LRU)
    expect(await sc.size()).toBe(2);
    expect(await sc.find('alpha alpha alpha')).toBeTruthy();
    expect(await sc.find('bravo bravo bravo')).toBeNull();
    expect(await sc.find('charlie charlie charlie')).toBeTruthy();
  });

  it('stress: stays bounded under a flood of unique queries', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.99, maxEntries: 50 });
    for (let i = 0; i < 5_000; i++) await sc.store(`unique query number ${i}`, { i });
    expect(await sc.size()).toBeLessThanOrEqual(50);
  });
});

describe('weaveSemanticCache — embedding cache', () => {
  it('does not re-embed identical query text', async () => {
    const spy = vi.fn(async (t: string) => bowEmbed(t));
    const sc = weaveSemanticCache({ embed: spy, defaultThreshold: 0.5 });
    await sc.store('repeated text', { v: 1 }); // embed #1
    await sc.find('repeated text');             // cached embed (no new call)
    await sc.find('repeated text');             // cached embed
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('weaveSemanticCache — invalidation', () => {
  it('removes entries within the invalidation radius (scoped)', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.5, invalidationRadius: 0.9 });
    await sc.store('reset my password please', { a: 1 }, { scope: 'u=1' });
    await sc.store('what is the capital of france', { a: 2 }, { scope: 'u=1' });
    await sc.invalidate('reset my password please', { scope: 'u=1' });
    expect(await sc.find('reset my password please', { scope: 'u=1' })).toBeNull();
    expect(await sc.find('what is the capital of france', { scope: 'u=1' })).toBeTruthy();
  });
});

describe('weaveSemanticCache — observability + pluggability', () => {
  it('fires onHit / onMiss hooks', async () => {
    const onHit = vi.fn(); const onMiss = vi.fn();
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.6, onHit, onMiss });
    await sc.store('the capital of france', { a: 1 });
    await sc.find('capital of france please'); // hit
    await sc.find('completely different topic entirely'); // miss
    expect(onHit).toHaveBeenCalledTimes(1);
    expect(onMiss).toHaveBeenCalledTimes(1);
  });

  it('accepts a custom VectorIndex backend', async () => {
    const index = createInMemoryVectorIndex();
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.5, index });
    await sc.store('shared index entry', { a: 1 });
    expect(index.size(Date.now())).toBe(1);
    expect(await sc.find('shared index entry')).toBeTruthy();
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0); // no NaN
  });
});
