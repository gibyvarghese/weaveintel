// @weaveintel/collaboration — Shared sessions, presence, live updates, user handoff

import type { ExecutionContext } from '@weaveintel/core';

/* ── Types ──────────────────────────────────────────────── */

export interface SessionParticipant {
  readonly userId: string;
  readonly displayName: string;
  readonly role: 'owner' | 'collaborator' | 'viewer';
  readonly joinedAt: number;
  readonly lastActiveAt: number;
  readonly presence: PresenceState;
}

export type PresenceState = 'online' | 'idle' | 'typing' | 'away' | 'offline';

export interface SharedSession {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly participants: readonly SessionParticipant[];
  readonly metadata: Record<string, unknown>;
}

export interface SessionUpdate {
  readonly sessionId: string;
  readonly userId: string;
  readonly type: 'join' | 'leave' | 'presence' | 'message' | 'cursor';
  readonly timestamp: number;
  readonly payload: unknown;
}

/* ── Factory ────────────────────────────────────────────── */

export interface SharedSessionManager {
  create(name: string, createdBy: string, metadata?: Record<string, unknown>): SharedSession;
  get(sessionId: string): SharedSession | undefined;
  join(sessionId: string, participant: Omit<SessionParticipant, 'joinedAt' | 'lastActiveAt'>): SharedSession;
  leave(sessionId: string, userId: string): SharedSession;
  updatePresence(sessionId: string, userId: string, presence: PresenceState): SharedSession;
  broadcast(sessionId: string, update: Omit<SessionUpdate, 'timestamp'>): void;
  listSessions(): readonly SharedSession[];
  close(sessionId: string): void;
}

export function createSharedSessionManager(): SharedSessionManager {
  const sessions = new Map<string, { session: SharedSession; participants: Map<string, SessionParticipant> }>();

  function nextId(): string {
    return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function snapshot(id: string): SharedSession {
    const entry = sessions.get(id);
    if (!entry) throw new Error(`Session ${id} not found`);
    return { ...entry.session, participants: Array.from(entry.participants.values()) };
  }

  return {
    create(name, createdBy, metadata = {}) {
      const id = nextId();
      const owner: SessionParticipant = { userId: createdBy, displayName: createdBy, role: 'owner', joinedAt: Date.now(), lastActiveAt: Date.now(), presence: 'online' };
      const participants = new Map<string, SessionParticipant>();
      participants.set(createdBy, owner);
      const session: SharedSession = { id, name, createdBy, createdAt: Date.now(), participants: [owner], metadata };
      sessions.set(id, { session, participants });
      return snapshot(id);
    },

    get(sessionId) {
      if (!sessions.has(sessionId)) return undefined;
      return snapshot(sessionId);
    },

    join(sessionId, participant) {
      const entry = sessions.get(sessionId);
      if (!entry) throw new Error(`Session ${sessionId} not found`);
      const p: SessionParticipant = { ...participant, joinedAt: Date.now(), lastActiveAt: Date.now() };
      entry.participants.set(participant.userId, p);
      return snapshot(sessionId);
    },

    leave(sessionId, userId) {
      const entry = sessions.get(sessionId);
      if (!entry) throw new Error(`Session ${sessionId} not found`);
      entry.participants.delete(userId);
      return snapshot(sessionId);
    },

    updatePresence(sessionId, userId, presence) {
      const entry = sessions.get(sessionId);
      if (!entry) throw new Error(`Session ${sessionId} not found`);
      const existing = entry.participants.get(userId);
      if (existing) {
        entry.participants.set(userId, { ...existing, presence, lastActiveAt: Date.now() });
      }
      return snapshot(sessionId);
    },

    broadcast(_sessionId, _update) {
      // In-memory implementation — external integrations hook here
    },

    listSessions() {
      return Array.from(sessions.keys()).map((id) => snapshot(id));
    },

    close(sessionId) {
      sessions.delete(sessionId);
    },
  };
}
