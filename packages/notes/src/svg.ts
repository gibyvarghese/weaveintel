// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — SVG ILLUSTRATION sanitiser (weaveNotes Phase 4 — creative expansion).
 *
 * For a real picture the AI can't express as boxes-and-arrows or simple ink (a heart, a leaf, a
 * logo), the assistant can author a detailed SVG — vector art with curves, fills and gradients
 * that stays scalable. But an AI-authored (or pasted) SVG is UNTRUSTED markup, and SVG is a
 * notorious XSS vector (`<script>`, `onload=`, `<foreignObject>`, external `href`s, XXE entities).
 *
 * This is the strict gate that makes an SVG safe to store + render. We render illustrations only
 * inside an `<img src="data:image/svg+xml…">` (an INERT context where script never executes), and
 * THIS sanitiser is defence-in-depth for every other path (the share renderer, the artifact
 * download). It is allowlist-minded: strip dangerous elements + all event handlers + any non-inert
 * reference, cap the size, and require a real `<svg>` root — or return `null` (refuse).
 *
 * Pure + zero-dependency (no DOM), so it runs identically on the server and in tests.
 */

const MAX_SVG = 200_000; // 200 KB — a generous cap for a hand-authored illustration

/** Elements that can execute or escape the SVG sandbox — removed wholesale (with their content). */
const DANGEROUS_ELEMENTS = ['script', 'foreignobject', 'iframe', 'embed', 'object', 'audio', 'video', 'animate', 'animatetransform', 'animatemotion', 'set', 'handler', 'listener'];

/**
 * Sanitise an untrusted SVG string. Returns inert, storable SVG markup, or `null` if it has no
 * `<svg>` root, is too large, or cannot be made safe. The result:
 *   - has every `<script>` / `<foreignObject>` / media / animation element removed;
 *   - has every `on*=` event-handler attribute removed;
 *   - has every `href` / `xlink:href` that is not a `#fragment` removed (no external/`javascript:`);
 *   - has DOCTYPE / ENTITY / processing-instructions / comments stripped (anti-XXE);
 *   - is wrapped to declare the SVG namespace if missing.
 */
export function sanitizeSvg(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s.length === 0 || s.length > MAX_SVG) return null;

  // Drop XML prolog / DOCTYPE / ENTITY (XXE) / comments / CDATA wrappers.
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '');
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  s = s.replace(/<!ENTITY[\s\S]*?>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '');

  // Must contain a real <svg> root.
  const svgStart = s.search(/<svg[\s>]/i);
  if (svgStart === -1) return null;
  const svgEnd = s.toLowerCase().lastIndexOf('</svg>');
  if (svgEnd === -1) return null;
  s = s.slice(svgStart, svgEnd + 6);

  // Remove dangerous elements together with their content (handles nested + self-closing).
  for (const el of DANGEROUS_ELEMENTS) {
    s = s.replace(new RegExp(`<${el}\\b[\\s\\S]*?</${el}\\s*>`, 'gi'), '');
    s = s.replace(new RegExp(`<${el}\\b[^>]*/>`, 'gi'), '');
    s = s.replace(new RegExp(`<${el}\\b[^>]*>`, 'gi'), '');
  }

  // Strip every event-handler attribute: on...="..." / on...='...' / on...=bare.
  s = s.replace(/\son[a-z0-9_-]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\son[a-z0-9_-]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\son[a-z0-9_-]+\s*=\s*[^\s>]+/gi, '');

  // Neutralise any href / xlink:href that is not a same-document fragment (#id). This kills
  // javascript:, data:, and external URLs (which could leak / load remote content).
  s = s.replace(/\s(?:xlink:)?href\s*=\s*"([^"]*)"/gi, (m, v: string) => (v.trim().startsWith('#') ? m : ''));
  s = s.replace(/\s(?:xlink:)?href\s*=\s*'([^']*)'/gi, (m, v: string) => (v.trim().startsWith('#') ? m : ''));

  // Belt-and-braces: remove any literal `javascript:` left in an attribute value.
  s = s.replace(/javascript:/gi, '');
  // Remove `style="… url(…) …"` and `expression(` to stop CSS-based fetches/execution.
  s = s.replace(/\sstyle\s*=\s*"[^"]*(?:url\s*\(|expression\s*\()[^"]*"/gi, '');
  s = s.replace(/\sstyle\s*=\s*'[^']*(?:url\s*\(|expression\s*\()[^']*'/gi, '');

  if (s.length > MAX_SVG) return null;
  // Ensure the SVG namespace is declared (so a bare <svg> still renders in an <img>).
  if (!/xmlns\s*=/.test(s)) s = s.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return s;
}

/** Base64-encode a (sanitised) SVG into a `data:image/svg+xml` URI for an inert `<img>`. */
export function svgToDataUri(svg: string): string {
  // Use base64 (handles non-ASCII); btoa is browser-only, Buffer is node-only — pick at runtime.
  const b64 = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(svg)))
    : Buffer.from(svg, 'utf8').toString('base64');
  return `data:image/svg+xml;base64,${b64}`;
}

/** Sanitise + wrap an untrusted SVG into a ready-to-`<img>` data URI, or `null` if unsafe. */
export function svgToSafeDataUri(input: unknown): string | null {
  const clean = sanitizeSvg(input);
  return clean ? svgToDataUri(clean) : null;
}
