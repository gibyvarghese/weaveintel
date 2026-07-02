// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link SubscriptionManager} adapter (Phase 3).
 * The in-memory reference adapter and geneWeave's SQL adapter must both pass it —
 * proving identical behaviour behind the one port (the Phase 0/1/2 pattern).
 */
import type { SubscriptionManager } from './run-subscription.js';
import type { ContractTestApi } from './shared-session-contract.js';

let counter = 0;
function nextId(prefix: string): string { return `${prefix}-${++counter}`; }

export function subscriptionManagerContract(make: () => Promise<SubscriptionManager> | SubscriptionManager, t: ContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('SubscriptionManager contract', () => {
    let mgr: SubscriptionManager;
    let runId: string;
    beforeEach(async () => {
      mgr = await make();
      runId = nextId('run');
    });

    it('subscribe records a durable subscription; isSubscribed reflects it', async () => {
      const sub = await mgr.subscribe({ runId, tenantId: 'tA', userId: 'alice' });
      expect(sub.runId).toBe(runId);
      expect(sub.userId).toBe('alice');
      expect(await mgr.isSubscribed(runId, 'alice')).toBe(true);
      expect(await mgr.isSubscribed(runId, 'nobody')).toBe(false);
    });

    it('always includes the in-app channel even when not requested', async () => {
      const sub = await mgr.subscribe({ runId, tenantId: 'tA', userId: 'alice', channels: ['webhook'] });
      expect([...sub.channels].sort()).toEqual(['inapp', 'webhook']);
    });

    it('subscribe is idempotent per (run, user) and updates the channel set', async () => {
      await mgr.subscribe({ runId, tenantId: 'tA', userId: 'alice', channels: ['inapp'] });
      await mgr.subscribe({ runId, tenantId: 'tA', userId: 'alice', channels: ['inapp', 'email'] });
      const subs = await mgr.listSubscribers(runId);
      expect(subs.length).toBe(1); // one row, not two
      expect([...subs[0]!.channels].sort()).toEqual(['email', 'inapp']);
    });

    it('listSubscribers returns everyone on a run (the fan-out list)', async () => {
      await mgr.subscribe({ runId, tenantId: 'tA', userId: 'alice' });
      await mgr.subscribe({ runId, tenantId: 'tA', userId: 'bob' });
      const subs = await mgr.listSubscribers(runId);
      expect(subs.map((s) => s.userId).sort()).toEqual(['alice', 'bob']);
    });

    it('listForUser returns every run a user watches', async () => {
      const r2 = nextId('run');
      await mgr.subscribe({ runId, tenantId: 'tA', userId: 'alice' });
      await mgr.subscribe({ runId: r2, tenantId: 'tA', userId: 'alice' });
      const mine = await mgr.listForUser('alice');
      expect(mine.map((s) => s.runId).sort()).toEqual([runId, r2].sort());
    });

    it('unsubscribe removes it and is idempotent', async () => {
      await mgr.subscribe({ runId, tenantId: 'tA', userId: 'alice' });
      await mgr.unsubscribe(runId, 'alice');
      expect(await mgr.isSubscribed(runId, 'alice')).toBe(false);
      await mgr.unsubscribe(runId, 'alice'); // twice — no throw
      expect(await mgr.get(runId, 'alice')).toBeNull();
    });
  });
}
