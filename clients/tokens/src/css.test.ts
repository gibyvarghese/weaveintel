// SPDX-License-Identifier: MIT
/**
 * Tests for the web token transform (css.ts): CSS-variable emission from the shared themes, the full
 * stylesheet (light/dark/creative + breakpoints + legacy aliases), and injection-safety of values.
 */
import { describe, it, expect } from 'vitest';
import { toCssVariables, themeCss, tenantThemeVars, tenantThemeCss, breakpoints, mediaUp, mediaBelow } from './index.js';
import { themes } from './theme.js';

describe('toCssVariables', () => {
  it('emits the dc.html light tokens as --gw-* custom properties', () => {
    const v = toCssVariables(themes.light);
    expect(v['--gw-color-background']).toBe('#F6F8F7'); // canvas
    expect(v['--gw-color-text']).toBe('#14201B');       // ink
    expect(v['--gw-color-accent']).toBe('#0E9A6E');     // emerald (AI + primary)
    expect(v['--gw-color-mint']).toBe('#E8F5EE');       // AI surface
    expect(v['--gw-color-paper']).toBe('#FBF8F1');      // Creative page
    expect(v['--gw-color-coral']).toBe('#D85A30');      // human ink
    expect(v['--gw-space-lg']).toBe('16px');
    expect(v['--gw-radius-md']).toBe('12px');
    expect(v['--gw-font-display']).toContain('Plus Jakarta Sans');
    expect(v['--gw-font-mono']).toContain('JetBrains Mono');
    expect(v['--gw-text-title-size']).toBe('22px');
  });
  it('emits the dark palette (different background) for the dark theme', () => {
    expect(toCssVariables(themes.dark)['--gw-color-background']).toBe('#0E1714');
  });
});

describe('themeCss', () => {
  const css = themeCss();
  it('writes light on :root, dark on [data-theme=dark], and the Creative page/title swap', () => {
    expect(css).toContain(':root {');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('[data-variant="creative"]');
    expect(css).toContain('--gw-page: var(--gw-color-paper)');   // creative → warm paper
    expect(css).toContain('--gw-font-title: var(--gw-font-hand)'); // creative → handwriting
    expect(css).toContain('--gw-ai-surface: var(--gw-color-mint)'); // agency stays mint in both modes
  });
  it('includes breakpoint tokens and legacy aliases by default', () => {
    expect(css).toContain('--gw-bp-tablet: 900px');
    expect(css).toContain('--accent: var(--gw-color-accent)'); // legacy alias → SSOT
    expect(css).toContain('--bg: var(--gw-color-background)');
  });
  it('can omit legacy aliases', () => {
    expect(themeCss({ legacy: false })).not.toContain('--bg: var(--gw-color-background)');
  });
});

describe('injection safety', () => {
  it('strips CSS-breaking characters from token values (defence-in-depth for tenant overrides)', () => {
    const hostile = { ...themes.light, colors: { ...themes.light.colors, accent: '#000; } body { display:none' } };
    const v = toCssVariables(hostile as never);
    expect(v['--gw-color-accent']).not.toContain(';');
    expect(v['--gw-color-accent']).not.toContain('{');
    expect(v['--gw-color-accent']).not.toContain('}');
  });
});

describe('tenantThemeVars (per-tenant white-label)', () => {
  it('emits only the CHANGED --gw-* vars for a valid brand override (font + corner)', () => {
    // Non-colour overrides never affect contrast, so they always apply in both light + dark.
    const v = tenantThemeVars({ typography: { families: { display: 'Georgia' } }, radii: { md: 4 } });
    expect(v.degraded).toBe(false);
    expect(v.light['--gw-font-display']).toContain('Georgia');
    expect(v.light['--gw-radius-md']).toBe('4px');
    expect(v.dark['--gw-radius-md']).toBe('4px');
    expect(v.light['--gw-color-background']).toBeUndefined(); // unchanged tokens not emitted
  });
  it('applies a brand accent PER-THEME — branded where accessible, base where not', () => {
    // A mid-tone brand blue reads fine on the light canvas but is too dark on the near-black dark
    // surface (accent-as-text fails AA there). The resolver applies the brand to LIGHT and falls the
    // DARK theme back to its accessible default, flagging `degraded` so the admin can be told.
    const v = tenantThemeVars({ colors: { accentStrong: '#1D4ED8', onAccent: '#FFFFFF' } });
    expect(v.light['--gw-color-accent-strong']).toBe('#1D4ED8'); // branded in light
    expect(v.dark['--gw-color-accent-strong']).toBeUndefined();  // fell back in dark (accessible)
    expect(v.degraded).toBe(true);                                // at least one theme fell back
  });
  it('DROPS an override that fails WCAG-AA in EITHER theme (accessibility can never be re-branded away)', () => {
    // White on near-white for the on-accent pair fails in both light and dark.
    const v = tenantThemeVars({ colors: { accentStrong: '#FEFEFE', onAccent: '#FFFFFF' } });
    expect(v.degraded).toBe(true);
    expect(Object.keys(v.light)).toHaveLength(0);
    expect(Object.keys(v.dark)).toHaveLength(0);
  });
  it('allows a failing override when contrast enforcement is off (live preview mode)', () => {
    const v = tenantThemeVars({ colors: { accentStrong: '#FEFEFE', onAccent: '#FFFFFF' } }, { enforceContrast: false });
    expect(v.light['--gw-color-accent-strong']).toBe('#FEFEFE');
  });
});

describe('tenantThemeCss (server-inject, no-FOUC)', () => {
  it('wraps the changed vars in :root for a valid override', () => {
    const css = tenantThemeCss({ colors: { accentStrong: '#1D4ED8', onAccent: '#FFFFFF' } });
    expect(css).toContain(':root {');
    expect(css).toMatch(/--gw-color-accent-strong:\s*#1D4ED8/);
  });
  it('emits nothing for a fully-degraded override', () => {
    const css = tenantThemeCss({ colors: { accentStrong: '#FEFEFE', onAccent: '#FFFFFF' } });
    expect(css).not.toContain('--gw-color-accent-strong');
  });
});

describe('breakpoints', () => {
  it('exposes the adaptive thresholds + media helpers', () => {
    expect(breakpoints).toEqual({ foldable: 600, tablet: 900, desktop: 1200, wide: 1600 });
    expect(mediaUp('tablet')).toBe('(min-width: 900px)');
    expect(mediaBelow('tablet')).toBe('(max-width: 899.98px)');
  });
});
