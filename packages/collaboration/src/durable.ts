/**
 * @weaveintel/collaboration — durable variants of the three in-memory
 * managers (handoff, session, run subscription). Same pattern as
 * `@weaveintel/compliance/durable`: factory accepts `{runtime?, namespace?}`,
 * uses `runtime.persistence.kv` if present, falls back to
 * `weaveInMemoryPersistence()` otherwise.
 */
import {
  weaveInMemoryPersistence,
  type RuntimeKvStore,
  type WeaveRuntime,
} from '@weaveintel/core';
import type { HandoffRequest, HandoffStatus } from './handoff.js';
import type { SharedSession, SessionParticipant, PresenceState } from './session.js';
import type { RunStatus, RunSubscription } from './subscription.js';

interface DurableOpts {
  runtime?: WeaveRuntime;
  namespace?: string;
}

function resolveKv(runtime: WeaveRuntime | undefined): RuntimeKvStore {
  return runtime?.persistence?.kv ?? weaveInMemoryPersistence().kv;
}

async function loadAll<T>(kv: RuntimeKvStore, ns: string): Promise<T[]> {
  const entries = await kv.list(`${ns}:`);
  const out: T[] = [];
  for (const e of entries) {
    try { out.push(JSON.parse(e.value) as T); } catch { /* skip */ }
  }
  return out;
}

async function loadOne<T>(kv: RuntimeKvStore, ns: string, id: string): Promise<T | undefined> {
  const v = await kv.get(`${ns}:${id}`);
  if (!v) return undefined;
  try { return JSON.parse(v) as T; } catch { return undefined; }
}

async function saveOne<T>(kv: RuntimeKvStore, ns: string, id: string, value: T): Promise<void> {
  await kv.set(`${ns}:${id}`, JSON.stringify(value));
}

/* ------------------------------------------------------------------ */
/*  Handoff                                                            */
/* ------------------------------------------------------------------ */

export interface DurableHandoffManager {
  request(sessionId: string, fromUserId: string, toUserId: string, reason: string): Promise<HandoffRequest>;
  accept(handoffId: string): Promise<HandoffRequest | undefined>;
  reject(handoffId: string, reason?: string): Promise<HandoffRequest | undefined>;
  cancel(handoffId: string): Promise<HandoffRequest | undefined>;
  complete(handoffId: string): Promise<HandoffRequest | undefined>;
  get(handoffId: string): Promise<HandoffRequest | undefined>;
  listBySession(sessionId: string): Promise<readonly HandoffRequest[]>;
}

