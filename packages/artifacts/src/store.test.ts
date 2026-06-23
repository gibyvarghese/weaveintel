import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryArtifactStore } from './store.js';
import { createArtifactPolicy } from './policy.js';
import type { ArtifactStore } from '@weaveintel/core';

let store: ArtifactStore;
beforeEach(() => { store = createInMemoryArtifactStore(); });

const base = (overrides: object = {}) => ({
  name: 'test',
  type: 'text' as const,
  mimeType: 'text/plain',
  data: 'hello',
  version: 1,
  scope: 'session' as const,
  ...overrides,
});

// ─── save ─────────────────────────────────────────────────────────────────────

describe('save', () => {
  it('assigns a UUID id and createdAt', async () => {
    const a = await store.save(base());
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.createdAt).toBeTruthy();
  });

  it('auto-creates the first version record', async () => {
    const a = await store.save(base());
    const versions = await store.getVersions(a.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
  });

  it('defaults scope to session', async () => {
    const a = await store.save({ name: 'x', type: 'text', mimeType: 'text/plain', data: 'x', version: 1 });
    expect(a.scope ?? 'session').toBe('session');
  });

  it('persists user scope', async () => {
    const a = await store.save(base({ scope: 'user', userId: 'u-1' }));
    expect(a.scope).toBe('user');
  });

  it('throws when policy is violated', async () => {
    const policyStore = createInMemoryArtifactStore({
      policy: createArtifactPolicy({ name: 'tiny', maxSizeBytes: 2 }),
    });
    await expect(
      policyStore.save(base({ data: 'this is too long for 2 bytes' })),
    ).rejects.toThrow(/policy violation/i);
  });

  it('allows save that satisfies the policy', async () => {
    const policyStore = createInMemoryArtifactStore({
      policy: createArtifactPolicy({ name: 'generous', maxSizeBytes: 1_000_000 }),
    });
    await expect(policyStore.save(base())).resolves.toBeTruthy();
  });
});

// ─── get ──────────────────────────────────────────────────────────────────────

