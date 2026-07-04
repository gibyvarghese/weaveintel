# @weaveintel/a11y

**Tiny, dependency-free DOM helpers for the accessibility problems that break when a UI re-renders — focus restoration, focus trapping, and scroll preservation.**

## Why it exists

When a live agent UI redraws itself, small courtesies quietly break: the button you were tabbed to vanishes and your keyboard focus falls back to the top of the page; the chat you'd scrolled to the bottom of jumps somewhere else. It's like a librarian reshelving the whole room while you're mid-sentence — you lose your finger on the page. These helpers are pure functions that let you *remember where the reader was* before the re-render and *put them back* after: which element had focus, whether the log was pinned to the bottom, where to scroll to. They touch no framework and pull in no dependencies.

## When to reach for it

Reach for it when you're hand-rolling a UI (vanilla DOM, or a framework where you manage focus/scroll yourself) and need correct, testable accessibility behaviour across re-renders. Because these are low-level primitives, you wire them into your own event handlers. If a framework already gives you focus management you trust, you may not need this. For UI *event* builders (approvals, widgets), see `@weaveintel/ui-primitives`.

## How to use it

```ts
import { captureFocusKey, focusSelector, captureScroll, isAtBottom, resolveScrollTop } from '@weaveintel/a11y';

// Before a re-render: remember focus + the scroll position.
const focusKey = captureFocusKey({ focusKey: el.getAttribute('data-focus-key'), id: el.id });
const scroll = captureScroll(logEl);

// ...re-render the DOM...

// After: restore focus, and put scroll back (pinned to bottom if the reader was following it).
const sel = focusKey && focusSelector(focusKey);
if (sel) (logEl.querySelector(sel) as HTMLElement | null)?.focus();
logEl.scrollTop = resolveScrollTop(scroll, logEl.scrollHeight, logEl.clientHeight);
```

## What's in the box

| Export | What it does |
| --- | --- |
| `captureFocusKey`, `focusSelector`, `cssEscapeValue` | Remember the focused element and rebuild a safe selector to restore it |
| `FocusDescriptor` | The type describing a captured focus target |
| `FOCUSABLE_SELECTOR`, `nextTrapIndex` | Focus-trap wrap-around math for modal dialogs |
| `captureScroll`, `resolveScrollTop`, `isAtBottom`, `DEFAULT_AT_BOTTOM_THRESHOLD` | Preserve scroll position and detect "pinned to bottom" |
| `ScrollSnapshot` | The type describing a captured scroll position |

The DOM reads and writes (reading `document.activeElement`, calling `.focus()`, restoring the caret) stay in your app — this package is pure arithmetic and string logic, so it has zero browser dependency and is trivial to test.

## License

MIT.
