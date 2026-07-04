/**
 * Unit tests — Collaboration Phase 1 presence in the client reducer.
 * snapshot replace · sequence-dedup bypass · independence from journal state.
 */
import { describe, it, expect } from 'vitest';
import { streamReducer, emptyRunViewModel, type RunViewModel } from './reducer.js';
import type { RunEventEnvelope } from '@weaveintel/core';

function presence(seq: number, users: string[]): RunEventEnvelope {
  return {
    runId: 'r', sequence: seq, kind: 'presence.update',
    payload: { participants: users.map((u) => ({ userId: u, displayName: u, presence: 'online', peerType: 'human' })) },
  } as RunEventEnvelope;
}
function fold(events: RunEventEnvelope[]): RunViewModel {
  let vm = emptyRunViewModel();
  for (const e of events) vm = streamReducer(vm, e);
  return vm;
}

describe('reducer — presence', () => {
  it('starts with empty presence', () => {
    expect(emptyRunViewModel().presence).toEqual([]);
  });

  it('replaces the whole presence set on each update (snapshot)', () => {
    const vm = fold([
      presence(-1, ['alice']),
      presence(-1, ['alice', 'bob']),
      presence(-1, ['bob']), // alice left
    ]);
    expect(vm.presence.map((p) => p.userId)).toEqual(['bob']);
  });

  it('applies presence.update even though it carries sequence -1 (bypasses dedup)', () => {
    // Advance the journal sequence well past -1, then a presence.update still applies.
    let vm = emptyRunViewModel();
    vm = streamReducer(vm, { runId: 'r', sequence: 10, kind: 'text.delta', payload: { delta: 'hi' } } as RunEventEnvelope);
    expect(vm.sequence).toBe(10);
    vm = streamReducer(vm, presence(-1, ['alice']));
    expect(vm.presence.map((p) => p.userId)).toEqual(['alice']);
    expect(vm.sequence).toBe(10); // presence does NOT advance the journal cursor
    expect(vm.fullText).toBe('hi'); // journal state untouched
  });

  it('surfaces an agent peer in the snapshot', () => {
    const vm = streamReducer(emptyRunViewModel(), {
      runId: 'r', sequence: -1, kind: 'presence.update',
      payload: { participants: [{ userId: 'alice', displayName: 'Alice', presence: 'online', peerType: 'human' }, { userId: '__agent', displayName: 'Agent', presence: 'working', peerType: 'agent' }] },
    } as RunEventEnvelope);
    expect(vm.presence.find((p) => p.peerType === 'agent')?.presence).toBe('working');
  });

  it('tolerates a malformed presence payload (no participants array)', () => {
    const vm = streamReducer(emptyRunViewModel(), { runId: 'r', sequence: -1, kind: 'presence.update', payload: {} } as RunEventEnvelope);
    expect(vm.presence).toEqual([]);
  });

  it('does not mutate the previous view model (purity)', () => {
    const a = fold([presence(-1, ['alice'])]);
    const b = streamReducer(a, presence(-1, ['alice', 'bob']));
    expect(a.presence.length).toBe(1);
    expect(b.presence.length).toBe(2);
    expect(b).not.toBe(a);
  });
});
