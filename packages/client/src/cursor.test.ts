/**
 * Unit tests — RunCursorStore (refresh-proof resume cursor).
 * Positive · window · negative · security/robustness.
 */
import { describe, it, expect } from 'vitest';
import { createRunCursorStore, isCursorResumable, type RunCursor } from './cursor.js';
import { MemoryStorage } from './outbox.js';

describe('createRunCursorStore', () => {
  it('sets and gets a cursor, stamping updatedAt', async () => {
    const store = createRunCursorStore({ now: () => 1000 });
    const saved = await store.set({ runId: 'r1', lastSequence: 7, surface: 'web' });
    expect(saved).toEqual({ runId: 'r1', lastSequence: 7, surface: 'web', updatedAt: 1000 });
    expect(await store.get('r1')).toEqual(saved);
  });

  it('upserts (latest write wins)', async () => {
    let t = 1000;
    const store = createRunCursorStore({ now: () => t });
    await store.set({ runId: 'r1', lastSequence: 1 });
    t = 2000;
    await store.set({ runId: 'r1', lastSequence: 42 });
    expect((await store.get('r1'))?.lastSequence).toBe(42);
    expect((await store.get('r1'))?.updatedAt).toBe(2000);
  });

  it('clear removes a single cursor', async () => {
    const store = createRunCursorStore();
    await store.set({ runId: 'r1', lastSequence: 1 });
    await store.clear('r1');
    expect(await store.get('r1')).toBeNull();
  });

  it('list returns cursors newest-first; latest picks the freshest', async () => {
    let t = 0;
    const store = createRunCursorStore({ now: () => t });
    t = 100; await store.set({ runId: 'old', lastSequence: 1 });
    t = 300; await store.set({ runId: 'new', lastSequence: 1 });
    t = 200; await store.set({ runId: 'mid', lastSequence: 1 });
    expect((await store.list()).map((c) => c.runId)).toEqual(['new', 'mid', 'old']);
    expect((await store.latest())?.runId).toBe('new');
  });

  it('clearAll empties the store but leaves unrelated keys', async () => {
    const storage = new MemoryStorage();
    storage.setItem('unrelated', 'keep-me');
    const store = createRunCursorStore({ storage });
    await store.set({ runId: 'r1', lastSequence: 1 });
    await store.set({ runId: 'r2', lastSequence: 1 });
    await store.clearAll();
    expect(await store.list()).toEqual([]);
    expect(storage.getItem('unrelated')).toBe('keep-me');
  });

  it('returns null for an unknown run', async () => {
    expect(await createRunCursorStore().get('nope')).toBeNull();
  });

  it('ignores corrupt / partial entries instead of throwing', async () => {
    const storage = new MemoryStorage();
    storage.setItem('__weave_cursor__:bad', '{not json');
    storage.setItem('__weave_cursor__:partial', JSON.stringify({ runId: 'x' })); // missing fields
    const store = createRunCursorStore({ storage });
    expect(await store.get('bad')).toBeNull();
    expect(await store.get('partial')).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  it('isolates cursor keys from other prefixed data', async () => {
    const storage = new MemoryStorage();
    storage.setItem('__weave_outbox__:x', JSON.stringify({ id: 'x', kind: 'start' }));
    const store = createRunCursorStore({ storage });
    await store.set({ runId: 'r1', lastSequence: 1 });
    expect((await store.list()).map((c) => c.runId)).toEqual(['r1']);
  });
});

describe('isCursorResumable', () => {
  const cur = (updatedAt: number): RunCursor => ({ runId: 'r', lastSequence: 1, updatedAt });

  it('is resumable inside the window', () => {
    expect(isCursorResumable(cur(1000), 900_000, 1000 + 800_000)).toBe(true);
  });
  it('is not resumable past the window', () => {
    expect(isCursorResumable(cur(1000), 900_000, 1000 + 900_001)).toBe(false);
  });
  it('is resumable exactly at the window edge', () => {
    expect(isCursorResumable(cur(1000), 900_000, 1000 + 900_000)).toBe(true);
  });
  it('window of 0 disables enforcement (always resumable)', () => {
    expect(isCursorResumable(cur(1000), 0, 10_000_000_000)).toBe(true);
  });
});
