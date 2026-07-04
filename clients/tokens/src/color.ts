/**
 * color.ts — color math for the token engine.
 *
 * Pure, framework-agnostic sRGB color utilities used to compute and verify
 * WCAG 2.1 contrast ratios. No dependencies, no React. Hex colors are the
 * single source of truth across the palette; everything else derives from
 * these helpers so contrast can be audited deterministically (in tests and at
 * runtime for tenant overrides).
 */

/** WCAG 2.1 AA minimum contrast for normal-size text (< 18pt / < 14pt bold). */
export const AA_CONTRAST_NORMAL = 4.5;
/** WCAG 2.1 AA minimum contrast for large text (>= 18pt / >= 14pt bold). */
export const AA_CONTRAST_LARGE = 3.0;

/** A parsed, opaque sRGB color (0-255 channels). */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Parses a 3- or 6-digit hex string into 0-255 channels.
 * Throws on malformed input so a bad token surfaces immediately rather than
 * silently corrupting a contrast computation.
 */
export function parseHex(hex: string): Rgb {
  const match = HEX_RE.exec(hex.trim());
  if (!match) throw new Error(`Invalid hex color: ${JSON.stringify(hex)}`);
  let body = match[1]!;
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  const int = parseInt(body, 16);
  return { r: (int >> 16) & 0xff, g: (int >> 8) & 0xff, b: int & 0xff };
}

/** Converts a single 0-255 sRGB channel to its linear-light value (0-1). */
function channelToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.1 (0 = black, 1 = white). */
export function relativeLuminance(color: Rgb | string): number {
  const { r, g, b } = typeof color === 'string' ? parseHex(color) : color;
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

/**
 * WCAG 2.1 contrast ratio between two colors (1.0 - 21.0). Symmetric — order
 * of arguments does not matter.
 */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Whether a contrast ratio satisfies WCAG AA for the given text size. */
export function meetsAA(ratio: number, large = false): boolean {
  return ratio >= (large ? AA_CONTRAST_LARGE : AA_CONTRAST_NORMAL);
}

/** Rounds a ratio to 2 decimals for stable reporting in audits and tests. */
export function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}
