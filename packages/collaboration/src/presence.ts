// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collaboration — Presence ("who else is here").
 *
 * Collaboration Phase 1. Presence is the multiplayer baseline: a heartbeat-driven,
 * TTL-expiring set of participants currently watching a shared resource (a run).
 *
 * --- For someone new to this ---
 * Think of the little coloured avatars that pop up in a shared doc showing who
 * else is viewing it. Each viewer sends a tiny "I'm still here" ping (a
 * "heartbeat") every ~15 seconds. If a viewer's pings stop for ~30 seconds (they
 * closed the tab or lost wifi), they're considered gone and removed. That's all
 * presence is: a list of who's currently here, kept fresh by heartbeats and
 * pruned by a timeout (TTL = "time to live").
 *
 * Design (mid-2026 research, anchored on the Yjs awareness protocol):
 *  - **Heartbeat 15s / TTL 30s** — TTL is 2× the heartbeat so a single missed
 *    ping never drops a peer (no flicker). Each heartbeat slides `expiresAt`.
 *  - **Ephemeral** — presence is a *current-state* store (upsert/delete), NOT an
 *    append-only log. It is never journaled.
 *  - **Snapshot, not delta** — `list()` returns the FULL current set; the realtime
 *    layer broadcasts the whole snapshot, which is idempotent and gap-safe.
 *  - **Agents are first-class peers** — an agent can be `upsert`ed with
 *    `peerType: 'agent'` and a `working`/`streaming` status while a run runs.
 *  - **Server-derived identity** — callers pass an already-authenticated
 *    `userId`/`displayName`; this layer never trusts client-supplied identity.
 *
 * Ports & adapters (same pattern as the Phase 0 run substrate): the
 * {@link PresenceManager} PORT lives here with an in-memory reference adapter
 * ({@link createInMemoryPresenceManager}); a consuming application provides a SQL adapter over
 * the `run_presence` table. Both pass {@link presenceManagerContract}.
 */
import type { RunPresenceParticipant } from '@weaveintel/core';

/** Scope a presence set to one run within one tenant (hard isolation). */
export interface PresenceScope {
  runId: string;
  tenantId: string;
}

/** A heartbeat — the participant identity + state being announced. */
export interface PresenceHeartbeat {
  userId: string;
  displayName: string;
  presence: string;
  peerType?: 'human' | 'agent';
  color?: string;
  cursor?: Record<string, unknown>;
}

export interface PresenceManagerOptions {
  /** TTL in ms — a participant is reaped this long after their last heartbeat. Default 30000. */
  ttlMs?: number;
  /** Clock injection (tests). Default `Date.now`. */
  now?: () => number;
}

export interface PresenceManager {
  /**
   * Record a heartbeat (upsert): the participant is present and their `expiresAt`
   * slides forward by the TTL. Returns the full current participant snapshot for
   * the scope.
   */
  heartbeat(scope: PresenceScope, beat: PresenceHeartbeat): Promise<RunPresenceParticipant[]>;
  /** Explicit leave (tab close / agent done): remove the participant now. Returns the new snapshot. */
  leave(scope: PresenceScope, userId: string): Promise<RunPresenceParticipant[]>;
  /** The current (non-expired) participants for a scope. */
  list(scope: PresenceScope): Promise<RunPresenceParticipant[]>;
  /**
   * Reap every participant whose TTL elapsed across ALL scopes. Returns the set
   * of `{runId, tenantId}` scopes that lost at least one participant (so the
   * caller can re-broadcast their snapshots).
   */
  sweep(): Promise<PresenceScope[]>;
}

interface StoredParticipant extends RunPresenceParticipant {
  tenantId: string;
  runId: string;
  expiresAt: number;
}

function toPublic(p: StoredParticipant): RunPresenceParticipant {
  return {
    userId: p.userId,
    displayName: p.displayName,
    presence: p.presence,
    peerType: p.peerType,
    ...(p.color !== undefined ? { color: p.color } : {}),
    ...(p.lastHeartbeatAt !== undefined ? { lastHeartbeatAt: p.lastHeartbeatAt } : {}),
    ...(p.cursor !== undefined ? { cursor: p.cursor } : {}),
  };
}

/**
 * In-memory reference {@link PresenceManager}. Single-process; the host application's SQL
 * adapter is the durable, cross-process implementation. Both pass the same
 * conformance suite.
 */
export function createInMemoryPresenceManager(opts: PresenceManagerOptions = {}): PresenceManager {
  const ttlMs = opts.ttlMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  // key = `${tenantId}:${runId}:${userId}` — tenant in the key == hard isolation.
  const store = new Map<string, StoredParticipant>();
  const key = (s: PresenceScope, userId: string) => `${s.tenantId}:${s.runId}:${userId}`;
  const prefix = (s: PresenceScope) => `${s.tenantId}:${s.runId}:`;

  function snapshot(scope: PresenceScope): RunPresenceParticipant[] {
    const t = now();
    const out: RunPresenceParticipant[] = [];
    for (const [k, v] of store) {
      if (!k.startsWith(prefix(scope))) continue;
      if (v.expiresAt <= t) continue; // expired — treated as gone
      out.push(toPublic(v));
    }
    // Deterministic order: humans before agents, then by userId.
    out.sort((a, b) => (a.peerType === b.peerType ? (a.userId < b.userId ? -1 : 1) : a.peerType === 'human' ? -1 : 1));
    return out;
  }

  return {
    async heartbeat(scope, beat) {
      const t = now();
      store.set(key(scope, beat.userId), {
        runId: scope.runId,
        tenantId: scope.tenantId,
        userId: beat.userId,
        displayName: beat.displayName,
        presence: beat.presence,
        peerType: beat.peerType ?? 'human',
        ...(beat.color !== undefined ? { color: beat.color } : {}),
        ...(beat.cursor !== undefined ? { cursor: beat.cursor } : {}),
        lastHeartbeatAt: t,
        expiresAt: t + ttlMs,
      });
      return snapshot(scope);
    },

    async leave(scope, userId) {
      store.delete(key(scope, userId));
      return snapshot(scope);
    },

    async list(scope) {
      return snapshot(scope);
    },

    async sweep() {
      const t = now();
      const affected = new Map<string, PresenceScope>();
      for (const [k, v] of store) {
        if (v.expiresAt <= t) {
          store.delete(k);
          affected.set(`${v.tenantId}:${v.runId}`, { runId: v.runId, tenantId: v.tenantId });
        }
      }
      return [...affected.values()];
    },
  };
}
