// SPDX-License-Identifier: MIT
/**
 * Unit tests — shared sessions (Phase 2). Runs the conformance suite against the
 * in-memory adapter + adds role-ordering / security / stress cases.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySessionManager, sessionManagerContract, roleAtLeast } from './index.js';

sessionManagerContract(() => createInMemorySessionManager(), { describe, it, beforeEach, expect } as unknown as Parameters<typeof sessionManagerContract>[1]);

describe('roleAtLeast — privilege ordering', () => {
  it('owner ⊇ collaborator ⊇ viewer', () => {
    expect(roleAtLeast('owner', 'viewer')).toBe(true);
    expect(roleAtLeast('owner', 'collaborator')).toBe(true);
    expect(roleAtLeast('collaborator', 'viewer')).toBe(true);
    expect(roleAtLeast('viewer', 'collaborator')).toBe(false);
    expect(roleAtLeast('collaborator', 'owner')).toBe(false);
  });
});

describe('shared sessions — security & stress', () => {
  it('the owner cannot remove themselves', async () => {
    const m = createInMemorySessionManager();
    const s = await m.createSession({ id: 's1', runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    await expect(m.removeParticipant(s.id, 'owner', 'owner')).rejects.toThrow();
    expect(await m.getRole(s.id, 'owner')).toBe('owner');
  });

  it('a collaborator cannot end the session or remove others', async () => {
    const m = createInMemorySessionManager();
    const s = await m.createSession({ id: 's1', runId: 'r1', tenantId: 'tA', ownerId: 'owner' });
    await m.join(s.id, 'bob', 'collaborator');
    await m.join(s.id, 'carol', 'viewer');
    await expect(m.endSession(s.id, 'bob')).rejects.toThrow();
    await expect(m.removeParticipant(s.id, 'bob', 'carol')).rejects.toThrow();
    expect(await m.getRole(s.id, 'carol')).toBe('viewer'); // untouched
  });

  it('handles many joiners up to the cap (stress)', async () => {
    const m = createInMemorySessionManager();
    const s = await m.createSession({ id: 's1', runId: 'r1', tenantId: 'tA', ownerId: 'owner', maxParticipants: 100 });
    for (let i = 0; i < 99; i++) await m.join(s.id, `u${i}`, 'viewer');
    expect((await m.listParticipants(s.id)).length).toBe(100); // 99 + owner
    await expect(m.join(s.id, 'one-too-many', 'viewer')).rejects.toThrow(/full/);
  });

  it('getRole/getById tolerate an unknown session', async () => {
    const m = createInMemorySessionManager();
    expect(await m.getById('nope')).toBeNull();
    expect(await m.getRole('nope', 'u1')).toBeNull();
  });
});