describe('get', () => {
  it('returns null for unknown id', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('returns the saved artifact', async () => {
    const a = await store.save(base());
    const fetched = await store.get(a.id);
    expect(fetched).toEqual(a);
  });
});

// ─── update ───────────────────────────────────────────────────────────────────

describe('update', () => {
  it('increments version and sets updatedAt', async () => {
    const a = await store.save(base());
    const updated = await store.update(a.id, { data: 'world' }, 'updated greeting');
    expect(updated.version).toBe(2);
    expect(updated.data).toBe('world');
    expect(updated.updatedAt).toBeTruthy();
    expect(updated.id).toBe(a.id);         // id is immutable
    expect(updated.createdAt).toBe(a.createdAt); // createdAt is immutable
  });

  it('creates a second version record', async () => {
    const a = await store.save(base());
    await store.update(a.id, { data: 'v2 data' }, 'second');
    const versions = await store.getVersions(a.id);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.version).toBe(2);
    expect(versions[1]!.data).toBe('v2 data');
    expect(versions[1]!.changelog).toBe('second');
  });

  it('allows multiple consecutive updates', async () => {
    const a = await store.save(base());
    await store.update(a.id, { data: 'v2' });
    await store.update(a.id, { data: 'v3' });
    const latest = await store.get(a.id);
    expect(latest?.version ?? 0).toBe(3);
    const versions = await store.getVersions(a.id);
    expect(versions).toHaveLength(3);
  });

  it('throws on nonexistent artifact', async () => {
    await expect(store.update('ghost', { data: 'x' })).rejects.toThrow(/not found/i);
  });

  it('throws on update violating policy', async () => {
    const policyStore = createInMemoryArtifactStore({
      policy: createArtifactPolicy({ name: 'tiny', maxSizeBytes: 5 }),
    });
    const a = await policyStore.save(base({ data: 'hi' }));
    await expect(
      policyStore.update(a.id, { data: 'this is now way too long' }),
    ).rejects.toThrow(/policy violation/i);
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('returns all artifacts when no filter', async () => {
    await store.save(base());
    await store.save(base({ name: 'b', type: 'json', mimeType: 'application/json' }));
    const all = await store.list();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by single type', async () => {
    await store.save(base({ type: 'json', mimeType: 'application/json' }));
    await store.save(base({ type: 'csv', mimeType: 'text/csv' }));
    const jsonOnly = await store.list({ type: 'json' });
    expect(jsonOnly.every((a) => a.type === 'json')).toBe(true);
  });

  it('filters by array of types', async () => {
    await store.save(base({ type: 'json', mimeType: 'application/json' }));
    await store.save(base({ type: 'csv', mimeType: 'text/csv' }));
    await store.save(base({ type: 'html', mimeType: 'text/html' }));
    const results = await store.list({ type: ['json', 'csv'] });
    expect(results.every((a) => ['json', 'csv'].includes(a.type))).toBe(true);
  });

  it('filters by sessionId', async () => {
    await store.save(base({ sessionId: 'sess-A' }));
    await store.save(base({ sessionId: 'sess-B' }));
    const results = await store.list({ sessionId: 'sess-A' });
    expect(results.every((a) => a.sessionId === 'sess-A')).toBe(true);
  });

  it('filters by userId', async () => {
    await store.save(base({ userId: 'user-1', scope: 'user' }));
    await store.save(base({ userId: 'user-2', scope: 'user' }));
    const results = await store.list({ userId: 'user-1' });
    expect(results.every((a) => a.userId === 'user-1')).toBe(true);
  });

  it('filters by scope', async () => {
    await store.save(base({ scope: 'user', userId: 'u-1' }));
    await store.save(base({ scope: 'session', sessionId: 's-1' }));
    const userScoped = await store.list({ scope: 'user' });
    expect(userScoped.every((a) => a.scope === 'user')).toBe(true);
  });

  it('filters by tags (AND semantics)', async () => {
    await store.save(base({ tags: ['ml', 'forecast'] }));
    await store.save(base({ tags: ['ml'] }));
    await store.save(base({ tags: ['forecast'] }));
    const both = await store.list({ tags: ['ml', 'forecast'] });
    expect(both.every((a) => (a.tags ?? []).includes('ml') && (a.tags ?? []).includes('forecast'))).toBe(true);
  });

  it('filters by runId and agentId', async () => {
    await store.save(base({ runId: 'run-1', agentId: 'agent-X' }));
    await store.save(base({ runId: 'run-2', agentId: 'agent-Y' }));
    const r = await store.list({ runId: 'run-1' });
    expect(r.every((a) => a.runId === 'run-1')).toBe(true);
  });

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) await store.save(base({ name: `item-${i}` }));
    const page1 = await store.list({ limit: 2 });
    expect(page1.length).toBe(2);
    const page2 = await store.list({ limit: 2, offset: 2 });
    expect(page2.length).toBe(2);
    // pages should not overlap
    const ids1 = new Set(page1.map((a) => a.id));
    const ids2 = new Set(page2.map((a) => a.id));
    expect([...ids1].every((id) => !ids2.has(id))).toBe(true);
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe('delete', () => {
  it('removes the artifact and its versions', async () => {
    const a = await store.save(base());
    await store.delete(a.id);
    expect(await store.get(a.id)).toBeNull();
    expect(await store.getVersions(a.id)).toHaveLength(0);
  });

  it('is a no-op for nonexistent id', async () => {
    await expect(store.delete('ghost')).resolves.not.toThrow();
  });
});

// ─── getVersions ──────────────────────────────────────────────────────────────

describe('getVersions', () => {
  it('returns empty array for unknown artifact', async () => {
    expect(await store.getVersions('ghost')).toEqual([]);
  });

  it('version records accumulate on update', async () => {
    const a = await store.save(base());
    await store.update(a.id, { data: 'v2' });
    await store.update(a.id, { data: 'v3' });
    const vers = await store.getVersions(a.id);
    expect(vers.map((v) => v.version)).toEqual([1, 2, 3]);
  });
});
