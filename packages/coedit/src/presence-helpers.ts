// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — live-presence helpers (weaveNotes Phase 3).
 *
 * The {@link Awareness} class already carries the EPHEMERAL who-is-here-and-where state
 * (each peer's name, colour, status, cursor) following the Yjs awareness convention. Phase 3
 * turns that into visible LIVE CURSORS in a note and adds the AI as a first-class participant.
 * These small pure helpers are the shared rules both the server (which injects the AI peer +
 * hardens incoming awareness) and every client (which renders the cursors) agree on:
 *
 *   - `peerColor` — a STABLE, accessible cursor colour per peer (so Alice is the same teal on
 *     every screen). The reserved emerald is excluded — it means "this is the AI" (agency
 *     contract §10.1), so a human cursor can never wear it.
 *   - the AI participant identity (`AI_PARTICIPANT` / `aiPeerId` / `isAiPeerId`) — the synthetic
 *     "weaveIntel AI" peer the server announces while the agent edits a note.
 *   - `sanitizeAwarenessState` — a strict gate the server runs over an INCOMING awareness frame
 *     so a malicious client can never broadcast a giant name, a script-laden "colour", or an
 *     absurd cursor (presence is un-authenticated chatter; it must be bounded + inert).
 *
 * Pure + zero-dependency.
 */
import type { AwarenessState } from './awareness.js';

/**
 * The cursor palette for HUMAN peers — distinct, legible on both the Pro white page and the
 * Creative paper, and deliberately EXCLUDING the AI-reserved emerald (#0E9A6E).
 */
export const CURSOR_COLORS: readonly string[] = [
  '#D85A30', // coral
  '#3B6FB0', // blue
  '#8254C8', // purple
  '#D98A3D', // amber
  '#C84A7B', // magenta
  '#2C8C7C', // teal-dark
  '#B0521F', // rust
  '#5B6BD6', // indigo
] as const;

/** A tiny stable string hash (FNV-1a-ish) — deterministic across server + every client. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * A STABLE cursor colour for a peer key. Pass the peer's USER key (e.g. `u:<userId>`) so all of
 * a person's tabs — and everyone watching them — render the same colour. Never returns emerald.
 */
export function peerColor(key: string): string {
  return CURSOR_COLORS[hashString(key) % CURSOR_COLORS.length]!;
}

/** The synthetic AI participant's identity (agency-contract emerald + woven-mark name). */
export const AI_PARTICIPANT = { name: 'weaveIntel AI', color: '#0E9A6E', peerType: 'ai' as const } as const;

/** The AI participant's peer id for a note (one synthetic peer per note). */
export function aiPeerId(noteId: string): string { return `ai:${noteId}`; }
/** Is this peer id the synthetic AI participant? */
export function isAiPeerId(peerId: string): boolean { return typeof peerId === 'string' && peerId.startsWith('ai:'); }

/** Build the AI participant's awareness state for a given live status (e.g. "composing"). */
export function aiAwarenessState(status: string): AwarenessState {
  return { name: AI_PARTICIPANT.name, color: AI_PARTICIPANT.color, status, peerType: 'ai' };
}

const MAX_NAME = 64;
const MAX_STATUS = 32;
const MAX_POS = 5_000_000; // a note can't be this long; clamps absurd cursor offsets

/** Allow only an inert CSS colour (hex / short named) — never `url()`/CSS injection. */
function safeColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s.toLowerCase();
  return undefined;
}

function safeInt(v: unknown): number | undefined {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= MAX_POS ? n : undefined;
}

/**
 * Strictly sanitise an INCOMING awareness state before it is re-broadcast. Returns a bounded,
 * inert copy (string lengths capped, colour validated, cursor coerced to small integers), or
 * `null` for the "I went offline" frame (an explicit null state). Unknown keys are dropped — a
 * client can never smuggle arbitrary data through the presence channel.
 */
export function sanitizeAwarenessState(state: unknown): AwarenessState | null {
  if (state === null || state === undefined) return null;
  if (typeof state !== 'object') return null;
  const s = state as Record<string, unknown>;
  const out: AwarenessState = {};
  if (typeof s['name'] === 'string') out.name = s['name'].slice(0, MAX_NAME);
  const color = safeColor(s['color']); if (color) out.color = color;
  if (typeof s['status'] === 'string') out.status = s['status'].slice(0, MAX_STATUS);
  if (s['peerType'] === 'human' || s['peerType'] === 'ai') out['peerType'] = s['peerType'];
  // Cursor: a bounded {anchor, head} pair (ProseMirror positions). Either may be absent.
  const cur = s['cursor'];
  if (cur && typeof cur === 'object') {
    const c = cur as Record<string, unknown>;
    const anchor = safeInt(c['anchor']);
    const head = safeInt(c['head']);
    if (anchor !== undefined || head !== undefined) {
      out['cursor'] = { ...(anchor !== undefined ? { anchor } : {}), ...(head !== undefined ? { head } : {}) } as unknown as AwarenessState['cursor'];
    }
  }
  return out;
}
