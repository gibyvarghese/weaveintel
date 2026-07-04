// SPDX-License-Identifier: MIT
/**
 * Tests for the web token transform (css.ts): CSS-variable emission with a configurable prefix,
 * per-tenant white-label var diffing (accessibility-enforced), and injection-safety of values.
 * Brand-specific stylesheet assembly (the geneWeave `--gw-*` sheet) is tested in the app, not here.
 */
import { describe, it, expect } from 'vitest';
import { toCssVariables, tenantThemeVars, tenantThemeCss, neutralThemes, breakpoints, mediaUp, mediaBelow, DEFAULT_CSS_PREFIX } from './index.js';

const bases = { light: neutralThemes.light, dark: neutralThemes.dark };

describe('toCssVariables', () => {
  it('emits tokens under the DEFAULT neutral prefix (--wv-*) when none is given', () => {
    const v = toCssVariables(neutralThemes.light);
    expect(DEFAULT_CSS_PREFIX).toBe('wv');
    expect(v['--wv-color-background']).toBe('#FFFFFF');
    expect(v['--wv-color-text']).toBe('#0F172A');
    expect(v['--wv-space-lg']).toBe('16px');
    expect(v['--wv-radius-md']).toBe('12px');
    expect(v['--wv-text-title-size']).toBe('22px');
  });
  it('emits tokens under an APP-supplied prefix (the palette + names are INPUT)', () => {
    const v = toCssVariables(neutralThemes.light, { prefix: 'gw' });
    expect(v['--gw-color-background']).toBe('#FFFFFF');
    expect(v['--gw-color-accent']).toBe('#2563EB');
  });
  it('emits the dark palette (different background) for the dark theme', () => {
    expect(toCssVariables(neutralThemes.dark, { prefix: 'gw' })['--gw-color-background']).toBe('#0F172A');
  });
  it('sanitises a hostile prefix so it can never inject CSS', () => {
    const v = toCssVariables(neutralThemes.light, { prefix: 'x; } body {' });
    // The bad chars are stripped; every key stays a valid `--<safe>-*` name.
    expect(Object.keys(v).every((k) => /^--[a-z0-9-]+$/.test(k))).toBe(true);
  });
});

describe('injection safety', () => {
  it('strips CSS-breaking characters from token values (defence-in-depth for tenant overrides)', () => {
    const hostile = { ...neutralThemes.light, colors: { ...neutralThemes.light.colors, accent: '#000; } body { display:none' } };
    const v = toCssVariables(hostile as never, { prefix: 'gw' });
    expect(v['--gw-color-accent']).not.toContain(';');
    expect(v['--gw-color-accent']).not.toContain('{');
    expect(v['--gw-color-accent']).not.toContain('}');
  });
});

describe('tenantThemeVars (per-tenant white-label)', () => {
  it('emits only the CHANGED vars for a valid brand override (font + corner), under the app prefix', () => {
    const v = tenantThemeVars(bases, { typography: { families: { display: 'Georgia' } }, radii: { md: 4 } }, { prefix: 'gw' });
    expect(v.degraded).toBe(false);
    expect(v.light['--gw-font-display']).toContain('Georgia');
    expect(v.light['--gw-radius-md']).toBe('4px');
    expect(v.dark['--gw-radius-md']).toBe('4px');
    expect(v.light['--gw-color-background']).toBeUndefined(); // unchanged tokens not emitted
  });
  it('applies a brand accent PER-THEME — branded where accessible, base where not', () => {
    // A mid-tone brand blue reads fine on the light canvas but is too dark on the near-black dark
    // surface (accent-as-text fails AA there): applied to LIGHT, fell back in DARK, `degraded` flagged.
    const v = tenantThemeVars(bases, { colors: { accentStrong: '#6D28D9', onAccent: '#FFFFFF' } }, { prefix: 'gw' });
    expect(v.light['--gw-color-accent-strong']).toBe('#6D28D9');
    expect(v.dark['--gw-color-accent-strong']).toBeUndefined();
    expect(v.degraded).toBe(true);
  });
  it('DROPS an override that fails WCAG-AA in EITHER theme (accessibility can never be re-branded away)', () => {
    const v = tenantThemeVars(bases, { colors: { accentStrong: '#FEFEFE', onAccent: '#FFFFFF' } }, { prefix: 'gw' });
    expect(v.degraded).toBe(true);
    expect(Object.keys(v.light)).toHaveLength(0);
    expect(Object.keys(v.dark)).toHaveLength(0);
  });
  it('allows a failing override when contrast enforcement is off (live preview mode)', () => {
    const v = tenantThemeVars(bases, { colors: { accentStrong: '#FEFEFE', onAccent: '#FFFFFF' } }, { prefix: 'gw', enforceContrast: false });
    expect(v.light['--gw-color-accent-strong']).toBe('#FEFEFE');
  });
});

describe('tenantThemeCss (server-inject, no-FOUC)', () => {
  it('wraps the changed vars in :root for a valid override', () => {
    const css = tenantThemeCss(bases, { colors: { accentStrong: '#6D28D9', onAccent: '#FFFFFF' } }, { prefix: 'gw' });
    expect(css).toContain(':root {');
    expect(css).toMatch(/--gw-color-accent-strong:\s*#6D28D9/);
  });
  it('emits nothing for a fully-degraded override', () => {
    const css = tenantThemeCss(bases, { colors: { accentStrong: '#FEFEFE', onAccent: '#FFFFFF' } }, { prefix: 'gw' });
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
