/**
 * @weaveintel/tokens — a brand-neutral theming ENGINE.
 *
 * Framework-agnostic, zero runtime dependencies (no React import, no DB, no fetch). It provides the
 * MACHINERY of a design-token system and TAKES A PALETTE AS INPUT — it is not tied to any brand:
 *
 *  - the token schema/types ({@link ColorTokens}, {@link Theme}, {@link TenantThemeOverride}, …);
 *  - colour maths: {@link contrastRatio} / {@link meetsAA} (WCAG-AA);
 *  - the WEB transform {@link toCssVariables} (DTCG-shaped tokens → CSS custom properties, with a
 *    configurable prefix so an app names its own `--brand-*` variables);
 *  - per-tenant white-label functions ({@link resolveTenantTheme}, {@link applyTenantTheme},
 *    {@link tenantThemeVars}) that enforce accessibility — a failing override degrades gracefully to
 *    the base theme rather than shipping an inaccessible UI;
 *  - generic scales (4-pt spacing grid, radii, type scale, motion, breakpoints, elevation); and
 *  - NEUTRAL reference palettes/themes ({@link neutralDark} / {@link neutralLight} /
 *    {@link neutralThemes} / {@link defaultTheme}) so the engine is self-contained and demonstrable.
 *
 * An app supplies its own palette + fonts + CSS prefix and composes them on this engine (a consuming
 * app keeps its brand in its own `src/brand/`). Nothing about any product's brand lives here.
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

// Neutral reference palettes (the engine's brand-agnostic defaults; apps supply their own).
export { neutralDark, neutralLight, type ColorTokens } from './palette.js';

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

// Web transform — CSS custom properties (`--<prefix>-*`, prefix configurable) so the web shares the
// same source of truth as native, including per-tenant brand overrides (white-label), AA-enforced.
export {
  toCssVariables,
  tenantThemeVars,
  tenantThemeCss,
  DEFAULT_CSS_PREFIX,
  type CssVarsOptions,
  type TenantThemeVars,
  type TenantThemeOptions,
  type BaseThemes,
} from './css.js';

// Neutral reference themes + per-tenant theming + contrast audit (engine functions work on ANY theme).
export {
  neutralThemes,
  defaultTheme,
  resolveTenantTheme,
  applyTenantTheme,
  auditThemeContrast,
  type Theme,
  type ThemeName,
  type TenantThemeOverride,
  type ContrastPairResult,
  type ThemeContrastAudit,
} from './theme.js';
