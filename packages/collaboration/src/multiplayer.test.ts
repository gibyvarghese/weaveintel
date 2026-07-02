/**
 * Unit tests — collaboration multiplayer primitives (post Phase 0 re-scope).
 * Covers the Gen-1 in-memory managers that remain after the run substrate moved
 * to @weaveintel/core: shared sessions + presence, run subscriptions, handoff
 * (including the Phase 0 reject-reason fix).
 */
import { describe, it, expect } from 'vitest';
import { createSharedSessionManager } from './session.js';
import { createRunSubscriptionManager } from './subscription.js';
import { createHandoffManager } from './handoff.js';

describe('shared sessions + presence', () => {
  it('creates a session, joins participants, and tracks presence', () => {
    const m = createSharedSessionManager();
    const s = m.create('Design review', 'u1');
    m.join(s.id, { userId: 'u2', displayName: 'Bob', role: 'collaborator', presence: 'online' });
    m.updatePresence(s.id, 'u2', 'typing');
    const got = m.get(s.id);
    expect(got?.participants.length).toBe(2);
    expect(got?.participants.find((p) => p.userId === 'u2')?.presence).toBe('typing');
  });

  it('leave removes a participant; close removes the session', () => {
    const m = createSharedSessionManager();
    const s = m.create('R', 'u1');
    m.join(s.id, { userId: 'u2', displayName: 'B', role: 'viewer', presence: 'online' });
    m.leave(s.id, 'u2');
    expect(m.get(s.id)?.participants.length).toBe(1);
    m.close(s.id);
    expect(m.get(s.id)).toBeUndefined();
  });
});

describe('run subscriptions', () => {
  it('broadcasts a status change to every subscriber of a run', () => {
    const m = createRunSubscriptionManager();
    m.subscribe('run-1', 'sess-1', 'dash');
    m.subscribe('run-1', 'sess-1', 'agent-b');
    m.updateStatus('run-1', 'running', 0.5);
    expect(m.getSubscription('run-1', 'dash')?.status).toBe('running');
    expect(m.getSubscription('run-1', 'agent-b')?.progress).toBe(0.5);
  });

  it('unsubscribe drops a single subscriber', () => {
    const m = createRunSubscriptionManager();
    m.subscribe('run-1', 'sess-1', 'dash');
    m.unsubscribe('run-1', 'dash');
    expect(m.getSubscription('run-1', 'dash')).toBeUndefined();
  });
});

describe('handoff lifecycle', () => {
  it('runs a request → accept flow', () => {
    const m = createHandoffManager();
    const r = m.request('sess-1', 'u1', 'u2', 'need a human');
    expect(r.status).toBe('requested');
    expect(m.accept(r.id)?.status).toBe('accepted');
  });

  it('reject PRESERVES the reason (Phase 0 fix)', () => {
    const m = createHandoffManager();
    const r = m.request('sess-1', 'u1', 'u2', 'please take over');
    const rejected = m.reject(r.id, 'out of office');
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.rejectionReason).toBe('out of office'); // previously dropped
    expect(rejected?.resolvedAt).not.toBeNull();
  });

  it('listBySession returns a session\'s handoffs', () => {
    const m = createHandoffManager();
    m.request('sess-1', 'u1', 'u2', 'a');
    m.request('sess-2', 'u1', 'u3', 'b');
    expect(m.listBySession('sess-1').length).toBe(1);
  });
});
