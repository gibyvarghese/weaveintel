/**
 * @weaveintel/a11y — Focus-trap math for modal dialogs.
 *
 * A modal (an accessible confirm/notice dialog, a settings panel) must TRAP keyboard focus: Tab from the
 * last control wraps to the first, Shift+Tab from the first wraps to the last, and focus can never escape to
 * the page behind the backdrop (WAI-ARIA APG "Dialog (Modal)"). The DOM part — finding the focusable
 * elements and calling `.focus()` — belongs to the app; the PURE part is the index arithmetic, which is what
 * actually has edge cases (empty trap, single element, wrap-around, focus currently outside the trap). That's
 * here, so it's exhaustively testable.
 *
 * Pure + zero-dependency.
 */

/**
 * The standard selector for TABBABLE elements inside a container: links with an href, enabled form controls
 * and buttons, and anything with an explicit non-negative tabindex. Excludes disabled controls and
 * `tabindex="-1"` (programmatically-focusable-but-not-tabbable). The app queries a dialog with this.
 */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The index to focus when Tab / Shift+Tab is pressed inside a trap of `count` focusable elements, wrapping at
 * the ends. `current` is the index the focus is on now (pass -1 when focus is not on a trap element — e.g.
 * focus is on the dialog container itself). Returns -1 only when there is nothing focusable.
 *
 *   Tab       from the last  (or off-trap) → 0        (first)
 *   Shift+Tab from the first (or off-trap) → count-1  (last)
 */
export function nextTrapIndex(count: number, current: number, shift: boolean): number {
  const n = Number.isFinite(count) ? Math.floor(count) : 0;
  if (n <= 0) return -1;
  // Clamp a stray current into [-1, n-1] so an out-of-range value can never yield an out-of-range result.
  const raw = Number.isFinite(current) ? Math.floor(current) : -1;
  const cur = raw < -1 ? -1 : raw > n - 1 ? n - 1 : raw;
  if (shift) return cur <= 0 ? n - 1 : cur - 1;
  return cur >= n - 1 ? 0 : cur + 1;
}
