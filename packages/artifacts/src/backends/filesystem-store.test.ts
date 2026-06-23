/**
 * Filesystem ArtifactStore — comprehensive unit tests.
 *
 * Uses a real temporary directory (os.tmpdir()) so no mocking needed.
 * Each test creates a unique subdirectory via a UUID suffix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createFilesystemArtifactStore } from './filesystem-store.js';
import { createArtifactPolicy } from '../policy.js';
import type { ArtifactStore } from '@weaveintel/core';

let store: ArtifactStore;
let tmpDir: string;

function makeTmpDir(): string {
  const d = path.join(os.tmpdir(), `artifact-fs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  store = createFilesystemArtifactStore(tmpDir);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const base = (overrides: object = {}) => ({
  name: 'test-artifact',
  type: 'text' as const,
  mimeType: 'text/plain',
  data: 'hello world',
  version: 1,
  scope: 'session' as const,
  ...overrides,
});

// ─── save ─────────────────────────────────────────────────────────────────────

describe('save', () => {
  it('assigns a UUID id and createdAt', async () => {
    const a = await store.save(base());
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(a.createdAt).toBeTruthy();
  });

  it('writes meta.json to disk', async () => {
    const a = await store.save(base());
    const metaFile = path.join(tmpDir, a.id, 'meta.json');
    expect(fs.existsSync(metaFile)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    expect(meta.id).toBe(a.id);
    expect(meta.name).toBe('test-artifact');
  });

  it('writes version 1 text file to disk', async () => {
    const a = await store.save(base());
    const vFile = path.join(tmpDir, a.id, 'v1.txt');
    expect(fs.existsSync(vFile)).toBe(true);
    expect(fs.readFileSync(vFile, 'utf8')).toBe('hello world');
  });

  it('writes binary data as .dat file', async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic bytes
    const a = await store.save(base({ type: 'image', mimeType: 'image/jpeg', data: buf }));
    const vFile = path.join(tmpDir, a.id, 'v1.dat');
    expect(fs.existsSync(vFile)).toBe(true);
    const read = fs.readFileSync(vFile);
    expect(read.slice(0, 4)).toEqual(buf);
  });

  it('writes JSON object as text file', async () => {
    const data = { key: 'value', count: 42 };
    const a = await store.save(base({ type: 'json', mimeType: 'application/json', data }));
    const vFile = path.join(tmpDir, a.id, 'v1.txt');
    expect(fs.existsSync(vFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(vFile, 'utf8'))).toEqual(data);
  });

  it('adds entry to _index.json', async () => {
    const a = await store.save(base());
    const index = JSON.parse(fs.readFileSync(path.join(tmpDir, '_index.json'), 'utf8'));
    const entry = index.find((e: { id: string }) => e.id === a.id);
    expect(entry).toBeDefined();
    expect(entry.name).toBe('test-artifact');
  });

  it('creates base directory if it does not exist', async () => {
    const newDir = path.join(tmpDir, 'nested', 'store');
    const s = createFilesystemArtifactStore(newDir);
    expect(fs.existsSync(newDir)).toBe(true);
    const a = await s.save(base());
    expect(a.id).toBeTruthy();
  });

  it('defaults scope to session', async () => {
    const a = await store.save({ name: 'x', type: 'text', mimeType: 'text/plain', data: 'x', version: 1 });
    expect(a.scope ?? 'session').toBe('session');
  });

  it('persists sessionId and userId', async () => {
    const a = await store.save(base({ sessionId: 'sess-1', userId: 'alice' }));
    const fetched = await store.get(a.id);
    expect(fetched?.sessionId).toBe('sess-1');
    expect(fetched?.userId).toBe('alice');
  });

  it('persists tags', async () => {
    const a = await store.save(base({ tags: ['alpha', 'beta'] }));
    const fetched = await store.get(a.id);
    expect(fetched?.tags).toEqual(['alpha', 'beta']);
  });
});

// ─── get ──────────────────────────────────────────────────────────────────────

describe('get', () => {
  it('returns null for unknown id', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('returns the artifact with correct data', async () => {
    const a = await store.save(base({ data: 'round-trip' }));
    const fetched = await store.get(a.id);
    expect(fetched?.data).toBe('round-trip');
    expect(fetched?.name).toBe('test-artifact');
  });

  it('returns JSON object data correctly', async () => {
    const obj = { x: 1, y: [2, 3] };
    const a = await store.save(base({ type: 'json', mimeType: 'application/json', data: obj }));
    const fetched = await store.get(a.id);
    expect(fetched?.data).toEqual(obj);
  });
});

// ─── update ───────────────────────────────────────────────────────────────────

describe('update', () => {
  it('increments version and updates data', async () => {
    const a = await store.save(base({ data: 'v1' }));
    const updated = await store.update(a.id, { data: 'v2' }, 'second version');
    expect(updated.version).toBe(2);
    const fetched = await store.get(a.id);
    expect(fetched?.data).toBe('v2');
    expect(fetched?.version).toBe(2);
  });

  it('writes v2 file to disk', async () => {
    const a = await store.save(base({ data: 'v1' }));
    await store.update(a.id, { data: 'v2 content' });
    expect(fs.existsSync(path.join(tmpDir, a.id, 'v2.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, a.id, 'v2.txt'), 'utf8')).toBe('v2 content');
  });

  it('writes changelog sidecar file', async () => {
    const a = await store.save(base({ data: 'v1' }));
    await store.update(a.id, { data: 'v2' }, 'fixed typo');
    expect(fs.existsSync(path.join(tmpDir, a.id, 'v2.changelog.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, a.id, 'v2.changelog.txt'), 'utf8')).toBe('fixed typo');
  });

  it('updates _index.json with new version', async () => {
    const a = await store.save(base({ data: 'v1' }));
    await store.update(a.id, { data: 'v2' });
    const index = JSON.parse(fs.readFileSync(path.join(tmpDir, '_index.json'), 'utf8'));
    const entry = index.find((e: { id: string }) => e.id === a.id);
    expect(entry.version).toBe(2);
  });

  it('throws on missing artifact', async () => {
    await expect(store.update('ghost', { data: 'x' })).rejects.toThrow('not found');
  });

  it('patches name without touching data', async () => {
    const a = await store.save(base({ data: 'keep-me' }));
    const updated = await store.update(a.id, { name: 'new-name' });
    expect(updated.name).toBe('new-name');
    expect(updated.data).toBe('keep-me');
  });
});

// ─── list ─────────────────────────────────────────────────────────────────────

describe('list', () => {
  it('returns empty array when no artifacts exist', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('lists all saved artifacts', async () => {
    await store.save(base({ name: 'a1' }));
    await store.save(base({ name: 'a2' }));
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('filters by type', async () => {
    await store.save(base({ type: 'csv', mimeType: 'text/csv' }));
    await store.save(base({ type: 'json', mimeType: 'application/json' }));
    expect(await store.list({ type: 'csv' })).toHaveLength(1);
    expect(await store.list({ type: ['csv', 'json'] })).toHaveLength(2);
  });

  it('filters by sessionId', async () => {
    await store.save(base({ sessionId: 'sess-A' }));
    await store.save(base({ sessionId: 'sess-B' }));
    expect(await store.list({ sessionId: 'sess-A' })).toHaveLength(1);
  });

  it('filters by userId', async () => {
    await store.save(base({ userId: 'alice' }));
    await store.save(base({ userId: 'bob' }));
    expect(await store.list({ userId: 'alice' })).toHaveLength(1);
  });

  it('filters by scope', async () => {
    await store.save(base({ scope: 'session' }));
    await store.save(base({ scope: 'user' }));
    expect(await store.list({ scope: 'user' })).toHaveLength(1);
  });

  it('filters by tags (AND semantics)', async () => {
    await store.save(base({ tags: ['alpha', 'beta'] }));
    await store.save(base({ tags: ['alpha', 'gamma'] }));
    expect(await store.list({ tags: ['alpha'] })).toHaveLength(2);
    expect(await store.list({ tags: ['alpha', 'beta'] })).toHaveLength(1);
    expect(await store.list({ tags: ['delta'] })).toHaveLength(0);
  });

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) await store.save(base({ name: `a${i}` }));
    expect(await store.list({ limit: 2 })).toHaveLength(2);
    expect(await store.list({ limit: 2, offset: 2 })).toHaveLength(2);
    expect(await store.list({ limit: 10, offset: 3 })).toHaveLength(2);
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe('delete', () => {
  it('removes artifact directory from disk', async () => {
    const a = await store.save(base());
    const dir = path.join(tmpDir, a.id);
    expect(fs.existsSync(dir)).toBe(true);
    await store.delete(a.id);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes entry from _index.json', async () => {
    const a = await store.save(base());
    await store.delete(a.id);
    const index = JSON.parse(fs.readFileSync(path.join(tmpDir, '_index.json'), 'utf8'));
    expect(index.find((e: { id: string }) => e.id === a.id)).toBeUndefined();
  });

  it('get returns null after delete', async () => {
    const a = await store.save(base());
    await store.delete(a.id);
    expect(await store.get(a.id)).toBeNull();
  });

  it('is idempotent — no throw on second delete', async () => {
    const a = await store.save(base());
    await store.delete(a.id);
    await expect(store.delete(a.id)).resolves.toBeUndefined();
  });
});

// ─── getVersions ──────────────────────────────────────────────────────────────

describe('getVersions', () => {
  it('returns empty array for missing artifact', async () => {
    expect(await store.getVersions('ghost')).toEqual([]);
  });

  it('returns one version after save', async () => {
    const a = await store.save(base({ data: 'v1' }));
    const versions = await store.getVersions(a.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(1);
    expect(versions[0]!.data).toBe('v1');
  });

  it('returns two versions after update', async () => {
    const a = await store.save(base({ data: 'v1' }));
    await store.update(a.id, { data: 'v2' }, 'updated');
    const versions = await store.getVersions(a.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.version).toBe(1);
    expect(versions[1]!.version).toBe(2);
    expect(versions[1]!.changelog).toBe('updated');
  });
});

// ─── policy enforcement ───────────────────────────────────────────────────────

describe('policy enforcement', () => {
  it('throws on oversized artifact when policy is set', async () => {
    const policy = createArtifactPolicy({ name: 'tiny-fs', maxSizeBytes: 10 });
    const s = createFilesystemArtifactStore(makeTmpDir(), { policy });
    await expect(
      s.save(base({ data: 'this is more than ten bytes' })),
    ).rejects.toThrow(/policy violation/i);
  });

  it('throws on update that violates policy', async () => {
    const policy = createArtifactPolicy({ name: 'tiny-fs-update', maxSizeBytes: 10 });
    const s = createFilesystemArtifactStore(makeTmpDir(), { policy });
    // save a small artifact first (no policy path — create store without policy)
    const plain = createFilesystemArtifactStore(makeTmpDir());
    const a = await plain.save(base({ data: 'ok' }));
    // Manually copy the artifact to the policy store's tmpDir so we can test update
    // (Simpler: use the same store — create one fresh store with policy, save small, then update big)
    const policyDir = makeTmpDir();
    const sp = createFilesystemArtifactStore(policyDir, { policy });
    const saved = await sp.save(base({ data: 'small' }));
    await expect(sp.update(saved.id, { data: 'this is way too big for the policy' })).rejects.toThrow(/policy violation/i);
  });
});

// ─── factory (createArtifactStore) ────────────────────────────────────────────

describe('createArtifactStore({ backend: "filesystem" })', () => {
  it('creates a working filesystem store via the factory', async () => {
    const { createArtifactStore } = await import('./factory.js');
    const dir = makeTmpDir();
    const s = await createArtifactStore({ backend: 'filesystem', path: dir });
    const a = await s.save(base({ name: 'factory-test' }));
    expect(a.id).toBeTruthy();
    expect(fs.existsSync(path.join(dir, a.id, 'meta.json'))).toBe(true);
  });
});

// ─── negative / edge cases ────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty string data', async () => {
    const a = await store.save(base({ data: '' }));
    expect((await store.get(a.id))?.data).toBe('');
  });

  it('handles null data', async () => {
    const a = await store.save(base({ data: null }));
    const fetched = await store.get(a.id);
    // null serializes as empty string then becomes '' or null depending on json parse
    expect(fetched).not.toBeNull();
  });

  it('handles artifact name with special characters in filename', async () => {
    const a = await store.save(base({ name: 'My Report: Q3/2025 <draft>' }));
    expect(a.id).toBeTruthy();
    expect(fs.existsSync(path.join(tmpDir, a.id, 'meta.json'))).toBe(true);
  });

  it('multiple independent saves do not collide', async () => {
    const a1 = await store.save(base({ name: 'alpha' }));
    const a2 = await store.save(base({ name: 'beta' }));
    expect(a1.id).not.toBe(a2.id);
    expect((await store.get(a1.id))?.name).toBe('alpha');
    expect((await store.get(a2.id))?.name).toBe('beta');
  });
});
