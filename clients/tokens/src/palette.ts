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

  // ── geneWeave weaveNotes additions (spec §10.2) — the "colour encodes agency" palette.
  /** Notes page surface in Creative theme (warm paper). */
  paper: string;
  /** AI surface tint (agent bubbles, AI blocks, active rows). Same family as accentSoft. */
  mint: string;
  /** Hover/border on mint surfaces. */
  mintDeep: string;
  /** Human ink / doodles. */
  coral: string;
  /** Attention only (overdue, unsaved) — sparing. */
  amber: string;
  /** Multi-colour highlighter set. */
  hlAmber: string; hlPink: string; hlTeal: string; hlBlue: string;
  /** Inline-diff (AI suggestion) colours. */
  diffAddedBg: string; diffRemovedBg: string; diffRemovedFg: string;
  /** Demoted destructive (danger-zone card) colours. */
  dangerZoneBg: string; dangerZoneBorder: string; dangerZoneFg: string;
}

/** Canonical dark brand palette — geneWeave dark (deep green-black + bright emerald). */
export const darkColors: ColorTokens = {
  background: '#0E1714',
  surface: '#15201C',
  surfaceElevated: '#1B2723',
  border: '#2A3833',

  text: '#E8EFEB',
  textSecondary: '#AEC2B9',
  textMuted: '#9DB3A9',

  accent: '#2FD39B',        // reversed-emerald (large/decorative on dark)
  accentStrong: '#3FE0A8',  // bright — normal text on dark surfaces
  accentSoft: '#16332A',    // mint, dark
  onAccent: '#06120D',      // dark ink on a bright accent fill

  danger: '#F08A60',
  success: '#3FE0A8',
  warning: '#E0A87F',

  paper: '#141E18',
  mint: '#16332A',
  mintDeep: '#1C3F33',
  coral: '#F08A60',
  amber: '#E0A87F',
  hlAmber: '#FAC775', hlPink: '#F4C0D1', hlTeal: '#9FE1CB', hlBlue: '#B5D4F4',
  diffAddedBg: '#16332A', diffRemovedBg: '#3A201A', diffRemovedFg: '#D4A595',
  dangerZoneBg: '#241A14', dangerZoneBorder: '#3A2A1E', dangerZoneFg: '#E0A87F',
};

/** geneWeave light palette (the canonical weaveNotes surface — spec §10.2). AA-verified. */
export const lightColors: ColorTokens = {
  background: '#F6F8F7',     // canvas
  surface: '#FFFFFF',
  surfaceElevated: '#FFFFFF',
  border: '#E7ECEA',         // hairline

  text: '#14201B',           // ink
  textSecondary: '#5E6E67',  // muted
  textMuted: '#5E6E67',      // muted (large-text use)

  accent: '#0E9A6E',         // emerald (large/decorative + AI presence)
  accentStrong: '#0B7A57',   // emerald-press (normal text + on-mint text)
  accentSoft: '#E8F5EE',     // mint
  onAccent: '#FFFFFF',

  danger: '#B91C1C',
  success: '#15803D',
  warning: '#B45309',

  paper: '#FBF8F1',
  mint: '#E8F5EE',
  mintDeep: '#DCEFE5',
  coral: '#D85A30',
  amber: '#D98A3D',
  hlAmber: '#FAC775', hlPink: '#F4C0D1', hlTeal: '#9FE1CB', hlBlue: '#B5D4F4',
  diffAddedBg: '#E8F5EE', diffRemovedBg: '#FBEFEA', diffRemovedFg: '#9C6B5C',
  dangerZoneBg: '#FCF7F2', dangerZoneBorder: '#F0E0D5', dangerZoneFg: '#A8551F',
};
