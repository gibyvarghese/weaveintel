// SPDX-License-Identifier: MIT
/**
 * Tests for the web token transform (css.ts): CSS-variable emission from the shared themes, the full
 * stylesheet (light/dark/creative + breakpoints + legacy aliases), and injection-safety of values.
 */
import { describe, it, expect } from 'vitest';
import { toCssVariables, themeCss, breakpoints, mediaUp, mediaBelow } from './index.js';
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

describe('breakpoints', () => {
  it('exposes the adaptive thresholds + media helpers', () => {
    expect(breakpoints).toEqual({ foldable: 600, tablet: 900, desktop: 1200, wide: 1600 });
    expect(mediaUp('tablet')).toBe('(min-width: 900px)');
    expect(mediaBelow('tablet')).toBe('(max-width: 899.98px)');
  });
});
