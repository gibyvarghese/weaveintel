// SPDX-License-Identifier: MIT
/**
 * Shared conformance ("contract") test for any {@link PresenceManager} adapter
 * (Collaboration Phase 1). The in-memory reference adapter and geneWeave's SQL
 * adapter must both pass this same suite — proving they behave identically behind
 * the one presence port (the same ports-&-adapters pattern as Phase 0).
 *
 * The factory takes the test primitives ({@link ContractTestApi}) so this file
 * imports no test framework; each adapter's test passes vitest's globals. It also
 * takes a clock-controllable harness so TTL expiry can be tested deterministically
 * without real waits.
 */
import type { PresenceManager, PresenceScope } from './presence.js';

export interface ContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    [k: string]: unknown;
  };
}

/** A clock-controllable presence manager for the contract (advance time to test TTL). */
export interface PresenceHarness {
  mgr: PresenceManager;
  /** Advance the manager's clock by `ms` (so expired participants can be swept). */
  tick: (ms: number) => void;
}

const A: PresenceScope = { runId: 'run-1', tenantId: 'tA' };
// A different run in a different tenant. (Run ids are globally unique, so a
// tenant's runs never share an id — isolation is by run, which is tenant-unique.)
const B: PresenceScope = { runId: 'run-2', tenantId: 'tB' };

export function presenceManagerContract(make: () => Promise<PresenceHarness> | PresenceHarness, t: ContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('PresenceManager contract', () => {
    let h: PresenceHarness;
    beforeEach(async () => { h = await make(); });

    it('heartbeat then list shows the participant', async () => {
      await h.mgr.heartbeat(A, { userId: 'u1', displayName: 'Alice', presence: 'online' });
      const list = await h.mgr.list(A);
      expect(list.length).toBe(1);
      expect(list[0]!.userId).toBe('u1');
      expect(list[0]!.peerType).toBe('human');
    });

    it('a second heartbeat from the same user upserts (no duplicate)', async () => {
      await h.mgr.heartbeat(A, { userId: 'u1', displayName: 'Alice', presence: 'online' });
      await h.mgr.heartbeat(A, { userId: 'u1', displayName: 'Alice', presence: 'typing' });
      const list = await h.mgr.list(A);
      expect(list.length).toBe(1);
      expect(list[0]!.presence).toBe('typing');
    });

    it('two participants both appear; heartbeat returns the full snapshot', async () => {
      await h.mgr.heartbeat(A, { userId: 'u1', displayName: 'Alice', presence: 'online' });
      const snap = await h.mgr.heartbeat(A, { userId: 'u2', displayName: 'Bob', presence: 'online' });
      expect(snap.length).toBe(2);
      expect((await h.mgr.list(A)).map((p) => p.userId).sort()).toEqual(['u1', 'u2']);
    });

    it('leave removes a participant immediately (explicit disconnect)', async () => {
      await h.mgr.heartbeat(A, { userId: 'u1', displayName: 'Alice', presence: 'online' });
      await h.mgr.heartbeat(A, { userId: 'u2', displayName: 'Bob', presence: 'online' });
      const after = await h.mgr.leave(A, 'u1');
      expect(after.map((p) => p.userId)).toEqual(['u2']);
    });

    it('presence is isolated by run/tenant (a different run sees nothing)', async () => {
      await h.mgr.heartbeat(A, { userId: 'u1', displayName: 'Alice', presence: 'online' });
      expect((await h.mgr.list(B)).length).toBe(0); // run-2/tenant-B sees nothing of run-1/tenant-A
    });

    it('an agent participant is a first-class peer', async () => {
      await h.mgr.heartbeat(A, { userId: '__agent', displayName: 'Agent', presence: 'working', peerType: 'agent' });
      const list = await h.mgr.list(A);
      expect(list[0]!.peerType).toBe('agent');
      expect(list[0]!.presence).toBe('working');
    });

    it('a participant expires after the TTL and is swept', async () => {
      await h.mgr.heartbeat(A, { userId: 'u1', displayName: 'Alice', presence: 'online' });
      h.tick(31_000); // past the 30s TTL
      expect((await h.mgr.list(A)).length).toBe(0); // no longer listed
      const affected = await h.mgr.sweep();
      expect(affected.some((s) => s.runId === 'run-1' && s.tenantId === 'tA')).toBe(true);
    });

    it('a heartbeat within the TTL keeps a participant alive (anti-flicker)', async () => {
      await h.mgr.heartbeat(A, { userId: 'u1', displayName: 'Alice', presence: 'online' });
      h.tick(15_000); // one heartbeat interval later
      await h.mgr.heartbeat(A, { userId: 'u1', displayName: 'Alice', presence: 'online' }); // renews
      h.tick(20_000); // 35s after the FIRST beat, but only 20s after the renewal
      expect((await h.mgr.list(A)).length).toBe(1); // still here
    });
  });
}
