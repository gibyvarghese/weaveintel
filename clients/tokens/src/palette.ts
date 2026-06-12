/**
 * palette.ts — geneWeave brand color palettes (dark + light).
 *
 * The dark palette is the canonical brand surface (deep green-black with a
 * teal accent), grounded in the shipped geneWeave product UI. The light
 * palette is derived to satisfy WCAG-AA contrast for every text-on-surface
 * pair (verified by the contrast audit test) — it is intentionally NOT a
 * verbatim copy of the product's light CSS, whose muted tones predate the AA
 * requirement.
 *
 * Token names are semantic (role-based), not positional, so consumers never
 * depend on a raw `bg2`/`fg3` index and tenant overrides read clearly.
 */

/** Semantic, role-based color tokens. Every value is an opaque hex string. */
export interface ColorTokens {
  /** App background — the lowest surface. */
  background: string;
  /** Default card / sheet surface raised above the background. */
  surface: string;
  /** Surface for elements raised above a card (popovers, active rows). */
  surfaceElevated: string;
  /** Border / divider color. */
  border: string;

  /** Primary text. */
  text: string;
  /** Secondary text (subtitles, captions that are still normal-size text). */
  textSecondary: string;
  /** Muted text (timestamps, placeholders) — treated as large/secondary. */
  textMuted: string;

  /** Brand accent for icons, large text, and decorative fills. */
  accent: string;
  /** Stronger accent guaranteed to meet AA for normal text on surfaces. */
  accentStrong: string;
  /** Soft accent tint for backgrounds (chips, in-progress shimmer base). */
  accentSoft: string;
  /** Text/icon color placed on top of an `accentStrong` fill. */
  onAccent: string;

  /** Destructive / error. */
  danger: string;
  /** Positive / success. */
  success: string;
  /** Caution / warning. */
  warning: string;
}

/** Canonical dark brand palette (deep green-black + teal). */
export const darkColors: ColorTokens = {
  background: '#0E1713',
  surface: '#121E19',
  surfaceElevated: '#1A2B23',
  border: '#2E4339',

  text: '#E5F2EC',
  textSecondary: '#B4CBC0',
  textMuted: '#88A498',

  accent: '#34C9A5',
  accentStrong: '#3DD6B0',
  accentSoft: '#1C3A31',
  onAccent: '#06120D',

  danger: '#F87171',
  success: '#4ADE80',
  warning: '#FBBF24',
};

/** AA-tuned light brand palette. */
export const lightColors: ColorTokens = {
  background: '#EDF5F0',
  surface: '#F7FBF8',
  surfaceElevated: '#FFFFFF',
  border: '#D4E0DA',

  text: '#14241D',
  textSecondary: '#46574F',
  textMuted: '#5A6B63',

  accent: '#1E8A6F',
  accentStrong: '#136B53',
  accentSoft: '#E0F5EE',
  onAccent: '#FFFFFF',

  danger: '#B91C1C',
  success: '#15803D',
  warning: '#B45309',
};
