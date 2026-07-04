// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInMemoryHandoffManager,
  canTransition,
  isTerminalHandoffState,
  type UnifiedHandoffManager,
} from './unified-handoff.js';
import { handoffManagerContract } from './unified-handoff-contract.js';

handoffManagerContract(() => createInMemoryHandoffManager(), { describe, it, beforeEach, expect } as never);

describe('handoff state-machine helpers', () => {
  it('canTransition encodes the lifecycle', () => {
    expect(canTransition('requested', 'accepted')).toBe(true);
    expect(canTransition('requested', 'in_progress')).toBe(false);
    expect(canTransition('accepted', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'handed_back')).toBe(true);
    expect(canTransition('completed', 'in_progress')).toBe(false);
  });
  it('isTerminalHandoffState', () => {
    expect(isTerminalHandoffState('completed')).toBe(true);
    expect(isTerminalHandoffState('rejected')).toBe(true);
    expect(isTerminalHandoffState('in_progress')).toBe(false);
  });
});

describe('UnifiedHandoffManager — security & stress (in-memory)', () => {
  let mgr: UnifiedHandoffManager;
  beforeEach(() => { mgr = createInMemoryHandoffManager(); });

  async function req(over = {}) {
    return mgr.request({ id: `h-${Math.random().toString(36).slice(2)}`, runId: 'r1', tenantId: 'tA', scope: 'user_to_user', fromActor: { type: 'user', id: 'alice' }, toActor: { type: 'user', id: 'bob' }, reason: 'cover for me', ...over });
  }

  it('a non-participant can neither complete nor fail', async () => {
    const h = await req();
    await mgr.accept(h.id, 'bob');
    await mgr.start(h.id, 'bob');
    await expect(mgr.complete(h.id, 'mallory')).rejects.toThrow();
    await expect(mgr.fail(h.id, 'mallory', 'x')).rejects.toThrow();
  });

  it('audit is append-only and ordered across many transitions', async () => {
    const h = await req();
    await mgr.accept(h.id, 'bob');
    await mgr.start(h.id, 'bob');
    await mgr.handBack(h.id, 'bob', { summary: 'done' });
    await mgr.complete(h.id, 'alice');
    const trail = await mgr.audit(h.id);
    expect(trail.map((e) => e.toState)).toEqual(['requested', 'accepted', 'in_progress', 'handed_back', 'completed']);
    // every event carries an actor + timestamp
    expect(trail.every((e) => e.actorId && typeof e.at === 'number')).toBe(true);
  });

  it('handles many concurrent handoffs on one run', async () => {
    const ids = [];
    for (let i = 0; i < 100; i++) ids.push((await req({ id: `h${i}` })).id);
    expect((await mgr.listForRun('r1')).length).toBe(100);
    // accept+reject half each
    for (let i = 0; i < 100; i++) {
      if (i % 2 === 0) await mgr.accept(`h${i}`, 'bob');
      else await mgr.reject(`h${i}`, 'bob', 'busy');
    }
    const inbox = await mgr.listForActor('bob');
    expect(inbox.length).toBe(100);
  });

  it('agent_to_agent scope carries referenceTaskIds (A2A interop)', async () => {
    const h = await mgr.request({ id: 'h1', runId: 'r1', tenantId: 'tA', scope: 'agent_to_agent', fromActor: { type: 'agent', id: 'planner' }, toActor: { type: 'agent', id: 'researcher' }, reason: 'delegate research', referenceTaskIds: ['a2a-task-7'] });
    expect(h.scope).toBe('agent_to_agent');
    expect(h.referenceTaskIds).toEqual(['a2a-task-7']);
  });
});
