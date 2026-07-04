/**
 * palette.ts — the theming engine's NEUTRAL reference palettes (dark + light).
 *
 * These are brand-AGNOSTIC defaults (a slate + blue set) so `@weaveintel/tokens` is usable and
 * demonstrable on its own. Every text-on-surface pair is WCAG-AA verified by the contrast audit test.
 * An app supplies its OWN palette with the same {@link ColorTokens} shape (see a consuming app's own `src/brand/`) and feeds it to the same engine — the palette is INPUT, not baked in.
 *
 * Token names are semantic (role-based), not positional, so consumers never depend on a raw `bg2`/`fg3`
 * index and tenant overrides read clearly.
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

  // ── Optional "colour encodes agency" roles — an app may map these to human/AI attribution.
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

/**
 * The engine's NEUTRAL reference dark palette — a brand-agnostic slate + blue set, AA-verified for
 * every text-on-surface pair. It is the default so the engine is self-contained and demonstrable; an
 * app supplies its OWN palette (e.g. an app brand) with the same {@link ColorTokens} shape.
 */
export const neutralDark: ColorTokens = {
  background: '#0F172A',
  surface: '#1E293B',
  surfaceElevated: '#334155',
  border: '#334155',

  text: '#F1F5F9',
  textSecondary: '#CBD5E1',
  textMuted: '#94A3B8',

  accent: '#60A5FA',        // blue-400 (large/decorative on dark)
  accentStrong: '#93C5FD',  // blue-300 (normal text on dark surfaces)
  accentSoft: '#1E3A5F',
  onAccent: '#0F172A',      // dark ink on a bright accent fill

  danger: '#F87171',
  success: '#4ADE80',
  warning: '#FBBF24',

  paper: '#1A2331',
  mint: '#1E3A5F',
  mintDeep: '#25476F',
  coral: '#FB923C',
  amber: '#FBBF24',
  hlAmber: '#78350F', hlPink: '#831843', hlTeal: '#134E4A', hlBlue: '#1E3A5F',
  diffAddedBg: '#14332A', diffRemovedBg: '#3A201A', diffRemovedFg: '#FCA5A5',
  dangerZoneBg: '#2A1A1A', dangerZoneBorder: '#4A2A2A', dangerZoneFg: '#FCA5A5',
};

/**
 * The engine's NEUTRAL reference light palette — slate + blue, AA-verified for every text-on-surface
 * pair. Apps override with their own {@link ColorTokens}; the tenant white-label functions and the
 * contrast audit work identically on any palette.
 */
export const neutralLight: ColorTokens = {
  background: '#FFFFFF',
  surface: '#F8FAFC',
  surfaceElevated: '#FFFFFF',
  border: '#E2E8F0',

  text: '#0F172A',
  textSecondary: '#334155',
  textMuted: '#64748B',

  accent: '#2563EB',         // blue-600 (large/decorative)
  accentStrong: '#1D4ED8',   // blue-700 (normal text)
  accentSoft: '#EFF6FF',
  onAccent: '#FFFFFF',

  danger: '#B91C1C',
  success: '#15803D',
  warning: '#B45309',

  paper: '#FAFAF9',
  mint: '#EFF6FF',
  mintDeep: '#DBEAFE',
  coral: '#EA580C',
  amber: '#D97706',
  hlAmber: '#FEF3C7', hlPink: '#FCE7F3', hlTeal: '#CCFBF1', hlBlue: '#DBEAFE',
  diffAddedBg: '#F0FDF4', diffRemovedBg: '#FEF2F2', diffRemovedFg: '#991B1B',
  dangerZoneBg: '#FEF2F2', dangerZoneBorder: '#FECACA', dangerZoneFg: '#991B1B',
};
