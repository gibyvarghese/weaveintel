// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collab — the ONE presence vocabulary.
 *
 * "Who is here, and what are they doing?" shows up at two layers, and they used to each invent their
 * own words for it. This module is the single shared vocabulary both layers now speak:
 *
 *   • EPHEMERAL awareness (in-document live cursors) — the {@link Awareness} clock/TTL model. A peer's
 *     status + colour + cursor, relayed continuously and auto-expired. (Yjs-convention awareness.)
 *   • DURABLE presence (session-level "who's connected") — the {@link PresenceManager} heartbeat model,
 *     backed by a session/participant store.
 *
 * Both describe the SAME thing — a peer (human or AI), their {@link PresenceStatus}, and an optional
 * cursor — so they share {@link PresenceStatus} + {@link PeerKind} + {@link PeerIdentity} here instead
 * of defining parallel look-alikes. The clock/TTL and the session/participant/handoff MECHANISMS stay
 * where they are; only the words are unified.
 */

/**
 * The presence-status vocabulary, shared by ephemeral awareness and durable presence.
 * Human connection/activity states + the two agent activity states.
 */
export type PresenceStatus =
  | 'online'
  | 'idle'
  | 'away'
  | 'offline'
  | 'editing'
  | 'typing'
  | 'working'
  | 'thinking'   // agent
  | 'composing'; // agent

export const PRESENCE_STATUSES: readonly PresenceStatus[] = [
  'online', 'idle', 'away', 'offline', 'editing', 'typing', 'working', 'thinking', 'composing',
];

/** Is this a known presence status? */
export function isPresenceStatus(v: unknown): v is PresenceStatus {
  return typeof v === 'string' && (PRESENCE_STATUSES as readonly string[]).includes(v);
}

/** Coerce arbitrary input to a valid {@link PresenceStatus} (defensive against untrusted awareness). */
export function normalizePresenceStatus(v: unknown, fallback: PresenceStatus = 'online'): PresenceStatus {
  return isPresenceStatus(v) ? v : fallback;
}

/** A peer is either a person or an AI agent. */
export type PeerKind = 'human' | 'agent';

/**
 * The identity of one peer — the shared shape across awareness + presence.
 * `id` is a stable peer id (a user id, or an `agent:*` site id for the AI).
 */
export interface PeerIdentity {
  id: string;
  name: string;
  color?: string;
  kind: PeerKind;
}
