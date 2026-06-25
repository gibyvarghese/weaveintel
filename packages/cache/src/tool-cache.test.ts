/**
 * Phase 6 — `withToolResultCache` package tests.
 * Positive (hit replays, skips invoke), negative (opt-out, errors, distinct
 * args/tools/prefix), TTL expiry, stress, and security (no raw args in key).
 */
import { describe, it, expect } from 'vitest';
import { withToolResultCache, buildToolCacheKey, TOOL_CACHE_NAMESPACE } from './tool-cache.js';
import { weaveInMemoryCacheStore } from './store.js';
import { createCacheMetrics } from './metrics.js';
import type { Tool, ToolOutput, ExecutionContext, ToolInput } from '@weaveintel/core';

const ctx = {} as ExecutionContext;
const inp = (name: string, args: Record<string, unknown>): ToolInput => ({ name, arguments: args });

/** A tool that counts how many times the underlying handler actually runs. */
function countingTool(name = 'probe', opts?: { fail?: boolean; out?: (n: number) => ToolOutput }): Tool & { calls: number } {
  const t = {
    calls: 0,
    schema: { name, description: 'probe', parameters: { type: 'object', properties: {} } },
    async invoke(_c: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
      t.calls++;
      if (opts?.fail) return { content: `boom-${t.calls}`, isError: true };
      if (opts?.out) return opts.out(t.calls);
      return { content: `${name}-result-${t.calls}-${JSON.stringify(input.arguments)}` };
    },
  };
  return t;
}

describe('withToolResultCache — positive', () => {
  it('replays a cached result and skips the second invoke', async () => {
    const store = weaveInMemoryCacheStore();
    const tool = countingTool();
    const cached = withToolResultCache(tool, store, { cacheable: true, ttlMs: 60_000 });

    const a = await cached.invoke(ctx, inp('probe', { q: 1 }));
    const b = await cached.invoke(ctx, inp('probe', { q: 1 }));

    expect(a.content).toBe(b.content);   // identical → replayed
    expect(tool.calls).toBe(1);           // underlying ran only once
  });

  it('canonicalises args so key order does not matter', async () => {
    const store = weaveInMemoryCacheStore();
    const tool = countingTool();
    const cached = withToolResultCache(tool, store, { cacheable: true });

    await cached.invoke(ctx, inp('probe', { a: 1, b: 2 }));
    await cached.invoke(ctx, inp('probe', { b: 2, a: 1 })); // reordered → same key
    expect(tool.calls).toBe(1);
  });

  it('records hit/miss/set on the metrics sink', async () => {
    const store = weaveInMemoryCacheStore();
    const metrics = createCacheMetrics();
    const cached = withToolResultCache(countingTool(), store, { cacheable: true, metrics });

    await cached.invoke(ctx, inp('probe', { q: 1 })); // miss + set
    await cached.invoke(ctx, inp('probe', { q: 1 })); // hit
    const snap = metrics.snapshot().responseCache;
    expect(snap.misses).toBe(1);
    expect(snap.sets).toBe(1);
    expect(snap.hits).toBe(1);
  });
});

describe('withToolResultCache — negative / safety', () => {
  it('returns the tool UNCHANGED when not cacheable (no caching)', async () => {
    const store = weaveInMemoryCacheStore();
    const tool = countingTool();
    const wrapped = withToolResultCache(tool, store, { cacheable: false });
    expect(wrapped).toBe(tool); // same reference — zero overhead

    await tool.invoke(ctx, inp('probe', { q: 1 }));
    await tool.invoke(ctx, inp('probe', { q: 1 }));
    expect(tool.calls).toBe(2); // every call runs
    expect(await store.size()).toBe(0);
  });

  it('never caches an error result (no poisoning)', async () => {
    const store = weaveInMemoryCacheStore();
    const tool = countingTool('probe', { fail: true });
    const cached = withToolResultCache(tool, store, { cacheable: true });

    await cached.invoke(ctx, inp('probe', { q: 1 }));
    await cached.invoke(ctx, inp('probe', { q: 1 }));
    expect(tool.calls).toBe(2);          // re-ran (error not replayed)
    expect(await store.size()).toBe(0);  // nothing stored
  });

  it('different args produce a miss', async () => {
    const store = weaveInMemoryCacheStore();
    const tool = countingTool();
    const cached = withToolResultCache(tool, store, { cacheable: true });
    await cached.invoke(ctx, inp('probe', { q: 1 }));
    await cached.invoke(ctx, inp('probe', { q: 2 }));
    expect(tool.calls).toBe(2);
  });

  it('different tool names never collide on identical args', async () => {
    const store = weaveInMemoryCacheStore();
    const a = countingTool('alpha');
    const b = countingTool('beta');
    const ca = withToolResultCache(a, store, { cacheable: true });
    const cb = withToolResultCache(b, store, { cacheable: true });
    const ra = await ca.invoke(ctx, inp('alpha', { q: 1 }));
    const rb = await cb.invoke(ctx, inp('beta', { q: 1 }));
    expect(ra.content).not.toBe(rb.content); // each tool ran its own handler
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
  });

  it('different keyPrefix (version bump) busts the cache', async () => {
    const store = weaveInMemoryCacheStore();
    const tool = countingTool();
    const v1 = withToolResultCache(tool, store, { cacheable: true, keyPrefix: 'v1' });
    const v2 = withToolResultCache(tool, store, { cacheable: true, keyPrefix: 'v2' });
    await v1.invoke(ctx, inp('probe', { q: 1 }));
    await v2.invoke(ctx, inp('probe', { q: 1 })); // new prefix → miss
    expect(tool.calls).toBe(2);
  });
});

describe('withToolResultCache — TTL', () => {
  it('expires after ttlMs', async () => {
    const store = weaveInMemoryCacheStore();
    const tool = countingTool();
    const cached = withToolResultCache(tool, store, { cacheable: true, ttlMs: 20 });
    await cached.invoke(ctx, inp('probe', { q: 1 }));
    await new Promise((r) => setTimeout(r, 40));
    await cached.invoke(ctx, inp('probe', { q: 1 })); // expired → miss
    expect(tool.calls).toBe(2);
  });
});

describe('buildToolCacheKey — security', () => {
  it('namespaces, folds the prefix, and never leaks raw args', () => {
    const key = buildToolCacheKey('search', { secret: 'TOP-SECRET', q: 'x' }, 'v9');
    expect(key.startsWith(`${TOOL_CACHE_NAMESPACE}||v9||`)).toBe(true);
    expect(key).not.toContain('TOP-SECRET');
    expect(key).not.toContain('search '); // raw concat absent
  });
  it('is deterministic and arg-order independent', () => {
    expect(buildToolCacheKey('t', { a: 1, b: 2 })).toBe(buildToolCacheKey('t', { b: 2, a: 1 }));
  });
});

describe('withToolResultCache — stress', () => {
  it('handles many distinct keys then replays each as a hit', async () => {
    const store = weaveInMemoryCacheStore({ maxEntries: 5000 });
    const tool = countingTool('bulk', { out: (n) => ({ content: `r${n}` }) });
    const cached = withToolResultCache(tool, store, { cacheable: true, ttlMs: 60_000 });
    const N = 1000;
    for (let i = 0; i < N; i++) await cached.invoke(ctx, inp('bulk', { i }));
    expect(tool.calls).toBe(N);
    // Replay a sample — all hits, no new invokes.
    for (let i = 0; i < N; i += 50) await cached.invoke(ctx, inp('bulk', { i }));
    expect(tool.calls).toBe(N);
  });
});
