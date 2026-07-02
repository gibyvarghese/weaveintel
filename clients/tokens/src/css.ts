/**
 * css.ts — the WEB transform for the geneWeave token system.
 *
 * Turns the framework-agnostic {@link Theme} objects into CSS custom properties (`--gw-*`) so the web app
 * consumes the SAME single source of truth the native app does. This is the in-house, zero-dependency
 * equivalent of a Style-Dictionary "css/variables" transform: DTCG-shaped tokens in, platform CSS out.
 *
 *   toCssVariables(theme)  → a flat { '--gw-color-accent': '#0E9A6E', … } map (one theme).
 *   themeCss(opts)         → a full stylesheet string: :root (light) + [data-theme=dark] +
 *                            [data-variant=creative] + breakpoint vars, optionally with legacy `--bg`/…
 *                            aliases so an existing stylesheet migrates without a rewrite.
 *
 * "Colour encodes agency" is preserved as tokens: `--gw-color-mint` / `--gw-color-emerald` are AI-only,
 * neutrals are user content. Creative mode only swaps the *page* surface to warm paper + the *title* font
 * to handwriting; it never recolours across the agency line.
 */
import { themes, applyTenantTheme, type Theme, type TenantThemeOverride } from './theme.js';
import { breakpoints } from './breakpoints.js';

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

/**
 * Flatten one {@link Theme} into `--gw-*` custom properties: colours, spacing, radii, fonts, the type
 * scale (size/line/weight per role), and a couple of synthesised web shadows. Pure.
 */
export function toCssVariables(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.colors)) out[`--gw-color-${kebab(k)}`] = safeValue(v);
  for (const [k, v] of Object.entries(theme.spacing)) out[`--gw-space-${kebab(k)}`] = `${Number(v)}px`;
  for (const [k, v] of Object.entries(theme.radii)) out[`--gw-radius-${kebab(k)}`] = `${Number(v)}px`;
  for (const [k, v] of Object.entries(theme.typography.families)) out[`--gw-font-${kebab(k)}`] = `${safeValue(v)}, sans-serif`;
  for (const [role, t] of Object.entries(theme.typography.scale)) {
    const st = t as { fontSize: number; lineHeight: number; fontWeight: number; family: string };
    out[`--gw-text-${kebab(role)}-size`] = `${st.fontSize}px`;
    out[`--gw-text-${kebab(role)}-line`] = `${st.lineHeight}px`;
    out[`--gw-text-${kebab(role)}-weight`] = `${st.fontWeight}`;
  }
  // Web shadows — the design is "almost no shadow": a hairline default and ONE soft level for floating cards.
  const e = theme.elevation.level2 ?? theme.elevation.level1;
  const sc = safeValue(e.shadowColor);
  out['--gw-shadow-soft'] = `0 ${e.shadowOffset.height}px ${e.shadowRadius}px ${sc}${Math.round((e.shadowOpacity ?? 0.1) * 255).toString(16).padStart(2, '0')}`;
  out['--gw-shadow-pop'] = `0 10px 30px rgba(20,32,27,0.18)`;
  return out;
}

function block(selector: string, vars: Record<string, string>, indent = '  '): string {
  const body = Object.entries(vars).map(([k, v]) => `${indent}${k}: ${v};`).join('\n');
  return `${selector} {\n${body}\n}`;
}

/** Legacy `--bg`/`--accent`/… aliases so the existing web stylesheet keeps working while it migrates. */
function legacyAliases(): Record<string, string> {
  return {
    '--canvas': 'var(--gw-color-background)',
    '--surface': 'var(--gw-color-surface)',
    '--paper': 'var(--gw-color-paper)',
    '--ink': 'var(--gw-color-text)',
    '--muted': 'var(--gw-color-text-secondary)',
    '--hairline': 'var(--gw-color-border)',
    '--bg': 'var(--gw-color-background)',
    '--bg2': 'var(--gw-color-surface)',
    '--bg3': 'var(--gw-color-mint)',
    '--bg4': 'var(--gw-color-border)',
    '--fg': 'var(--gw-color-text)',
    '--fg2': 'var(--gw-color-text-secondary)',
    '--fg3': 'var(--gw-color-text-muted)',
    '--accent': 'var(--gw-color-accent)',
    '--accent2': 'var(--gw-color-accent-strong)',
    '--accent-dim': 'var(--gw-color-mint)',
    '--mint': 'var(--gw-color-mint)',
    '--mint-deep': 'var(--gw-color-mint-deep)',
    '--amber': 'var(--gw-color-amber)',
    '--coral': 'var(--gw-color-coral)',
    '--hl-amber': 'var(--gw-color-hl-amber)',
    '--hl-pink': 'var(--gw-color-hl-pink)',
    '--hl-teal': 'var(--gw-color-hl-teal)',
    '--hl-blue': 'var(--gw-color-hl-blue)',
    '--font': 'var(--gw-font-body)',
    '--font-display': 'var(--gw-font-display)',
    '--mono': 'var(--gw-font-mono)',
    '--radius': 'var(--gw-radius-md)',
    '--radius-lg': 'var(--gw-radius-lg)',
  };
}

