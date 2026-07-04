/**
 * css.ts — the WEB transform for the token engine (brand-neutral).
 *
 * Turns a framework-agnostic {@link Theme} into CSS custom properties so the web shares the SAME
 * single source of truth as any native app. This is the in-house, zero-dependency equivalent of a
 * Style-Dictionary "css/variables" transform: DTCG-shaped tokens in, platform CSS out.
 *
 *   toCssVariables(theme, { prefix })  → a flat { '--<prefix>-color-accent': '#…', … } map (one theme).
 *   tenantThemeVars(bases, override)   → ONLY the vars a per-tenant white-label override changes,
 *                                        for light + dark, accessibility-enforced.
 *
 * The CSS variable PREFIX is a parameter (default `wv`) — an app passes its own brand prefix (e.g. `gw`
 * → `--gw-*`). The engine never hardcodes a brand's names; the app's full stylesheet assembly (agency
 * tokens, theme variants, legacy aliases) lives in the app.
 */
import { applyTenantTheme, type Theme, type TenantThemeOverride } from './theme.js';

/** camelCase → kebab-case (background, surfaceElevated, hlAmber → background, surface-elevated, hl-amber). */
function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Sanitise a token value for CSS output (defence-in-depth against a hostile tenant override). */
function safeValue(v: string | number): string {
  const s = String(v);
  // Values are colors / numbers / font names — never contain these. Strip anything that could break out.
  return s.replace(/[;{}<>]/g, '').trim();
}

/** The default CSS custom-property prefix when an app does not supply its own brand prefix. */
export const DEFAULT_CSS_PREFIX = 'wv';

export interface CssVarsOptions {
  /** CSS custom-property prefix, without dashes (default `wv`). an app passes its own, e.g. `gw` → `--gw-*`. */
  prefix?: string;
}

/**
 * Flatten one {@link Theme} into `--<prefix>-*` custom properties: colours, spacing, radii, fonts, the
 * type scale (size/line/weight per role), and a couple of synthesised web shadows. Pure. The prefix is
 * sanitised to `[a-z0-9-]` so it can never inject CSS.
 */
export function toCssVariables(theme: Theme, opts: CssVarsOptions = {}): Record<string, string> {
  const p = (opts.prefix ?? DEFAULT_CSS_PREFIX).toLowerCase().replace(/[^a-z0-9-]/g, '') || DEFAULT_CSS_PREFIX;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.colors)) out[`--${p}-color-${kebab(k)}`] = safeValue(v);
  for (const [k, v] of Object.entries(theme.spacing)) out[`--${p}-space-${kebab(k)}`] = `${Number(v)}px`;
  for (const [k, v] of Object.entries(theme.radii)) out[`--${p}-radius-${kebab(k)}`] = `${Number(v)}px`;
  for (const [k, v] of Object.entries(theme.typography.families)) out[`--${p}-font-${kebab(k)}`] = `${safeValue(v)}, sans-serif`;
  for (const [role, t] of Object.entries(theme.typography.scale)) {
    const st = t as { fontSize: number; lineHeight: number; fontWeight: number; family: string };
    out[`--${p}-text-${kebab(role)}-size`] = `${st.fontSize}px`;
    out[`--${p}-text-${kebab(role)}-line`] = `${st.lineHeight}px`;
    out[`--${p}-text-${kebab(role)}-weight`] = `${st.fontWeight}`;
  }
  // Web shadows — the design is "almost no shadow": a hairline default and ONE soft level for floating cards.
  const e = theme.elevation.level2 ?? theme.elevation.level1;
  const sc = safeValue(e.shadowColor);
  out[`--${p}-shadow-soft`] = `0 ${e.shadowOffset.height}px ${e.shadowRadius}px ${sc}${Math.round((e.shadowOpacity ?? 0.1) * 255).toString(16).padStart(2, '0')}`;
  out[`--${p}-shadow-pop`] = `0 10px 30px rgba(20,32,27,0.18)`;
  return out;
}

function block(selector: string, vars: Record<string, string>, indent = '  '): string {
  const body = Object.entries(vars).map(([k, v]) => `${indent}${k}: ${v};`).join('\n');
  return `${selector} {\n${body}\n}`;
}

// ─── Per-tenant appearance / white-label branding ───────────────────────────────

export interface TenantThemeVars {
  /** Changed `--<prefix>-*` variables for the light theme (empty if the override changes nothing / was dropped). */
  readonly light: Record<string, string>;
  /** Changed `--<prefix>-*` variables for the dark theme. */
  readonly dark: Record<string, string>;
  /** True if the override failed WCAG-AA and was DROPPED for accessibility (branding falls back to base). */
  readonly degraded: boolean;
}

/** The light + dark base themes an app hands to the tenant white-label functions. */
export interface BaseThemes {
  light: Theme;
  dark: Theme;
}

export interface TenantThemeOptions extends CssVarsOptions {
  enforceContrast?: boolean;
}

/**
 * Resolve a tenant's brand override into ONLY the `--<prefix>-*` variables that differ from the base —
 * for both light and dark — so a client can apply them at runtime with `documentElement.style.setProperty`
 * (CSP-safe; no `<style>` injection). Accessibility is enforced: an override that would fail WCAG-AA
 * contrast is DROPPED (per {@link applyTenantTheme}) and `degraded` is set, so a tenant can never ship an
 * inaccessible re-brand. The app passes its base themes + brand prefix. Pure.
 */
export function tenantThemeVars(bases: BaseThemes, override: TenantThemeOverride, opts: TenantThemeOptions = {}): TenantThemeVars {
  const cssOpts: CssVarsOptions = opts.prefix !== undefined ? { prefix: opts.prefix } : {};
  const changedFor = (base: Theme): { changed: Record<string, string>; degraded: boolean } => {
    const { theme, degraded } = applyTenantTheme(base, override, { enforceContrast: opts.enforceContrast ?? true });
    const baseVars = toCssVariables(base, cssOpts);
    const themeVars = toCssVariables(theme, cssOpts);
    const changed: Record<string, string> = {};
    for (const [k, v] of Object.entries(themeVars)) if (v !== baseVars[k]) changed[k] = v;
    return { changed, degraded };
  };
  const l = changedFor(bases.light);
  const d = changedFor(bases.dark);
  return { light: l.changed, dark: d.changed, degraded: l.degraded || d.degraded };
}

/**
 * Server-side variant: the tenant's brand override as a CSS string (light on `:root`, dark on
 * `[data-theme="dark"]`) suitable for injecting into an SSR shell for zero-FOUC re-branding. Only the
 * changed vars are emitted. Accessibility-degraded exactly like {@link tenantThemeVars}.
 */
export function tenantThemeCss(bases: BaseThemes, override: TenantThemeOverride, opts: TenantThemeOptions & { rootSelector?: string } = {}): string {
  const root = opts.rootSelector ?? ':root';
  const v = tenantThemeVars(bases, override, {
    ...(opts.prefix !== undefined ? { prefix: opts.prefix } : {}),
    ...(opts.enforceContrast !== undefined ? { enforceContrast: opts.enforceContrast } : {}),
  });
  const parts: string[] = ['/* tenant brand override — accessibility-enforced. */'];
  if (Object.keys(v.light).length) parts.push(block(root, v.light));
  if (Object.keys(v.dark).length) parts.push(block(`${root}[data-theme="dark"], [data-theme="dark"]`, v.dark));
  return parts.join('\n\n');
}
