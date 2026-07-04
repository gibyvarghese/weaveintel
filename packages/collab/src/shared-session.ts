// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collaboration — Shared sessions.
 *
 * A "shared session" turns a single-owner run into a multi-user one: the owner
 * shares it (via an invite link), other people JOIN with a ROLE, and the run's
 * endpoints enforce read-vs-write by that role.
 *
 * --- For someone new to this ---
 * Think of sharing a Google Doc: you pick "anyone with the link can VIEW" (or
 * EDIT), send the link, and whoever opens it gets exactly that level of access —
 * no more. Here the "doc" is a live AI run. Three roles:
 *   - **viewer**       — can WATCH the run live (and show up as present), nothing else.
 *   - **collaborator** — can also send input / steer the run.
 *   - **owner**        — can also cancel it and manage sharing.
 * The rule that matters most: only the **owner** can share or cancel — that
 * "manage" power is a separate, higher tier above "edit" (the Notion model).
 *
 * Ports & adapters (same as Phase 0/1): the {@link SessionManager} PORT + an
 * in-memory reference adapter live here; a consuming application provides a SQL adapter over
 * `shared_sessions` + `session_participants`. Both pass
 * {@link sessionManagerContract}. The actual invite-LINK tokens (random,
 * hashed-at-rest) are minted by the host application — this port models the
 * durable membership, not the crypto.
 */

/** Roles, lowest privilege first. `owner` ⊃ `collaborator` ⊃ `viewer`. */
export type SessionRole = 'owner' | 'collaborator' | 'viewer';

/** Privilege ordering — higher number = more capability ("highest permission wins"). */
const ROLE_RANK: Record<SessionRole, number> = { viewer: 0, collaborator: 1, owner: 2 };

/** True if `role` is at least `required` (e.g. `roleAtLeast('owner','collaborator')`). */
export function roleAtLeast(role: SessionRole, required: SessionRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export interface SharedSession {
  id: string;
  runId: string;
  tenantId: string;
  ownerId: string;
  status: 'live' | 'ended';
  maxParticipants: number;
  createdAt: number;
}

export interface SessionParticipant {
  userId: string;
  role: SessionRole;
  joinedAt: number;
}

export interface CreateSessionInput {
  id: string;
  runId: string;
  tenantId: string;
  ownerId: string;
  maxParticipants?: number;
}

export interface SessionManager {
  /** Create the shared session for a run (idempotent per run — returns the existing one). */
  createSession(input: CreateSessionInput): Promise<SharedSession>;
  /** The shared session for a run, or null if it was never shared. */
  getByRun(runId: string): Promise<SharedSession | null>;
  getById(sessionId: string): Promise<SharedSession | null>;
  /**
   * Add a participant at `role` (idempotent: re-joining is a no-op; a higher
   * role upgrades). Rejects past `maxParticipants`. Returns the membership.
   */
  join(sessionId: string, userId: string, role: SessionRole): Promise<SessionParticipant>;
  /** The caller's role in the session, or null if not a member. */
  getRole(sessionId: string, userId: string): Promise<SessionRole | null>;
  /** All current participants. */
  listParticipants(sessionId: string): Promise<SessionParticipant[]>;
  /** A participant leaves (or the owner removes them — caller must be owner for others). */
  leave(sessionId: string, userId: string): Promise<void>;
  /** Owner-only: remove another participant. Throws if `byUserId` is not the owner. */
  removeParticipant(sessionId: string, byUserId: string, targetUserId: string): Promise<void>;
  /** Owner-only: end the session (revokes shared access). */
  endSession(sessionId: string, byUserId: string): Promise<void>;
}

// ─── In-memory reference adapter ────────────────────────────────────────────────

export interface InMemorySessionManagerOptions {
  now?: () => number;
}

export function createInMemorySessionManager(opts: InMemorySessionManagerOptions = {}): SessionManager {
  const now = opts.now ?? (() => Date.now());
  const sessions = new Map<string, SharedSession>();             // sessionId → session
  const byRun = new Map<string, string>();                       // runId → sessionId
  const members = new Map<string, Map<string, SessionParticipant>>(); // sessionId → userId → participant

  function requireOwner(sessionId: string, byUserId: string): SharedSession {
    const s = sessions.get(sessionId);
    if (!s) throw new Error(`session '${sessionId}' not found`);
    if (s.ownerId !== byUserId) throw new Error('forbidden: only the owner may manage this session');
    return s;
  }

  return {
    async createSession(input) {
      const existingId = byRun.get(input.runId);
      if (existingId) return sessions.get(existingId)!; // idempotent per run
      const session: SharedSession = {
        id: input.id, runId: input.runId, tenantId: input.tenantId, ownerId: input.ownerId,
        status: 'live', maxParticipants: input.maxParticipants ?? 50, createdAt: now(),
      };
      sessions.set(session.id, session);
      byRun.set(input.runId, session.id);
      const m = new Map<string, SessionParticipant>();
      m.set(input.ownerId, { userId: input.ownerId, role: 'owner', joinedAt: now() });
      members.set(session.id, m);
      return session;
    },

    async getByRun(runId) {
      const id = byRun.get(runId);
      return id ? (sessions.get(id) ?? null) : null;
    },
    async getById(sessionId) {
      return sessions.get(sessionId) ?? null;
    },

    async join(sessionId, userId, role) {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`session '${sessionId}' not found`);
      if (s.status !== 'live') throw new Error('session has ended');
      const m = members.get(sessionId)!;
      const existing = m.get(userId);
      if (existing) {
        // Idempotent: keep the HIGHER of the two roles ("highest permission wins").
        const kept = roleAtLeast(existing.role, role) ? existing.role : role;
        const updated = { ...existing, role: kept };
        m.set(userId, updated);
        return updated;
      }
      if (m.size >= s.maxParticipants) throw new Error('session is full');
      const participant: SessionParticipant = { userId, role, joinedAt: now() };
      m.set(userId, participant);
      return participant;
    },

    async getRole(sessionId, userId) {
      return members.get(sessionId)?.get(userId)?.role ?? null;
    },
    async listParticipants(sessionId) {
      return [...(members.get(sessionId)?.values() ?? [])];
    },

    async leave(sessionId, userId) {
      members.get(sessionId)?.delete(userId);
    },
    async removeParticipant(sessionId, byUserId, targetUserId) {
      requireOwner(sessionId, byUserId);
      if (targetUserId === byUserId) throw new Error('the owner cannot remove themselves');
      members.get(sessionId)?.delete(targetUserId);
    },
    async endSession(sessionId, byUserId) {
      const s = requireOwner(sessionId, byUserId);
      sessions.set(sessionId, { ...s, status: 'ended' });
    },
  };
}
