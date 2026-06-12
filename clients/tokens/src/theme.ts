/**
 * theme.ts — assembled themes + per-tenant theming + contrast audit.
 *
 * A `Theme` is the fully-resolved set of tokens a UI consumes. Two base themes
 * ship (`themes.dark`, `themes.light`). Tenants may supply a partial
 * {@link TenantThemeOverride} (brand color, fonts, corner style) that merges
 * over a base theme via {@link resolveTenantTheme} — a pure, non-mutating deep
 * merge. {@link auditThemeContrast} verifies every text-on-surface pair against
 * WCAG-AA, and {@link applyTenantTheme} composes the two so a tenant override
 * that would break accessibility degrades gracefully back to the base theme.
 *
 * Framework-agnostic: no React, no DB, no fetch. The host (mobile app, M3)
 * decides where a tenant override comes from and feeds it in.
 */

import { contrastRatio, meetsAA, roundRatio, AA_CONTRAST_NORMAL, AA_CONTRAST_LARGE } from './color.js';
import { darkColors, lightColors, type ColorTokens } from './palette.js';
import { typography, type FontFamilies, type TypographyTokens } from './typography.js';
import { spacing, radii, darkElevation, lightElevation, type SpacingScale, type RadiiScale, type ElevationScale } from './spacing.js';
import { motion, type MotionTokens } from './motion.js';

export type ThemeName = 'dark' | 'light';

/** A fully-resolved theme. */
export interface Theme {
  name: ThemeName;
  colors: ColorTokens;
  typography: TypographyTokens;
  spacing: SpacingScale;
  radii: RadiiScale;
  elevation: ElevationScale;
  motion: MotionTokens;
}

/** The two base brand themes. */
export const themes: Readonly<Record<ThemeName, Theme>> = {
  dark: {
    name: 'dark',
    colors: darkColors,
    typography,
    spacing,
    radii,
    elevation: darkElevation,
    motion,
  },
  light: {
    name: 'light',
    colors: lightColors,
    typography,
    spacing,
    radii,
    elevation: lightElevation,
    motion,
  },
};

// ---------------------------------------------------------------------------
// Per-tenant theming
// ---------------------------------------------------------------------------

/**
 * The brandable subset a tenant may override. Structural tokens that affect
 * layout correctness (spacing grid, elevation, motion) are intentionally NOT
 * overridable — only colors, font families, and corner radii.
 */
export interface TenantThemeOverride {
  colors?: Partial<ColorTokens>;
  typography?: { families?: Partial<FontFamilies> };
  radii?: Partial<RadiiScale>;
}

/**
 * Merges a tenant override over a base theme and returns a NEW theme. Pure —
 * the base theme is never mutated, and absent override keys fall through to the
 * base value. Always succeeds for a well-typed override (accessibility is
 * checked separately via {@link auditThemeContrast}).
 */
export function resolveTenantTheme(base: Theme, override?: TenantThemeOverride): Theme {
  if (!override) return base;
  return {
    name: base.name,
    colors: { ...base.colors, ...(override.colors ?? {}) },
    typography: override.typography?.families
      ? { ...base.typography, families: { ...base.typography.families, ...override.typography.families } }
      : base.typography,
    spacing: base.spacing,
    radii: { ...base.radii, ...(override.radii ?? {}) },
    elevation: base.elevation,
    motion: base.motion,
  };
}

// ---------------------------------------------------------------------------
// Contrast audit
// ---------------------------------------------------------------------------

/** Result for one audited foreground/background pair. */
export interface ContrastPairResult {
  /** Human-readable pair name, e.g. `text on surface`. */
  pair: string;
  foreground: keyof ColorTokens;
  background: keyof ColorTokens;
  ratio: number;
  /** Required minimum (4.5 normal, 3.0 large). */
  required: number;
  large: boolean;
  ok: boolean;
}

/** Aggregate audit for a theme. */
export interface ThemeContrastAudit {
  themeName: ThemeName;
  pass: boolean;
  pairs: ContrastPairResult[];
  /** Subset of `pairs` that failed; empty when `pass` is true. */
  failures: ContrastPairResult[];
}

interface PairSpec {
  foreground: keyof ColorTokens;
  background: keyof ColorTokens;
  large: boolean;
}

const SURFACES: Array<keyof ColorTokens> = ['background', 'surface', 'surfaceElevated'];

/** The text-on-surface pairs every theme must satisfy. */
function contrastPairSpecs(): PairSpec[] {
  const specs: PairSpec[] = [];
  // Primary + secondary text are normal-size; muted text + accent are large.
  for (const bg of SURFACES) {
    specs.push({ foreground: 'text', background: bg, large: false });
    specs.push({ foreground: 'textSecondary', background: bg, large: false });
    specs.push({ foreground: 'textMuted', background: bg, large: true });
    specs.push({ foreground: 'accent', background: bg, large: true });
    specs.push({ foreground: 'accentStrong', background: bg, large: false });
  }
  // Button label on an accent fill.
  specs.push({ foreground: 'onAccent', background: 'accentStrong', large: false });
  // Status colors on the app background.
  specs.push({ foreground: 'danger', background: 'background', large: false });
  specs.push({ foreground: 'success', background: 'background', large: false });
  specs.push({ foreground: 'warning', background: 'background', large: false });
  return specs;
}

/**
 * Audits every text-on-surface pair in a theme against WCAG-AA. Pure and
 * total — never throws (a malformed hex would throw in parseHex, but themes
 * here are always well-formed). Use on a tenant-resolved theme to decide
 * whether the override is safe to apply.
 */
export function auditThemeContrast(theme: Theme): ThemeContrastAudit {
  const pairs = contrastPairSpecs().map<ContrastPairResult>((spec) => {
    const ratio = roundRatio(contrastRatio(theme.colors[spec.foreground], theme.colors[spec.background]));
    const required = spec.large ? AA_CONTRAST_LARGE : AA_CONTRAST_NORMAL;
    return {
      pair: `${spec.foreground} on ${spec.background}`,
      foreground: spec.foreground,
      background: spec.background,
      ratio,
      required,
      large: spec.large,
      ok: meetsAA(ratio, spec.large),
    };
  });
  const failures = pairs.filter((p) => !p.ok);
  return { themeName: theme.name, pass: failures.length === 0, pairs, failures };
}

/**
 * Resolves a tenant override AND enforces accessibility. Returns the merged
 * theme with its audit; when `enforceContrast` is true (default) and the merged
 * theme fails AA, the base theme is returned instead so a misconfigured tenant
 * brand can never ship an inaccessible UI. Graceful by construction — never
 * throws.
 */
export function applyTenantTheme(
  base: Theme,
  override?: TenantThemeOverride,
  opts: { enforceContrast?: boolean } = {},
): { theme: Theme; audit: ThemeContrastAudit; degraded: boolean } {
  const enforceContrast = opts.enforceContrast ?? true;
  const merged = resolveTenantTheme(base, override);
  const audit = auditThemeContrast(merged);
  if (enforceContrast && !audit.pass) {
    return { theme: base, audit, degraded: true };
  }
  return { theme: merged, audit, degraded: false };
}
