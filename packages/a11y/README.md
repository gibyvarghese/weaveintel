# @weaveintel/a11y

Framework-agnostic **accessibility utilities** for weaveIntel UIs — pure, dependency-free helpers you can unit-test exhaustively and reuse across the web app, desktop, and mobile.

## Why this exists

geneWeave's web UI is framework-free: it rebuilds the DOM on every state change (`root.innerHTML = ''`). That's simple and fast, but it **destroys keyboard focus** — after any action, a keyboard or screen-reader user is dumped back at the top of the page (WCAG 2.4.3 *Focus Order*). The fix is to snapshot the focused control *before* the re-render and restore it *after*. This package is the pure core of that.

## What's in the box

| Primitive | What it does |
|---|---|
| `captureFocusKey(descriptor)` | Turn a description of the focused element (`{ focusKey?, id? }`) into a **stable string key**, or `null` when nothing dependable is available. Prefers an explicit app-assigned `data-focus-key` over a DOM `id`. Returning `null` is deliberate — the app then does **not** force focus, so it can never focus the *wrong* thing. |
| `focusSelector(key)` | Turn a key back into a **CSS selector** that re-finds the element after the re-render (`[data-focus-key="…"]` / `[id="…"]`). |
| `cssEscapeValue(s)` | Escape a value for safe use inside a double-quoted attribute selector (strips control chars, escapes `\` and `"`) — so a key derived from user content can never **break out of the selector** (no injection). |
| `nextTrapIndex(count, current, shift)` / `FOCUSABLE_SELECTOR` | **Focus-trap math** for modal dialogs (WAI-ARIA "Dialog"): given the number of focusable elements and the current index, where does Tab / Shift+Tab go (wrapping at the ends, clamping strays)? `FOCUSABLE_SELECTOR` is the standard query for tabbable elements. The app queries the dialog + calls `.focus()`; this owns the edge cases (empty trap → -1, single element, wrap-around, focus outside the trap). Used by geneWeave's accessible confirm/notice dialog. |
| `captureScroll()` / `resolveScrollTop()` / `isAtBottom()` | **Scroll preservation** across a full re-render (a `root.innerHTML=''` UI resets every scroll container → the notes list / admin tables / dashboard jump to the top, a layout-shift/CLS problem). Snapshot a container's `{top, atBottom}` before the wipe; `resolveScrollTop` computes where to put it back — pinned to the (new) bottom if the reader was following the bottom, else the exact offset **clamped into the new content height** (so a shorter list leaves no blank gap). Pure arithmetic (the app does the DOM reads/writes); handles non-finite sizes + stale offsets. |

The **DOM bits stay in the app** (reading `document.activeElement`, calling `.focus()`, restoring the text caret) — this package is pure, so it has zero browser dependency and is trivial to test.

```ts
import { captureFocusKey, focusSelector } from '@weaveintel/a11y';

// before re-render
const key = captureFocusKey({ focusKey: el.getAttribute('data-focus-key'), id: el.id });

// after re-render
const sel = key && focusSelector(key);           // e.g. '[data-focus-key="composer"]'
if (sel) (root.querySelector(sel) as HTMLElement | null)?.focus();
```

## Note on the raw-served web UI

geneWeave's browser modules are served as raw ESM (only the notes editor is bundled), so they can't `import` a workspace package directly. The web app therefore **mirrors** this pure logic in `apps/geneweave-ui/src/ui/focus.ts`; the tests here are the spec — keep the two in sync. A **bundled** app (desktop/mobile) can depend on this package directly.

## Status

`focus.ts` shipped with geneWeave Round 4 (focus & keyboard sweep). Pure + zero-dependency; positive / negative / stress / security unit tests in `focus.test.ts`.
