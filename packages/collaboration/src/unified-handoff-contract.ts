// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link UnifiedHandoffManager} adapter (Phase 5).
 * The in-memory reference adapter and geneWeave's SQL adapter must both pass it.
 */
import type { UnifiedHandoffManager, RequestHandoffInput } from './unified-handoff.js';
import type { ContractTestApi } from './shared-session-contract.js';

let counter = 0;
function nextId(prefix: string): string { return `${prefix}-${++counter}`; }

export function handoffManagerContract(make: () => Promise<UnifiedHandoffManager> | UnifiedHandoffManager, t: ContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('UnifiedHandoffManager contract', () => {
    let mgr: UnifiedHandoffManager;
    let runId: string;
    beforeEach(async () => { mgr = await make(); runId = nextId('run'); });

    async function request(over: Partial<RequestHandoffInput> = {}) {
      return mgr.request({
        id: nextId('h'), runId, tenantId: 'tA', scope: 'agent_to_human',
        fromActor: { type: 'agent', id: 'agent-1' }, toActor: { type: 'user', id: 'human-1' },
        reason: 'low confidence on the refund policy', ...over,
      });
    }

    it('request creates a handoff in `requested` with an audit event', async () => {
      const h = await request();
      expect(h.state).toBe('requested');
      expect(h.reason).toBe('low confidence on the refund policy');
      const trail = await mgr.audit(h.id);
      expect(trail.length).toBe(1);
      expect(trail[0]!.toState).toBe('requested');
    });

    it('a request requires a reason', async () => {
      await expect(request({ reason: '' })).rejects.toThrow();
    });

    it('the full happy path: requested → accepted → in_progress → handed_back → completed', async () => {
      const h = await request();
      await mgr.accept(h.id, 'human-1');
      await mgr.start(h.id, 'human-1');
      const back = await mgr.handBack(h.id, 'human-1', { summary: 'issued the refund' });
      expect(back.state).toBe('handed_back');
      expect(back.handBackBriefing?.summary).toBe('issued the refund');
      const done = await mgr.complete(h.id, 'agent-1');
      expect(done.state).toBe('completed');
      const trail = await mgr.audit(h.id);
      expect(trail.map((e) => e.toState)).toEqual(['requested', 'accepted', 'in_progress', 'handed_back', 'completed']);
    });

    it('reject requires + records a reason', async () => {
      const h = await request();
      await expect(mgr.reject(h.id, 'human-1', '')).rejects.toThrow();
      const r = await mgr.reject(h.id, 'human-1', 'out of my area');
      expect(r.state).toBe('rejected');
      expect(r.rejectionReason).toBe('out of my area');
      const trail = await mgr.audit(h.id);
      expect(trail.at(-1)?.note).toBe('out of my area');
    });

    it('only the RECIPIENT may accept/reject/start/hand-back', async () => {
      const h = await request();
      await expect(mgr.accept(h.id, 'agent-1')).rejects.toThrow();   // requester cannot accept
      await expect(mgr.reject(h.id, 'someone-else', 'no')).rejects.toThrow();
      await mgr.accept(h.id, 'human-1');
      await expect(mgr.start(h.id, 'agent-1')).rejects.toThrow();
    });

    it('only the REQUESTER may cancel', async () => {
      const h = await request();
      await expect(mgr.cancel(h.id, 'human-1')).rejects.toThrow();
      const c = await mgr.cancel(h.id, 'agent-1');
      expect(c.state).toBe('cancelled');
    });

    it('rejects illegal transitions (cannot start before accept; cannot accept a terminal)', async () => {
      const h = await request();
      await expect(mgr.start(h.id, 'human-1')).rejects.toThrow();    // not accepted yet
      await mgr.reject(h.id, 'human-1', 'nope');
      await expect(mgr.accept(h.id, 'human-1')).rejects.toThrow();   // already terminal
    });

    it('refuses a handoff chain deeper than maxDepth (anti-loop)', async () => {
      const root = await request();
      const child = await request({ parentHandoffId: root.id, maxDepth: 1 });
      expect(child.depth).toBe(1);
      await expect(request({ parentHandoffId: child.id, maxDepth: 1 })).rejects.toThrow(/loop|deep/i);
    });

    it('listForActor returns the recipient inbox; listForRun lists the run', async () => {
      const h = await request();
      expect((await mgr.listForActor('human-1')).some((x) => x.id === h.id)).toBe(true);
      expect((await mgr.listForActor('agent-1')).some((x) => x.id === h.id)).toBe(false); // requester, not recipient
      expect((await mgr.listForRun(runId)).some((x) => x.id === h.id)).toBe(true);
    });

    it('expireDue times out an overdue requested handoff', async () => {
      const h = await request({ ttlMs: 1000 });
      const changed = await mgr.expireDue(h.createdAt + 2000);
      expect(changed.some((x) => x.id === h.id)).toBe(true);
      expect((await mgr.get(h.id))?.state).toBe('timed_out');
    });
  });
}
