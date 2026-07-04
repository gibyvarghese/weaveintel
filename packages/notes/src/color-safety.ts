// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — a tiny colour-safety gate.
 *
 * A pure allow-list check that refuses anything that isn't plainly a CSS colour: hex, rgb(a)/hsl(a),
 * or a bare colour keyword. Used to sanitise any colour that flows from untrusted content (AI output,
 * imported strokes, a saved note) before it reaches the DOM — so a note can never smuggle
 * `url(javascript:…)` or an injection through a "colour" field. Zero-dependency; reusable anywhere a
 * colour string must be validated (note ink, diagrams, highlights).
 */

/** Return the input if it is plainly a safe CSS colour, else null. Never throws. */
export function sanitizeColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 32) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^rgba?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
  if (/^hsla?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s.toLowerCase();
  return null;
}
