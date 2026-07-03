/**
 * @weaveintel/a11y — Focus restoration across a full re-render.
 *
 * Framework-free UIs that rebuild the DOM on every state change (e.g. a `root.innerHTML = ''`
 * render) DESTROY keyboard focus: after any action a keyboard or screen-reader user is dumped back at the
 * top of the page (WCAG 2.4.3 Focus Order). The fix is: before the re-render, capture a STABLE key for the
 * focused control; after the re-render, find the matching element and refocus it.
 *
 * This module is the pure, testable core of that: turn a description of the focused element into a stable
 * string key, and turn a key back into a CSS selector to re-find it. The app supplies the DOM bits (reading
 * `document.activeElement`, calling `.focus()`, restoring text selection).
 *
 * Design choices (deliberately conservative, so we NEVER focus the wrong thing):
 *  - Restore only for elements with an explicit `data-focus-key` (the app tags the controls that matter:
 *    the composer, nav items, list rows, menu triggers) OR a stable `id`. Anything else → no key → the app
 *    doesn't force focus (safe: focus falls back to the document, exactly as before, for un-keyed elements).
 *  - Selector values are escaped, so a key derived from user content can never break out of the attribute
 *    selector (no selector injection).
 *
 * Pure + zero-dependency.
 */

// C0/C1 control chars + DEL, written via \u escapes so this source stays plain ASCII.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export interface FocusDescriptor {
  /** An explicit, app-assigned stable id for this control (from `data-focus-key`). Preferred. */
  focusKey?: string | null;
  /** The element's DOM id, used when there's no focus-key. */
  id?: string | null;
}

/**
 * Escape a string for safe use inside a double-quoted CSS attribute-selector value (`[attr="…"]`). Strips
 * control characters, then escapes backslashes and double-quotes. Pure — no DOM, no `CSS.escape`.
 */
export function cssEscapeValue(s: string): string {
  return String(s).replace(CONTROL_CHARS, '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a stable key for the focused control, or null when nothing stable is available (→ the caller should
 * NOT try to restore focus). Prefers an explicit `data-focus-key` over a DOM `id`.
 */
export function captureFocusKey(d: FocusDescriptor): string | null {
  const key = typeof d.focusKey === 'string' ? d.focusKey.trim() : '';
  if (key) return `k:${key}`;
  const id = typeof d.id === 'string' ? d.id.trim() : '';
  if (id) return `i:${id}`;
  return null;
}

/**
 * Turn a key from {@link captureFocusKey} back into a CSS selector that re-finds the element after a
 * re-render. Returns null for an unrecognised / empty key. Values are escaped, so the returned selector is
 * always a single, well-formed attribute match (injection-safe).
 */
export function focusSelector(key: string): string | null {
  if (typeof key !== 'string') return null;
  const sep = key.indexOf(':');
  if (sep < 0) return null;
  const kind = key.slice(0, sep);
  const val = key.slice(sep + 1);
  if (!val) return null;
  if (kind === 'k') return `[data-focus-key="${cssEscapeValue(val)}"]`;
  if (kind === 'i') return `[id="${cssEscapeValue(val)}"]`;
  return null;
}