export interface ThemeCssOptions {
  /** Emit legacy `--bg`/`--accent`/… aliases (default true) so an existing stylesheet migrates gradually. */
  legacy?: boolean;
  /** Selector the light theme is written to (default ':root'). */
  rootSelector?: string;
}

/**
 * The full geneWeave web token stylesheet: light on :root, dark on `[data-theme="dark"]`, the Creative
 * page/title swap on `[data-variant="creative"]`, plus breakpoint + agency component tokens. Drop this at
 * the top of the app stylesheet; every component then reads `var(--gw-*)`.
 */
export function themeCss(opts: ThemeCssOptions = {}): string {
  const root = opts.rootSelector ?? ':root';
  const legacy = opts.legacy !== false;

  // Page + title tokens make Pro/Creative a token flip, not a fork: page = surface (pro) / paper (creative),
  // title font = display (pro) / handwriting (creative). AI surfaces stay mint in BOTH.
  const proExtras: Record<string, string> = {
    '--gw-page': 'var(--gw-color-surface)',
    '--gw-font-title': 'var(--gw-font-display)',
    '--gw-ai-surface': 'var(--gw-color-mint)',
    '--gw-ai-border': 'var(--gw-color-mint-deep)',
    '--gw-ai-signal': 'var(--gw-color-accent)',
    '--gw-bp-foldable': `${breakpoints.foldable}px`,
    '--gw-bp-tablet': `${breakpoints.tablet}px`,
    '--gw-bp-desktop': `${breakpoints.desktop}px`,
    '--gw-bp-wide': `${breakpoints.wide}px`,
  };

  const lightVars = { ...toCssVariables(themes.light), ...proExtras, ...(legacy ? legacyAliases() : {}) };
  const darkVars = toCssVariables(themes.dark);

  const parts = [
    '/* geneWeave design tokens — generated from @geneweave/tokens (single source of truth). Do not edit by hand. */',
    block(root, lightVars),
    block(`${root}[data-theme="dark"], [data-theme="dark"]`, darkVars),
    block('[data-variant="creative"]', {
      '--gw-page': 'var(--gw-color-paper)',
      '--gw-font-title': 'var(--gw-font-hand)',
    }),
    block('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])', darkVars, '    ') + '\n}',
  ];
  return parts.join('\n\n');
}

// ─── Per-tenant appearance / white-label branding ───────────────────────────────

export interface TenantThemeVars {
  /** Changed `--gw-*` variables for the light theme (empty if the override changes nothing / was dropped). */
  readonly light: Record<string, string>;
  /** Changed `--gw-*` variables for the dark theme. */
  readonly dark: Record<string, string>;
  /** True if the override failed WCAG-AA and was DROPPED for accessibility (branding falls back to base). */
  readonly degraded: boolean;
}

/**
 * Resolve a tenant's brand override into ONLY the `--gw-*` variables that differ from the base — for both
 * light and dark themes — so a client can apply them at runtime with `documentElement.style.setProperty`
 * (CSP-safe; no `<style>` injection needed). Accessibility is enforced: an override that would fail
 * WCAG-AA contrast is DROPPED (per {@link applyTenantTheme}) and `degraded` is set, so a tenant can never
 * ship an inaccessible re-brand. Pure.
 */
export function tenantThemeVars(override: TenantThemeOverride, opts: { enforceContrast?: boolean } = {}): TenantThemeVars {
  const changedFor = (base: Theme): { changed: Record<string, string>; degraded: boolean } => {
    const { theme, degraded } = applyTenantTheme(base, override, { enforceContrast: opts.enforceContrast ?? true });
    const baseVars = toCssVariables(base);
    const themeVars = toCssVariables(theme);
    const changed: Record<string, string> = {};
    for (const [k, v] of Object.entries(themeVars)) if (v !== baseVars[k]) changed[k] = v;
    return { changed, degraded };
  };
  const l = changedFor(themes.light);
  const d = changedFor(themes.dark);
  return { light: l.changed, dark: d.changed, degraded: l.degraded || d.degraded };
}

/**
 * Server-side variant: the tenant's brand override as a CSS string (light on `:root`, dark on
 * `[data-theme="dark"]`) suitable for injecting into an SSR shell for zero-FOUC re-branding. Only the
 * changed vars are emitted. Accessibility-degraded exactly like {@link tenantThemeVars}.
 */
export function tenantThemeCss(override: TenantThemeOverride, opts: { rootSelector?: string; enforceContrast?: boolean } = {}): string {
  const root = opts.rootSelector ?? ':root';
  const v = tenantThemeVars(override, { ...(opts.enforceContrast !== undefined ? { enforceContrast: opts.enforceContrast } : {}) });
  const parts: string[] = ['/* geneWeave tenant brand override — accessibility-enforced. */'];
  if (Object.keys(v.light).length) parts.push(block(root, v.light));
  if (Object.keys(v.dark).length) parts.push(block(`${root}[data-theme="dark"], [data-theme="dark"]`, v.dark));
  return parts.join('\n\n');
}
