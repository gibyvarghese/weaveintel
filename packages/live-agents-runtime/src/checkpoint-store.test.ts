/**
 * Phase 7 — unit tests for LiveAgentCheckpointStore implementations.
 */

import { describe, it, expect } from 'vitest';
import {
  createInMemoryLiveAgentCheckpointStore,
  createDurableLiveAgentCheckpointStore,
} from './checkpoint-store.js';
import type { RuntimeKvStore } from '@weaveintel/core';

function makeKv(): RuntimeKvStore {
  const map = new Map<string, string>();
  return {
    async get(key) { return map.get(key); },
    async set(key, value) { map.set(key, value); },
    async delete(key) { const had = map.has(key); map.delete(key); return had; },
    async list(prefix) {
      const result: { key: string; value: string }[] = [];
      for (const [k, v] of map) if (k.startsWith(prefix)) result.push({ key: k, value: v });
      return result;
    },
  };
}

describe.each([
  ['in-memory', () => createInMemoryLiveAgentCheckpointStore()],
  ['durable (KV)', () => createDurableLiveAgentCheckpointStore(makeKv())],
] as const)('%s checkpoint store', (_name, factory) => {
  it('load returns null for an unseen agent', async () => {
    const store = factory();
    expect(await store.load('agent-1')).toBeNull();
  });

  it('save then load round-trips the checkpoint', async () => {
    const store = factory();
    await store.save('agent-2', 3, { last: 'foo' });
    const cp = await store.load('agent-2');
    expect(cp).not.toBeNull();
    expect(cp!.stepIndex).toBe(3);
    expect(cp!.state).toEqual({ last: 'foo' });
    expect(typeof cp!.savedAt).toBe('number');
  });

  it('clear removes the checkpoint', async () => {
    const store = factory();
    await store.save('agent-3', 1, null);
    await store.clear('agent-3');
    expect(await store.load('agent-3')).toBeNull();
  });

  it('agents are independent', async () => {
    const store = factory();
    await store.save('a', 1, 'state-a');
    await store.save('b', 2, 'state-b');
    const a = await store.load('a');
    const b = await store.load('b');
    expect(a!.stepIndex).toBe(1);
    expect(b!.stepIndex).toBe(2);
  });

  it('overwriting a checkpoint updates the step index', async () => {
    const store = factory();
    await store.save('agent-4', 1, 'first');
    await store.save('agent-4', 2, 'second');
    const cp = await store.load('agent-4');
    expect(cp!.stepIndex).toBe(2);
    expect(cp!.state).toBe('second');
  });
});
