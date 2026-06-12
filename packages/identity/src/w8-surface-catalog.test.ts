/**
 * W8 — Surface catalog resolver tests
 *
 * Covers:
 *  - Multiple sources fanned out in parallel, entries merged
 *  - accessCheck: included when check passes, excluded when check fails
 *  - Fail-closed: erroring source returns [] (catalog not thrown)
 *  - Fail-closed: erroring accessCheck excludes entry (catalog not thrown)
 *  - Cache: second call returns cached result; TTL=0 disables cache
 *  - Observability: tracer.startSpan called with correct name + attributes
 *  - Empty sources: returns empty catalog
 */

import { describe, it, expect, vi } from 'vitest';
import { createSurfaceCatalogResolver } from './surface-catalog-resolver.js';
import type { CatalogSource, AccessCheck, CatalogCache } from './surface-catalog-resolver.js';
import type { ExecutionContext, CatalogEntry } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return weaveContext({ userId: 'u1', tenantId: 'tenant-1', ...overrides });
}

function makeEntry(id: string, kind: CatalogEntry['kind'] = 'mode'): CatalogEntry {
  return { id, kind, label: `Entry ${id}` };
}

function makeSource(name: string, entries: CatalogEntry[]): CatalogSource {
  return { name, entries: vi.fn(async () => entries) };
}

// ---------------------------------------------------------------------------

describe('createSurfaceCatalogResolver', () => {
  it('merges entries from multiple sources', async () => {
    const resolver = createSurfaceCatalogResolver({
      sources: [
        makeSource('a', [makeEntry('e1'), makeEntry('e2')]),
        makeSource('b', [makeEntry('e3')]),
      ],
    });
    const cat = await resolver.resolve(makeCtx(), { surfaceId: 'web' });
    expect(cat.surfaceId).toBe('web');
    expect(cat.entries).toHaveLength(3);
    expect(cat.entries.map((e) => e.id)).toEqual(expect.arrayContaining(['e1', 'e2', 'e3']));
    expect(cat.resolvedAt).toBeTruthy();
  });

  it('returns empty catalog when no sources', async () => {
    const resolver = createSurfaceCatalogResolver({ sources: [] });
    const cat = await resolver.resolve(makeCtx(), { surfaceId: 'mobile' });
    expect(cat.entries).toHaveLength(0);
  });

  it('includes entries where accessCheck returns true', async () => {
    const check: AccessCheck = async (_, entry) => entry.id === 'allowed';
    const resolver = createSurfaceCatalogResolver({
      sources: [makeSource('s', [makeEntry('allowed'), makeEntry('blocked')])],
      accessCheck: check,
    });
    const cat = await resolver.resolve(makeCtx(), { surfaceId: 'web' });
    expect(cat.entries).toHaveLength(1);
    expect(cat.entries[0]?.id).toBe('allowed');
  });

  it('excludes entries where accessCheck returns false (fail-closed)', async () => {
    const check: AccessCheck = async () => false;
    const resolver = createSurfaceCatalogResolver({
      sources: [makeSource('s', [makeEntry('e1')])],
      accessCheck: check,
    });
    const cat = await resolver.resolve(makeCtx(), { surfaceId: 'web' });
    expect(cat.entries).toHaveLength(0);
  });

  it('excludes entries where accessCheck throws (fail-closed)', async () => {
    const check: AccessCheck = async () => { throw new Error('access error'); };
    const resolver = createSurfaceCatalogResolver({
      sources: [makeSource('s', [makeEntry('e1')])],
      accessCheck: check,
    });
    const cat = await resolver.resolve(makeCtx(), { surfaceId: 'web' });
    expect(cat.entries).toHaveLength(0); // excluded, not thrown
  });

  it('skips erroring source and returns others (fail-closed)', async () => {
    const bad: CatalogSource = {
      name: 'bad',
      entries: async () => { throw new Error('source fail'); },
    };
    const resolver = createSurfaceCatalogResolver({
      sources: [bad, makeSource('good', [makeEntry('e1')])],
    });
    const cat = await resolver.resolve(makeCtx(), { surfaceId: 'web' });
    expect(cat.entries).toHaveLength(1);
    expect(cat.entries[0]?.id).toBe('e1');
  });

  it('caches results for the same principal+surface+tenant', async () => {
    const entriesFn = vi.fn(async () => [makeEntry('e1')]);
    const resolver = createSurfaceCatalogResolver({
      sources: [{ name: 'src', entries: entriesFn }],
      cacheTtlMs: 60_000,
    });
    const ctx = makeCtx();
    await resolver.resolve(ctx, { surfaceId: 'web' });
    await resolver.resolve(ctx, { surfaceId: 'web' });
    // Source should only be called once (second from cache)
    expect(entriesFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache when cacheTtlMs=0', async () => {
    const entriesFn = vi.fn(async () => [makeEntry('e1')]);
    const resolver = createSurfaceCatalogResolver({
      sources: [{ name: 'src', entries: entriesFn }],
      cacheTtlMs: 0,
    });
    const ctx = makeCtx();
    await resolver.resolve(ctx, { surfaceId: 'web' });
    await resolver.resolve(ctx, { surfaceId: 'web' });
    expect(entriesFn).toHaveBeenCalledTimes(2);
  });

  it('uses separate cache entries for different surfaces', async () => {
    const entriesFn = vi.fn(async () => [makeEntry('e1')]);
    const resolver = createSurfaceCatalogResolver({
      sources: [{ name: 'src', entries: entriesFn }],
      cacheTtlMs: 60_000,
    });
    const ctx = makeCtx();
    await resolver.resolve(ctx, { surfaceId: 'web' });
    await resolver.resolve(ctx, { surfaceId: 'mobile' });
    expect(entriesFn).toHaveBeenCalledTimes(2);
  });

  it('emits catalog.resolved span via tracer', async () => {
    const spans: { name: string; attributes?: Record<string, unknown> }[] = [];
    const tracer = {
      startSpan: vi.fn((_, name, attrs) => {
        spans.push({ name, attributes: attrs });
        return {
          end: vi.fn(),
          spanId: 'sp1',
          traceId: 'tr1',
          name,
          startTime: Date.now(),
          attributes: attrs ?? {},
          setAttribute: vi.fn(),
          addEvent: vi.fn(),
          setError: vi.fn(),
        };
      }),
      withSpan: vi.fn(),
    };
    const resolver = createSurfaceCatalogResolver({
      sources: [makeSource('s', [makeEntry('e1')])],
      cacheTtlMs: 0,
    });
    const ctx = makeCtx({ tracer });
    await resolver.resolve(ctx, { surfaceId: 'web' });
    const resolvedSpan = spans.find((s) => s.name === 'catalog.resolved');
    expect(resolvedSpan).toBeTruthy();
    expect(resolvedSpan?.attributes?.['totalEntries']).toBe(1);
    expect(resolvedSpan?.attributes?.['sourcesQueried']).toBe(1);
    // Ensure no PII: surfaceId is ok, but no userId
    expect(JSON.stringify(resolvedSpan?.attributes ?? {})).not.toContain('u1');
  });

  it('respects injected CatalogCache', async () => {
    const customCache: CatalogCache = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };
    const resolver = createSurfaceCatalogResolver({
      sources: [makeSource('s', [makeEntry('e1')])],
      cacheTtlMs: 5000,
      cache: customCache,
    });
    await resolver.resolve(makeCtx(), { surfaceId: 'web' });
    expect(customCache.set).toHaveBeenCalled();
  });
});
