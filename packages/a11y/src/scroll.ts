/**
 * @weaveintel/a11y — Scroll-position preservation across a full re-render.
 *
 * A framework-free UI that rebuilds the DOM on every state change (`root.innerHTML = ''`) resets the scroll
 * position of EVERY scroll container. For a reader that's jarring — the notes list, an admin table, the
 * dashboard all jump to the top after any action (a layout-shift / CLS problem). The fix is the same one the
 * chat transcript already uses: SNAPSHOT each container's scroll before the rebuild, then RESTORE it after —
 * pinning to the bottom only if the reader was already there (so a growing/streaming list keeps following),
 * otherwise putting them back at their exact place.
 *
 * This module is the pure arithmetic of that (the DOM reads/writes live in the app), so the edge cases —
 * "were they at the bottom?", "clamp a stale offset to the new content height", non-finite inputs — are
 * exhaustively testable. Pure + zero-dependency.
 */

export interface ScrollSnapshot {
  /** The scrollTop at capture time. */
  top: number;
  /** Was the container scrolled to (within `threshold` of) the bottom? Then restore should follow the bottom. */
  atBottom: boolean;
}

/** How close to the bottom (px) still counts as "at the bottom" (so a near-bottom reader keeps following). */
export const DEFAULT_AT_BOTTOM_THRESHOLD = 24;

function finite(n: unknown): number { return typeof n === 'number' && Number.isFinite(n) ? n : 0; }

/** Is the container scrolled to (near) the bottom? Non-finite inputs → false (safe: don't force-follow). */
export function isAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = DEFAULT_AT_BOTTOM_THRESHOLD): boolean {
  if (![scrollTop, scrollHeight, clientHeight].every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  const gap = scrollHeight - (scrollTop + clientHeight);
  return gap <= Math.max(0, finite(threshold));
}

/** Snapshot a container's scroll state before a re-render. */
export function captureScroll(m: { scrollTop: number; scrollHeight: number; clientHeight: number }, threshold = DEFAULT_AT_BOTTOM_THRESHOLD): ScrollSnapshot {
  return { top: Math.max(0, finite(m.scrollTop)), atBottom: isAtBottom(m.scrollTop, m.scrollHeight, m.clientHeight, threshold) };
}

/**
 * The scrollTop to set AFTER the re-render. Pins to the (new) bottom when the reader was at the bottom;
 * otherwise clamps the saved offset into the new content's range (so a shorter list can't leave a blank gap).
 * A missing snapshot → 0 (top).
 */
export function resolveScrollTop(saved: ScrollSnapshot | null | undefined, scrollHeight: number, clientHeight: number): number {
  const max = Math.max(0, finite(scrollHeight) - finite(clientHeight));
  if (!saved) return 0;
  if (saved.atBottom) return max;
  return Math.max(0, Math.min(finite(saved.top), max));
}
