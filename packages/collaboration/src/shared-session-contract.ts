// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for any {@link SessionManager} adapter (Phase 2).
 * The in-memory reference adapter and a consuming application's SQL adapter must both pass it —
 * proving identical behaviour behind the one port (the Phase 0/1 pattern).
 */
import type { SessionManager } from './shared-session.js';

export interface ContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    toBeNull(): void;
    toContain(v: unknown): void;
    toBeGreaterThan(v: number): void;
    toBeLessThan(v: number): void;
    toMatchObject(v: unknown): void;
    not: { toBe(v: unknown): void; toEqual(v: unknown): void; toBeNull(): void; toContain(v: unknown): void };
    rejects: { toThrow(matcher?: unknown): Promise<void> };
    [k: string]: unknown;
  };
}

let counter = 0;
function nextId(prefix: string): string { return `${prefix}-${++counter}`; }

export function sessionManagerContract(make: () => Promise<SessionManager> | SessionManager, t: ContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('SessionManager contract', () => {
    let mgr: SessionManager;
    let runId: string;
    let sessionId: string;
    beforeEach(async () => {
      mgr = await make();
      runId = nextId('run');
      sessionId = nextId('sess');
    });

    async function newSession(over: Partial<Parameters<SessionManager['createSession']>[0]> = {}) {
      return mgr.createSession({ id: sessionId, runId, tenantId: 'tA', ownerId: 'owner', ...over });
    }

    it('createSession makes the owner a participant', async () => {
      const s = await newSession();
      expect(s.ownerId).toBe('owner');
      expect(await mgr.getRole(s.id, 'owner')).toBe('owner');
    });

    it('createSession is idempotent per run', async () => {
      const a = await newSession();
      const b = await mgr.createSession({ id: 'other', runId, tenantId: 'tA', ownerId: 'owner' });
      expect(b.id).toBe(a.id); // same session returned
    });

    it('getByRun resolves the session; unknown run is null', async () => {
      const s = await newSession();
      expect((await mgr.getByRun(runId))?.id).toBe(s.id);
      expect(await mgr.getByRun('ghost')).toBeNull();
    });

    it('join adds a participant at a role; getRole reflects it', async () => {
      const s = await newSession();
      await mgr.join(s.id, 'bob', 'viewer');
      expect(await mgr.getRole(s.id, 'bob')).toBe('viewer');
      const list = await mgr.listParticipants(s.id);
      expect(list.map((p) => p.userId).sort()).toEqual(['bob', 'owner']);
    });

    it('join is idempotent and keeps the HIGHER role (highest permission wins)', async () => {
      const s = await newSession();
      await mgr.join(s.id, 'bob', 'viewer');
      await mgr.join(s.id, 'bob', 'collaborator'); // upgrade
      expect(await mgr.getRole(s.id, 'bob')).toBe('collaborator');
      await mgr.join(s.id, 'bob', 'viewer'); // lower — does NOT downgrade
      expect(await mgr.getRole(s.id, 'bob')).toBe('collaborator');
      expect((await mgr.listParticipants(s.id)).filter((p) => p.userId === 'bob').length).toBe(1);
    });

    it('getRole is null for a non-member', async () => {
      const s = await newSession();
      expect(await mgr.getRole(s.id, 'stranger')).toBeNull();
    });

    it('leave removes a participant', async () => {
      const s = await newSession();
      await mgr.join(s.id, 'bob', 'viewer');
      await mgr.leave(s.id, 'bob');
      expect(await mgr.getRole(s.id, 'bob')).toBeNull();
    });

    it('only the owner may remove another participant', async () => {
      const s = await newSession();
      await mgr.join(s.id, 'bob', 'collaborator');
      await expect(mgr.removeParticipant(s.id, 'bob', 'owner')).rejects.toThrow(); // non-owner cannot
      await mgr.removeParticipant(s.id, 'owner', 'bob'); // owner can
      expect(await mgr.getRole(s.id, 'bob')).toBeNull();
    });

    it('respects maxParticipants', async () => {
      const s = await mgr.createSession({ id: sessionId, runId, tenantId: 'tA', ownerId: 'owner', maxParticipants: 2 });
      await mgr.join(s.id, 'bob', 'viewer'); // 2nd (owner is 1st)
      await expect(mgr.join(s.id, 'carol', 'viewer')).rejects.toThrow(/full/);
    });

    it('owner can end the session; joining an ended session fails', async () => {
      const s = await newSession();
      await expect(mgr.endSession(s.id, 'bob')).rejects.toThrow(); // non-owner cannot end
      await mgr.endSession(s.id, 'owner');
      expect((await mgr.getById(s.id))?.status).toBe('ended');
      await expect(mgr.join(s.id, 'bob', 'viewer')).rejects.toThrow(/ended/);
    });
  });
}
