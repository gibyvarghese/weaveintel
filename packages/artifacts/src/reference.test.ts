import { describe, it, expect, beforeEach } from 'vitest';
import { createArtifactReference, resolveReference, tryResolveReference, formatReference } from './reference.js';
import { createInMemoryArtifactStore } from './store.js';
import type { ArtifactStore } from '@weaveintel/core';

let store: ArtifactStore;
beforeEach(() => { store = createInMemoryArtifactStore(); });

const base = () => ({
  name: 'report',
  type: 'text' as const,
  mimeType: 'text/plain',
  data: 'v1 content',
  version: 1,
  scope: 'session' as const,
});

// ─── createArtifactReference ──────────────────────────────────────────────────

describe('createArtifactReference', () => {
  it('creates reference with all fields', () => {
    const ref = createArtifactReference('art-1', 2, 'My Report');
    expect(ref.artifactId).toBe('art-1');
    expect(ref.version).toBe(2);
    expect(ref.label).toBe('My Report');
  });

  it('creates unversioned reference', () => {
    const ref = createArtifactReference('art-1');
    expect(ref.version).toBeUndefined();
    expect(ref.label).toBeUndefined();
  });
});

// ─── resolveReference ────────────────────────────────────────────────────────

describe('resolveReference', () => {
  it('resolves to latest artifact when no version is specified', async () => {
    const a = await store.save(base());
    const ref = createArtifactReference(a.id);
    const resolved = await resolveReference(store, ref);
    expect(resolved.id).toBe(a.id);
    expect(resolved.data).toBe('v1 content');
  });

  it('resolves pinned version 1', async () => {
    const a = await store.save(base());
    await store.update(a.id, { data: 'v2 content' });
    const ref = createArtifactReference(a.id, 1);
    const resolved = await resolveReference(store, ref);
    expect(resolved.version).toBe(1);
    expect(resolved.data).toBe('v1 content');
  });

  it('resolves pinned version 2', async () => {
    const a = await store.save(base());
    await store.update(a.id, { data: 'v2 content' }, 'updated');
    const ref = createArtifactReference(a.id, 2);
    const resolved = await resolveReference(store, ref);
    expect(resolved.version).toBe(2);
    expect(resolved.data).toBe('v2 content');
  });

  it('throws when artifact does not exist', async () => {
    const ref = createArtifactReference('nonexistent');
    await expect(resolveReference(store, ref)).rejects.toThrow(/not found/i);
  });

  it('throws when pinned version does not exist (not silent fallback)', async () => {
    const a = await store.save(base());
    const ref = createArtifactReference(a.id, 99);
    await expect(resolveReference(store, ref)).rejects.toThrow(/version 99 not found/i);
  });
});

// ─── tryResolveReference ─────────────────────────────────────────────────────

describe('tryResolveReference', () => {
  it('returns null for nonexistent artifact', async () => {
    const ref = createArtifactReference('ghost');
    expect(await tryResolveReference(store, ref)).toBeNull();
  });

  it('returns null for missing pinned version', async () => {
    const a = await store.save(base());
    const ref = createArtifactReference(a.id, 99);
    expect(await tryResolveReference(store, ref)).toBeNull();
  });

  it('returns artifact when it exists', async () => {
    const a = await store.save(base());
    const ref = createArtifactReference(a.id);
    const result = await tryResolveReference(store, ref);
    expect(result?.id).toBe(a.id);
  });
});

// ─── formatReference ─────────────────────────────────────────────────────────

describe('formatReference', () => {
  it('formats without version or label', () => {
    expect(formatReference({ artifactId: 'art-abc' })).toBe('artifact:art-abc');
  });

  it('formats with version', () => {
    expect(formatReference({ artifactId: 'art-abc', version: 3 })).toBe('artifact:art-abc@v3');
  });

  it('formats with label', () => {
    expect(formatReference({ artifactId: 'art-abc', label: 'My Report' })).toBe('artifact:art-abc (My Report)');
  });

  it('formats with version and label', () => {
    expect(formatReference({ artifactId: 'art-abc', version: 2, label: 'Final Draft' })).toBe('artifact:art-abc@v2 (Final Draft)');
  });
});
