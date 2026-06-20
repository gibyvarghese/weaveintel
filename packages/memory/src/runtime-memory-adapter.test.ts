/**
 * Phase 5 — `createRuntimeMemoryAdapter` unit tests.
 *
 * Verifies the structural shape and delegation behaviour of the adapter
 * without hitting any I/O backends.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRuntimeMemoryAdapter } from './runtime-memory-adapter.js';
import type { SemanticMemory, WorkingMemory, MemoryStore, ExecutionContext } from '@weaveintel/core';

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return { executionId: 'test-exec', metadata: {}, ...overrides };
}

function makeSemanticMemory(): SemanticMemory & { _stored: string[]; _recalled: string[] } {
  const _stored: string[] = [];
  const _recalled: string[] = [];
  return {
    _stored,
    _recalled,
    async store(_ctx, content) { _stored.push(content); },
    async recall(_ctx, query) { _recalled.push(query); return []; },
  };
}

function makeWorkingMemory(): WorkingMemory {
  const snap = { id: 'wm-1', agentId: 'agent', content: {}, createdAt: new Date().toISOString() };
  return {
    async patch() { return snap; },
    async checkpoint() { return snap; },
    async restore() { return null; },
    async getCurrent() { return null; },
  };
}

function makeStore(): MemoryStore & { _written: number } {
  let _written = 0;
  return {
    get _written() { return _written; },
    async write(_ctx, entries) { _written += entries.length; },
    async query() { return []; },
    async delete() { /* noop */ },
    async clear() { /* noop */ },
  };
}

describe('createRuntimeMemoryAdapter — structural shape', () => {
  it('exposes semantic, working, store, and consolidate', () => {
    const slot = createRuntimeMemoryAdapter({
      semantic: makeSemanticMemory(),
      working: makeWorkingMemory(),
      store: makeStore(),
    });
    expect(typeof slot.semantic.store).toBe('function');
    expect(typeof slot.semantic.recall).toBe('function');
    expect(typeof slot.working.patch).toBe('function');
    expect(typeof slot.store.write).toBe('function');
    expect(typeof slot.consolidate).toBe('function');
  });

  it('delegates semantic.store to the provided SemanticMemory', async () => {
    const semantic = makeSemanticMemory();
    const slot = createRuntimeMemoryAdapter({
      semantic,
      working: makeWorkingMemory(),
      store: makeStore(),
    });
    const ctx = makeCtx();
    await slot.semantic.store(ctx, 'my fact');
    expect(semantic._stored).toContain('my fact');
  });

  it('delegates semantic.recall to the provided SemanticMemory', async () => {
    const semantic = makeSemanticMemory();
    const slot = createRuntimeMemoryAdapter({
      semantic,
      working: makeWorkingMemory(),
      store: makeStore(),
    });
    const ctx = makeCtx();
    await slot.semantic.recall(ctx, 'my query');
    expect(semantic._recalled).toContain('my query');
  });

  it('consolidate is a no-op when no consolidate fn is given', async () => {
    const slot = createRuntimeMemoryAdapter({
      semantic: makeSemanticMemory(),
      working: makeWorkingMemory(),
      store: makeStore(),
    });
    await expect(slot.consolidate('user-xyz')).resolves.toBeUndefined();
  });

  it('consolidate delegates to the provided fn', async () => {
    const calls: string[] = [];
    const slot = createRuntimeMemoryAdapter({
      semantic: makeSemanticMemory(),
      working: makeWorkingMemory(),
      store: makeStore(),
      consolidate: async (userId) => { calls.push(userId); },
    });
    await slot.consolidate('user-abc');
    expect(calls).toContain('user-abc');
  });

  it('slot.store.write delegates write count to the store', async () => {
    const store = makeStore();
    const slot = createRuntimeMemoryAdapter({
      semantic: makeSemanticMemory(),
      working: makeWorkingMemory(),
      store,
    });
    const ctx = makeCtx();
    await slot.store.write(ctx, [
      { id: '1', type: 'semantic', content: 'a', metadata: {}, createdAt: new Date().toISOString() },
      { id: '2', type: 'episodic', content: 'b', metadata: {}, createdAt: new Date().toISOString() },
    ]);
    expect(store._written).toBe(2);
  });

  it('working.getCurrent returns null for an unknown agent', async () => {
    const slot = createRuntimeMemoryAdapter({
      semantic: makeSemanticMemory(),
      working: makeWorkingMemory(),
      store: makeStore(),
    });
    const ctx = makeCtx();
    const snap = await slot.working.getCurrent(ctx, 'unknown-agent');
    expect(snap).toBeNull();
  });
});
