// SPDX-License-Identifier: MIT
/**
 * Small linear-time string helpers. They replace regular expressions such as
 * `/\/+$/` and `/0+$/`, which backtrack quadratically on long runs of the
 * repeated character that are not at the end of the string.
 */

/** `s` without any run of `ch` (a single character) at its end. */
export function trimTrailingChar(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return end === s.length ? s : s.slice(0, end);
}

/** A base URL without its trailing slashes: "https://x/api//" becomes "https://x/api". */
export const trimTrailingSlashes = (s: string): string => trimTrailingChar(s, '/');

/** `s` without its leading characters that `dropStart` accepts and its trailing ones that `dropEnd` accepts. */
export function trimWhile(s: string, dropStart: (c: string) => boolean, dropEnd: (c: string) => boolean): string {
  let start = 0;
  let end = s.length;
  while (start < end && dropStart(s[start]!)) start++;
  while (end > start && dropEnd(s[end - 1]!)) end--;
  return s.slice(start, end);
}

/**
 * The text between each `open` marker and the next `close` marker after it,
 * in order, like `/open([\s\S]*?)close/g` but in linear time. An `open` with no
 * `close` after it ends the scan (no later `open` could close either).
 */
export function* blocksBetween(s: string, open: string, close: string): Generator<string> {
  let from = 0;
  for (;;) {
    const a = s.indexOf(open, from);
    if (a < 0) return;
    const b = s.indexOf(close, a + open.length);
    if (b < 0) return;
    yield s.slice(a + open.length, b);
    from = b + close.length;
  }
}
