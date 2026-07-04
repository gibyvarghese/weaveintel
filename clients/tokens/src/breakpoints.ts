/**
 * breakpoints.ts — responsive breakpoints for the an adaptive shell.
 *
 * Values are `min-width` thresholds in CSS pixels. Per 2026 practice we treat the 600–899 "foldable /
 * small-tablet" range explicitly rather than jumping 320→768→1024. The adaptive rule of thumb:
 *
 *   < tablet (900)  → side rails become overlay drawers / bottom-sheets; Notes clamps to 1 column.
 *   tablet          → one rail persistent, the other an on-demand drawer; Notes ≤ 2 columns.
 *   ≥ desktop       → both rails persistent; Notes up to 3 columns.
 *
 * Framework-agnostic (numbers + names only); the web layer turns these into `@media` / container queries,
 * native consumers use the raw numbers.
 */

export interface Breakpoints {
  /** ≥600: large phones, foldables unfolded, the smallest tablets. */
  readonly foldable: number;
  /** ≥900: tablets — one rail can stay open. */
  readonly tablet: number;
  /** ≥1200: laptops/desktops — both rails + up to 3 columns. */
  readonly desktop: number;
  /** ≥1600: wide screens — comfortable max content width. */
  readonly wide: number;
}

export const breakpoints: Breakpoints = {
  foldable: 600,
  tablet: 900,
  desktop: 1200,
  wide: 1600,
};

/** A CSS `min-width` media query string for a named breakpoint (e.g. `mediaUp('tablet')`). */
export function mediaUp(bp: keyof Breakpoints): string {
  return `(min-width: ${breakpoints[bp]}px)`;
}

/** A CSS `max-width` media query string just below a named breakpoint (e.g. `mediaBelow('tablet')`). */
export function mediaBelow(bp: keyof Breakpoints): string {
  return `(max-width: ${breakpoints[bp] - 0.02}px)`;
}
