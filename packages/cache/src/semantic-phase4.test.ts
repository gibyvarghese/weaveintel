/**
 * @weaveintel/cache — semantic cache tests.
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

// ─── Long & complex content ──────────────────────────────────
// Caches in production rarely see "capital of France" — they see multi-paragraph prompts
// with embedded code, JSON and logs. A higher-dimension TF embed keeps these robust (the
// 96-dim bag-of-words above collides too much on long text to assert exact thresholds).

function tfEmbed(text: string): number[] {
  const dim = 1024;
  const v = new Array(dim).fill(0);
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    v[h % dim] += 1;
  }
  return v;
}
const tf = async (t: string) => tfEmbed(t);

// A long, complicated prompt: prose + a fenced code block + an embedded JSON payload.
const LONG_PROMPT = [
  'Refactor the following ingestion handler so that it validates the incoming event against the',
  'schema, deduplicates on event_id, and writes idempotently to the warehouse. Keep the retry and',
  'backoff behaviour and preserve the existing structured logging. Here is the current code and a',
  'representative payload that flows through it during the nightly backfill job:',
  '```ts',
  'async function ingest(evt: ClickEvent): Promise<void> {',
  '  const ok = validate(evt);                 // throws on bad shape',
  '  if (await seen(evt.event_id)) return;     // dedup',
  '  await retry(() => warehouse.upsert(evt)); // exactly-once target',
  '  log.info("ingested", { id: evt.event_id, type: evt.type });',
  '}',
  '```',
  'A sample event:',
  '{ "event_id": "e-9f3a21", "user_id": "u-4471", "ts": "2026-03-01T10:02:11Z",',
  '  "type": "add_to_cart", "sku": "A-77", "qty": 2, "price_cents": 1899 }',
  'Explain where idempotency is actually enforced and what happens on a duplicate redelivery.',
].join('\n');

describe('weaveSemanticCache — long & complex content', () => {
  it('round-trips a long multi-paragraph prompt with embedded code/JSON verbatim', async () => {
    const sc = weaveSemanticCache({ embed: tf, defaultThreshold: 0.95 });
    const response = { plan: ['validate', 'dedup', 'upsert'], notes: 'idempotency at the upsert' };
    await sc.store(LONG_PROMPT, response);
    const hit = await sc.find(LONG_PROMPT); // identical text → cosine 1.0
    expect(hit).toBeTruthy();
    expect(hit!.similarity).toBeCloseTo(1, 5);
    expect(hit!.response).toEqual(response);
  });

  it('returns a large structured response object intact', async () => {
    const sc = weaveSemanticCache({ embed: tf, defaultThreshold: 0.9 });
    // A big nested response — the kind a real model returns for a complex prompt.
    const big = {
      summary: 'x'.repeat(5_000),
      steps: Array.from({ length: 200 }, (_, i) => ({ i, detail: `step ${i} `.repeat(20) })),
      nested: { deep: { deeper: { value: Array.from({ length: 500 }, (_, i) => i) } } },
    };
    await sc.store(LONG_PROMPT, big);
    const hit = await sc.find(LONG_PROMPT);
    expect((hit!.response as typeof big).steps).toHaveLength(200);
    expect((hit!.response as typeof big).nested.deep.deeper.value).toHaveLength(500);
    expect((hit!.response as typeof big).summary.length).toBe(5_000);
  });

  it('matches a paraphrase of a long prompt above a moderate threshold', async () => {
    const sc = weaveSemanticCache({ embed: tf, defaultThreshold: 0.6 });
    await sc.store(LONG_PROMPT, { answer: 'idempotency lives at the warehouse upsert' });
    // Same intent, reworded prose, identical embedded code/JSON anchors the similarity.
    const paraphrase = LONG_PROMPT
      .replace('Refactor the following ingestion handler', 'Please rework the ingestion handler below')
      .replace('Explain where idempotency is actually enforced', 'Tell me where idempotency is really enforced');
    const hit = await sc.find(paraphrase);
    expect(hit).toBeTruthy();
    expect((hit!.response as any).answer).toContain('idempotency');
  });

  it('does NOT collide two long prompts that differ only in a critical embedded id (strict gate)', async () => {
    const sc = weaveSemanticCache({ embed: tf, defaultThreshold: 0.999 });
    const userA = LONG_PROMPT; // event for u-4471
    const userB = LONG_PROMPT.replace('u-4471', 'u-9988').replace('e-9f3a21', 'e-0012b34');
    await sc.store(userA, { owner: 'u-4471' });
    // A near-identical long prompt for a different user must not serve the first user's cached
    // answer — a strict threshold guards against leaking across the one differing token.
    const hit = await sc.find(userB);
    expect(hit).toBeNull();
  });

  it('isolates a long prompt carrying a secret across tenant scopes', async () => {
    const sc = weaveSemanticCache({ embed: tf, defaultThreshold: 0.5 });
    const promptWithSecret = `${LONG_PROMPT}\nInternal note: db password is hunter2-prod-4471.`;
    await sc.store(promptWithSecret, { secret: 'TENANT_A_ONLY' }, { scope: 't=A' });
    expect(await sc.find(promptWithSecret, { scope: 't=B' })).toBeNull(); // no cross-tenant leak
    expect((await sc.find(promptWithSecret, { scope: 't=A' }))!.response).toEqual({ secret: 'TENANT_A_ONLY' });
  });

  it('does not re-embed a repeated long prompt (embedding cache)', async () => {
    const spy = vi.fn(async (t: string) => tfEmbed(t));
    const sc = weaveSemanticCache({ embed: spy, defaultThreshold: 0.9 });
    await sc.store(LONG_PROMPT, { v: 1 }); // embed #1
    await sc.find(LONG_PROMPT);            // cached embed
    await sc.find(LONG_PROMPT);            // cached embed
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stays bounded under a flood of distinct long prompts', async () => {
    const sc = weaveSemanticCache({ embed: tf, defaultThreshold: 0.99, maxEntries: 100 });
    for (let i = 0; i < 1_000; i++) await sc.store(`${LONG_PROMPT}\nrequest serial number ${i}`, { i });
    expect(await sc.size()).toBeLessThanOrEqual(100);
  });
});
