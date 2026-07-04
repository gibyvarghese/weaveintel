// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collab — Awareness (ephemeral, in-document live cursors).
 *
 * "Awareness" is the EPHEMERAL state of who-is-editing-and-where: each peer's
 * name, colour, status (a human typing, the agent `composing`), and cursor.
 *
 * --- For someone new to this ---
 * Awareness is the little coloured cursors + name labels you see in a shared doc.
 * It is deliberately kept OUT of the document CRDT and is never saved — it only
 * means "right now". A cursor is stored as a RELATIVE POSITION (anchored to a
 * character's id, not an integer offset) so it does not jump to the wrong place
 * when someone else inserts or deletes text above it.
 *
 * Protocol (mid-2026 research — the Yjs awareness convention): each peer entry
 * carries a `clock` that bumps on every change; a remote entry is applied ONLY if
 * its clock is strictly greater (last-write-wins per peer); a peer that has not
 * refreshed within the TTL (default 30s) is dropped; each peer re-broadcasts its
 * own state every ≤15s. A peer may only mutate its OWN entry.
 */
import type { RgaId, RgaDoc } from './rga.js';
import type { PresenceStatus, PeerKind } from './presence-model.js';

/**
 * A cursor anchored to the document so it survives concurrent edits. `anchorId`
 * is the element the cursor sits just after; `null` = the very start. `assoc`
 * (≥0 sticks after the anchor, <0 before) disambiguates the boundary.
 */
export interface RelativePosition {
  anchorId: RgaId | null;
  assoc: number;
}

/** What a peer publishes about itself (all optional except identity is implied). */
export interface AwarenessState {
  name?: string;
  color?: string;
  /** Human or AI agent — the shared {@link PeerKind}. */
  kind?: PeerKind;
  /** The shared {@link PresenceStatus} (e.g. a human `editing`, the agent `composing`). */
  status?: PresenceStatus;
  /** The peer's cursor, anchored relatively. */
  cursor?: RelativePosition | null;
  [k: string]: unknown;
}

/** The wire form of one peer's awareness entry. */
export interface AwarenessEntry {
  clock: number;
  /** null = the peer went offline. */
  state: AwarenessState | null;
}

export interface AwarenessOptions {
  /** Drop a peer not refreshed within this window (ms). Default 30 000. */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Turn a VISIBLE cursor index into a {@link RelativePosition} anchored to a real
 * element id, so it stays put when other peers edit around it. Anchors to the
 * character BEFORE the cursor (assoc +1 = "stick after that character"); index 0
 * anchors to the start (`null`).
 */
export function cursorFromIndex(doc: RgaDoc, index: number): RelativePosition {
  if (index <= 0) return { anchorId: null, assoc: -1 };
  return { anchorId: doc.idAtVisibleIndex(index), assoc: 1 };
}

/** Resolve a {@link RelativePosition} back to a concrete visible index in `doc`. */
export function indexFromCursor(doc: RgaDoc, pos: RelativePosition): number {
  if (pos.anchorId === null) return 0;
  if (!doc.hasId(pos.anchorId)) return doc.length; // anchor GC'd / unknown → clamp to end
  return doc.visibleIndexOfId(pos.anchorId);
}

/**
 * Per-peer ephemeral awareness. The LOCAL peer owns one entry it may mutate;
 * everyone else's entries are last-write-wins by `clock` and TTL-expired.
 */
export class Awareness {
  readonly localPeerId: string;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #localClock = 0;
  #states = new Map<string, AwarenessEntry & { lastUpdated: number }>();

  constructor(localPeerId: string, opts: AwarenessOptions = {}) {
    this.localPeerId = localPeerId;
    this.#ttlMs = opts.ttlMs ?? 30_000;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** Set/replace the LOCAL peer's state; bumps the clock; returns the wire entry to broadcast. */
  setLocalState(state: AwarenessState | null): AwarenessEntry {
    this.#localClock += 1;
    const entry: AwarenessEntry & { lastUpdated: number } = { clock: this.#localClock, state, lastUpdated: this.#now() };
    this.#states.set(this.localPeerId, entry);
    return { clock: entry.clock, state: entry.state };
  }

  /** Re-publish the local state unchanged (the ≤15s heartbeat) — bumps clock + lastUpdated. */
  refreshLocal(): AwarenessEntry {
    const cur = this.#states.get(this.localPeerId);
    return this.setLocalState(cur?.state ?? null);
  }

  /**
   * Apply a remote peer's entry. Accepted ONLY if `entry.clock` is strictly
   * greater than what we have (last-write-wins). A peer may never write another
   * peer's id as the local id (the caller passes the authenticated peerId).
   * Returns true if it changed our view.
   */
  applyRemote(peerId: string, entry: AwarenessEntry): boolean {
    if (peerId === this.localPeerId) return false; // never let a remote overwrite our own
    const existing = this.#states.get(peerId);
    if (existing && entry.clock <= existing.clock) return false;
    this.#states.set(peerId, { clock: entry.clock, state: entry.state, lastUpdated: this.#now() });
    return true;
  }

  /** The local peer's current entry (for the heartbeat / initial publish). */
  localEntry(): AwarenessEntry | null {
    const cur = this.#states.get(this.localPeerId);
    return cur ? { clock: cur.clock, state: cur.state } : null;
  }

  /** All live peers' states (TTL-filtered, offline `state:null` filtered out). */
  states(): Map<string, AwarenessState> {
    const out = new Map<string, AwarenessState>();
    const cutoff = this.#now() - this.#ttlMs;
    for (const [peerId, entry] of this.#states) {
      if (entry.lastUpdated < cutoff) continue;
      if (entry.state === null) continue;
      out.set(peerId, entry.state);
    }
    return out;
  }

  /** Drop peers not refreshed within the TTL; returns the removed peer ids. */
  expire(): string[] {
    const cutoff = this.#now() - this.#ttlMs;
    const removed: string[] = [];
    for (const [peerId, entry] of this.#states) {
      if (peerId === this.localPeerId) continue;
      if (entry.lastUpdated < cutoff) { this.#states.delete(peerId); removed.push(peerId); }
    }
    return removed;
  }
}
