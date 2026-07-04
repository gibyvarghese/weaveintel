/**
 * @weaveintel/collaboration — Streaming answer announcements (accessible live-region policy).
 *
 * A streaming AI answer is an accessibility trap: the naive approach re-renders the transcript on every token,
 * so a screen reader's live region sees the WHOLE conversation as "new" each token and re-reads everything —
 * unusable. This module is the pure, reusable POLICY for what a live region should actually say while an
 * answer streams. The app owns the DOM (a visually-hidden `role="status" aria-live="polite"` region); this
 * decides the TEXT to put in it and when — so the logic is testable and shared across surfaces.
 *
 * Research grounding (WAI-ARIA + 2025 streaming-AI a11y practice):
 *  - Do NOT announce token-by-token — polite live regions queue, so per-token updates produce a garbled
 *    backlog. Announce at meaningful boundaries.
 *  - The dependable, low-noise default is "summary": announce that generation started, then read the COMPLETE
 *    answer once when it finishes (a screen-reader user hears the whole reply cleanly, exactly once).
 *  - A "live" mode, for users who want to follow along, announces sentence-complete chunks on a throttle
 *    (never mid-word), so it's progressive without being spammy.
 *  - An "off" mode respects users who find any live announcement distracting.
 *
 * Everything here is PURE (no DOM, no timers) so it can be unit-tested exhaustively.
 */

export type AnnounceMode = 'summary' | 'live' | 'off';

export const DEFAULT_ANNOUNCE_MIN_INTERVAL_MS = 1200;
export const GENERATING_MESSAGE = 'Generating response…';
export const STOPPED_MESSAGE = 'Response stopped. Partial answer kept.';

/** The text appended between two snapshots of a growing stream (whole `next` if it diverged / reset). */
export function computeAppendedText(prev: unknown, next: unknown): string {
  const p = typeof prev === 'string' ? prev : '';
  const n = typeof next === 'string' ? next : '';
  return n.startsWith(p) ? n.slice(p.length) : n;
}

/** Index just AFTER the last sentence-ending boundary in `s` (0 = no complete sentence yet). */
export function lastSentenceBoundary(s: string): number {
  let idx = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '.' || c === '!' || c === '?' || c === '\n') idx = i;
  }
  return idx + 1;
}

export interface AnnounceInput {
  /** 'start' when generation begins, 'delta' on new tokens, 'done' at completion, 'stopped' on abort. */
  phase: 'start' | 'delta' | 'done' | 'stopped';
  /** The full answer text so far. */
  fullText: unknown;
  /** How many characters of `fullText` have already been announced. */
  lastAnnouncedLen: number;
  mode: AnnounceMode;
  nowMs: number;
  lastAnnounceAtMs: number;
  /** Minimum gap between 'live' announcements (default 1200ms). */
  minIntervalMs?: number;
}

export interface AnnounceResult {
  /** What to place in the live region (null = announce nothing right now). */
  text: string | null;
  /** Updated announced-length pointer to carry into the next call. */
  announcedLen: number;
  /** Updated last-announce timestamp to carry into the next call. */
  announceAtMs: number;
}

/**
 * Decide what a streaming answer's live region should say. Pure: give it the phase + current text + the
 * pointers it returned last time, and it returns the next announcement (or null) plus updated pointers.
 */
export function nextStreamAnnouncement(i: AnnounceInput): AnnounceResult {
  const full = typeof i.fullText === 'string' ? i.fullText : '';
  const safeLen = Math.max(0, Math.min(Math.floor(i.lastAnnouncedLen) || 0, full.length));
  const keep: AnnounceResult = { text: null, announcedLen: safeLen, announceAtMs: i.lastAnnounceAtMs };
  if (i.mode === 'off') return { ...keep, announcedLen: full.length };

  if (i.phase === 'start') return { text: GENERATING_MESSAGE, announcedLen: 0, announceAtMs: i.nowMs };
  if (i.phase === 'stopped') return { text: STOPPED_MESSAGE, announcedLen: full.length, announceAtMs: i.nowMs };
  if (i.phase === 'done') {
    const tail = full.slice(safeLen).trim();
    return { text: tail ? tail : null, announcedLen: full.length, announceAtMs: i.nowMs };
  }

  // phase === 'delta'
  if (i.mode === 'summary') return keep;               // deltas are silent in summary mode
  const minInterval = i.minIntervalMs ?? DEFAULT_ANNOUNCE_MIN_INTERVAL_MS;
  if (i.nowMs - i.lastAnnounceAtMs < minInterval) return keep;   // throttle
  const pending = full.slice(safeLen);
  const boundary = lastSentenceBoundary(pending);
  if (boundary <= 0) return keep;                      // no complete sentence yet — wait
  const chunk = pending.slice(0, boundary).trim();
  if (!chunk) return keep;
  return { text: chunk, announcedLen: safeLen + boundary, announceAtMs: i.nowMs };
}