export function createDurableHandoffManager(opts: DurableOpts = {}): DurableHandoffManager {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'handoff';

  function nextId(): string {
    return `hoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function transition(id: string, status: HandoffStatus): Promise<HandoffRequest | undefined> {
    const existing = await loadOne<HandoffRequest>(kv, ns, id);
    if (!existing) return undefined;
    const updated: HandoffRequest = {
      ...existing,
      status,
      resolvedAt: status === 'requested' ? null : Date.now(),
    };
    await saveOne(kv, ns, id, updated);
    return updated;
  }

  return {
    async request(sessionId, fromUserId, toUserId, reason) {
      const req: HandoffRequest = {
        id: nextId(), sessionId, fromUserId, toUserId, reason,
        status: 'requested', createdAt: Date.now(), resolvedAt: null, metadata: {},
      };
      await saveOne(kv, ns, req.id, req);
      return req;
    },
    accept: (id) => transition(id, 'accepted'),
    reject: (id) => transition(id, 'rejected'),
    cancel: (id) => transition(id, 'cancelled'),
    complete: (id) => transition(id, 'completed'),
    async get(id) { return loadOne<HandoffRequest>(kv, ns, id); },
    async listBySession(sessionId) {
      const all = await loadAll<HandoffRequest>(kv, ns);
      return all.filter((r) => r.sessionId === sessionId);
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Shared Session                                                     */
/* ------------------------------------------------------------------ */

export interface DurableSharedSessionManager {
  create(name: string, createdBy: string, metadata?: Record<string, unknown>): Promise<SharedSession>;
  get(sessionId: string): Promise<SharedSession | undefined>;
  join(sessionId: string, participant: Omit<SessionParticipant, 'joinedAt' | 'lastActiveAt'>): Promise<SharedSession>;
  leave(sessionId: string, userId: string): Promise<SharedSession>;
  updatePresence(sessionId: string, userId: string, presence: PresenceState): Promise<SharedSession>;
  listSessions(): Promise<readonly SharedSession[]>;
  close(sessionId: string): Promise<void>;
}

export function createDurableSharedSessionManager(opts: DurableOpts = {}): DurableSharedSessionManager {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'collab-session';

  function nextId(): string {
    return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  return {
    async create(name, createdBy, metadata = {}) {
      const id = nextId();
      const owner: SessionParticipant = {
        userId: createdBy, displayName: createdBy, role: 'owner',
        joinedAt: Date.now(), lastActiveAt: Date.now(), presence: 'online',
      };
      const session: SharedSession = {
        id, name, createdBy, createdAt: Date.now(),
        participants: [owner], metadata,
      };
      await saveOne(kv, ns, id, session);
      return session;
    },
    async get(id) { return loadOne<SharedSession>(kv, ns, id); },
    async join(sessionId, participant) {
      const existing = await loadOne<SharedSession>(kv, ns, sessionId);
      if (!existing) throw new Error(`Session ${sessionId} not found`);
      const p: SessionParticipant = { ...participant, joinedAt: Date.now(), lastActiveAt: Date.now() };
      const filtered = existing.participants.filter((x) => x.userId !== participant.userId);
      const updated: SharedSession = { ...existing, participants: [...filtered, p] };
      await saveOne(kv, ns, sessionId, updated);
      return updated;
    },
    async leave(sessionId, userId) {
      const existing = await loadOne<SharedSession>(kv, ns, sessionId);
      if (!existing) throw new Error(`Session ${sessionId} not found`);
      const updated: SharedSession = {
        ...existing,
        participants: existing.participants.filter((p) => p.userId !== userId),
      };
      await saveOne(kv, ns, sessionId, updated);
      return updated;
    },
    async updatePresence(sessionId, userId, presence) {
      const existing = await loadOne<SharedSession>(kv, ns, sessionId);
      if (!existing) throw new Error(`Session ${sessionId} not found`);
      const updated: SharedSession = {
        ...existing,
        participants: existing.participants.map((p) =>
          p.userId === userId ? { ...p, presence, lastActiveAt: Date.now() } : p),
      };
      await saveOne(kv, ns, sessionId, updated);
      return updated;
    },
    async listSessions() { return loadAll<SharedSession>(kv, ns); },
    async close(sessionId) { await kv.delete(`${ns}:${sessionId}`); },
  };
}

/* ------------------------------------------------------------------ */
/*  Run Subscription                                                   */
/* ------------------------------------------------------------------ */

export interface DurableRunSubscriptionManager {
  subscribe(runId: string, sessionId: string, subscriberId: string): Promise<RunSubscription>;
  updateStatus(runId: string, status: RunStatus, progress?: number): Promise<RunSubscription | undefined>;
  getSubscription(runId: string, subscriberId: string): Promise<RunSubscription | undefined>;
  listBySession(sessionId: string): Promise<readonly RunSubscription[]>;
  unsubscribe(runId: string, subscriberId: string): Promise<void>;
}

export function createDurableRunSubscriptionManager(opts: DurableOpts = {}): DurableRunSubscriptionManager {
  const kv = resolveKv(opts.runtime);
  const ns = opts.namespace ?? 'run-sub';
  const key = (runId: string, subscriberId: string) => `${runId}::${subscriberId}`;

  return {
    async subscribe(runId, sessionId, subscriberId) {
      const sub: RunSubscription = {
        runId, sessionId, subscriberId,
        status: 'pending', progress: 0,
        lastUpdate: Date.now(), metadata: {},
      };
      await saveOne(kv, ns, key(runId, subscriberId), sub);
      return sub;
    },
    async updateStatus(runId, status, progress) {
      const all = await loadAll<RunSubscription>(kv, ns);
      let last: RunSubscription | undefined;
      for (const s of all) {
        if (s.runId !== runId) continue;
        const updated: RunSubscription = {
          ...s, status,
          progress: progress ?? s.progress,
          lastUpdate: Date.now(),
        };
        await saveOne(kv, ns, key(s.runId, s.subscriberId), updated);
        last = updated;
      }
      return last;
    },
    async getSubscription(runId, subscriberId) {
      return loadOne<RunSubscription>(kv, ns, key(runId, subscriberId));
    },
    async listBySession(sessionId) {
      const all = await loadAll<RunSubscription>(kv, ns);
      return all.filter((s) => s.sessionId === sessionId);
    },
    async unsubscribe(runId, subscriberId) {
      await kv.delete(`${ns}:${key(runId, subscriberId)}`);
    },
  };
}
