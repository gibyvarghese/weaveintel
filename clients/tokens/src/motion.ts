/**
 * motion.ts — geneWeave motion tokens + the weave-shimmer spec.
 *
 * Durations are milliseconds; easings are cubic-bezier control-point tuples
 * `[x1, y1, x2, y2]` so they stay framework-agnostic (mobile maps them onto
 * `Easing.bezier(...)` in M3). The weave-shimmer spec describes the teal sweep
 * rendered over in-progress assistant items as plain data; the actual gradient
 * is drawn by the M4 chat surface.
 */

/** Animation durations in milliseconds. */
export interface MotionDurations {
  instant: number;
  fast: number;
  base: number;
  slow: number;
  slower: number;
}

export const durations: MotionDurations = {
  instant: 0,
  fast: 120,
  base: 180,
  slow: 240,
  slower: 320,
};

/** A cubic-bezier easing curve as `[x1, y1, x2, y2]`. */
export type EasingBezier = readonly [number, number, number, number];

export interface MotionEasings {
  /** General-purpose ease for most transitions. */
  standard: EasingBezier;
  /** Entering elements (decelerate into place). */
  decelerate: EasingBezier;
  /** Exiting elements (accelerate away). */
  accelerate: EasingBezier;
  /** Emphasized / playful curve for brand moments. */
  emphasized: EasingBezier;
}

export const easings: MotionEasings = {
  standard: [0.2, 0, 0, 1],
  decelerate: [0, 0, 0, 1],
  accelerate: [0.3, 0, 1, 1],
  emphasized: [0.2, 0, 0, 1.2],
};

/**
 * The "weave shimmer" — the teal animated sweep shown on an in-progress
 * assistant message. Expressed as data so renderers (M4) can drive any
 * gradient/animation implementation from one source of truth.
 *
 * `colorStops` reference {@link ColorTokens} keys (resolved per-theme in
 * theme.ts) so the shimmer always tracks the active accent, including a tenant
 * override.
 */
export interface WeaveShimmerSpec {
  /** ColorTokens keys, in gradient order, that the sweep interpolates across. */
  colorStops: ['accentSoft', 'accent', 'accentSoft'];
  /** Full sweep duration in ms. */
  durationMs: number;
  /** Sweep angle in degrees (0 = left-to-right). */
  angleDeg: number;
  /** Width of the bright band as a fraction of the element width (0-1). */
  bandWidth: number;
}

export const weaveShimmer: WeaveShimmerSpec = {
  colorStops: ['accentSoft', 'accent', 'accentSoft'],
  durationMs: 1400,
  angleDeg: 100,
  bandWidth: 0.4,
};

/** Aggregate motion tokens. */
export interface MotionTokens {
  durations: MotionDurations;
  easings: MotionEasings;
  weaveShimmer: WeaveShimmerSpec;
}

export const motion: MotionTokens = {
  durations,
  easings,
  weaveShimmer,
};
