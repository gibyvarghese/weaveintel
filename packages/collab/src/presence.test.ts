// SPDX-License-Identifier: MIT
/**
 * Unit tests — Presence (Collaboration Phase 1).
 * Runs the shared conformance suite against the in-memory adapter, then adds
 * security / robustness / stress cases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemoryPresenceManager, presenceManagerContract, type PresenceHarness } from './index.js';

// A clock-controllable harness for the contract (deterministic TTL tests).
function makeHarness(): PresenceHarness {
  let clock = 1_000_000;
  const mgr = createInMemoryPresenceManager({ ttlMs: 30_000, now: () => clock });
  return { mgr, tick: (ms) => { clock += ms; } };
}

presenceManagerContract(makeHarness, { describe, it, beforeEach, expect } as unknown as Parameters<typeof presenceManagerContract>[1]);

describe('presence — security & robustness', () => {
  const scope = { runId: 'r1', tenantId: 'tA' };

  it('snapshot orders humans before agents, then by userId (deterministic)', async () => {
    const m = createInMemoryPresenceManager();
    await m.heartbeat(scope, { userId: '__agent', displayName: 'A', presence: 'working', peerType: 'agent' });
    await m.heartbeat(scope, { userId: 'zoe', displayName: 'Zoe', presence: 'online' });
    await m.heartbeat(scope, { userId: 'amy', displayName: 'Amy', presence: 'online' });
    const list = await m.list(scope);
    expect(list.map((p) => p.userId)).toEqual(['amy', 'zoe', '__agent']);
  });

  it('does not leak cursor/display across tenants', async () => {
    const m = createInMemoryPresenceManager();
    await m.heartbeat({ runId: 'r1', tenantId: 'tA' }, { userId: 'u1', displayName: 'Secret', presence: 'online', cursor: { x: 1 } });
    const other = await m.list({ runId: 'r1', tenantId: 'tB' });
    expect(other).toEqual([]); // tenant B sees nothing of tenant A's participant
  });

  it('leave on an absent participant is a harmless no-op', async () => {
    const m = createInMemoryPresenceManager();
    expect(await m.leave(scope, 'ghost')).toEqual([]);
  });

  it('sweep with nothing expired returns no affected scopes', async () => {
    const m = createInMemoryPresenceManager();
    await m.heartbeat(scope, { userId: 'u1', displayName: 'A', presence: 'online' });
    expect(await m.sweep()).toEqual([]);
  });

  it('handles many participants on one run (stress)', async () => {
    const m = createInMemoryPresenceManager();
    for (let i = 0; i < 200; i++) await m.heartbeat(scope, { userId: `u${i}`, displayName: `U${i}`, presence: 'online' });
    expect((await m.list(scope)).length).toBe(200);
  });

  it('sweep reaps across multiple runs and reports each affected scope', async () => {
    let clock = 0;
    const m = createInMemoryPresenceManager({ ttlMs: 10_000, now: () => clock });
    await m.heartbeat({ runId: 'rA', tenantId: 'tA' }, { userId: 'u1', displayName: 'A', presence: 'online' });
    await m.heartbeat({ runId: 'rB', tenantId: 'tA' }, { userId: 'u2', displayName: 'B', presence: 'online' });
    clock = 11_000;
    const affected = await m.sweep();
    expect(affected.map((s) => s.runId).sort()).toEqual(['rA', 'rB']);
  });
});
