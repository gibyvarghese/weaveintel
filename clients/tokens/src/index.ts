/**
 * @weaveintel/tokens — geneWeave mobile brand design system.
 *
 * Framework-agnostic, zero runtime dependencies (no React import, no DB, no
 * fetch). Exports the full brand system as typed constants:
 *
 *  - dark/light color palettes with WCAG-AA contrast verified for every
 *    text-on-surface pair (see {@link auditThemeContrast});
 *  - a typography scale (Fraunces / Plus Jakarta Sans / DM Mono);
 *  - a 4-pt spacing grid, radii, and per-theme elevation;
 *  - motion durations / easings and the weave-shimmer spec;
 *  - assembled {@link themes} (`dark` / `light`); and
 *  - per-tenant theming: {@link TenantThemeOverride}, {@link resolveTenantTheme},
 *    and {@link applyTenantTheme}, so a tenant can re-brand colors / fonts /
 *    corner style while accessibility is enforced (a failing override degrades
 *    gracefully to the base theme rather than shipping an inaccessible UI).
 */

/**
 * Schema version for the exported token shape. Bumped when the token contract
 * changes in a way consumers must react to. Consumers (api-client, mobile)
 * pin against this so a token reshape surfaces as a typed, reviewable change.
 */
export const TOKENS_SCHEMA_VERSION = 1 as const;

// Color math + contrast helpers.
export {
  AA_CONTRAST_NORMAL,
  AA_CONTRAST_LARGE,
  parseHex,
  relativeLuminance,
  contrastRatio,
  meetsAA,
  roundRatio,
  type Rgb,
} from './color.js';

// Color palettes.
export { darkColors, lightColors, type ColorTokens } from './palette.js';

// Typography.
export {
  fontFamilies,
  fontWeights,
  typeScale,
  typography,
  type FontFamilies,
  type FontWeights,
  type TextStyleToken,
  type TypeScale,
  type TypographyTokens,
} from './typography.js';

// Spacing, radii, elevation.
export {
  SPACING_BASE_UNIT,
  spacing,
  radii,
  darkElevation,
  lightElevation,
  type SpacingScale,
  type RadiiScale,
  type ElevationLevel,
  type ElevationScale,
} from './spacing.js';

// Motion + weave-shimmer.
export {
  durations,
  easings,
  weaveShimmer,
  motion,
  type MotionDurations,
  type MotionEasings,
  type EasingBezier,
  type WeaveShimmerSpec,
  type MotionTokens,
} from './motion.js';

// Responsive breakpoints (adaptive shell: rails → drawers/sheets below tablet).
export {
  breakpoints,
  mediaUp,
  mediaBelow,
  type Breakpoints,
} from './breakpoints.js';

// Web transform — CSS custom properties (`--gw-*`) so the web app shares the native source of truth,
// including per-tenant brand overrides (white-label), accessibility-enforced.
export {
  toCssVariables,
  themeCss,
  tenantThemeVars,
  tenantThemeCss,
  type ThemeCssOptions,
  type TenantThemeVars,
} from './css.js';

// Assembled themes + per-tenant theming + contrast audit.
export {
  themes,
  resolveTenantTheme,
  applyTenantTheme,
  auditThemeContrast,
  type Theme,
  type ThemeName,
  type TenantThemeOverride,
  type ContrastPairResult,
  type ThemeContrastAudit,
} from './theme.js';
