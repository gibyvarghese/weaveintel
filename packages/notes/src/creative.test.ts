// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  PAGE_THEMES, PAGE_THEME_TOKENS, pageThemeTokens, coercePageTheme,
  HIGHLIGHTER_SWATCHES, DEFAULT_HIGHLIGHT, CALLOUT_TONES, coerceCalloutTone,
  STICKER_PRESETS, sanitizeColor, isKnownSwatch,
} from './creative.js';

describe('creative — page themes (spec §10.6)', () => {
  it('exposes exactly the Pro + Creative themes with the spec tokens', () => {
    expect(PAGE_THEMES).toEqual(['pro', 'creative']);
    expect(PAGE_THEME_TOKENS.pro.surface).toBe('#FFFFFF');
    expect(PAGE_THEME_TOKENS.creative.surface).toBe('#FBF8F1');
    expect(PAGE_THEME_TOKENS.pro.titleSizePx).toBe(34);
    expect(PAGE_THEME_TOKENS.pro.titleWeight).toBe(800);
    expect(PAGE_THEME_TOKENS.creative.titleSizePx).toBe(46);
    expect(PAGE_THEME_TOKENS.creative.titleWeight).toBe(700);
    expect(PAGE_THEME_TOKENS.pro.titleFont).toContain('Plus Jakarta Sans');
    expect(PAGE_THEME_TOKENS.creative.titleFont).toContain('Caveat');
    expect(PAGE_THEME_TOKENS.pro.highlighterTreatment).toBe('soft-fill');
    expect(PAGE_THEME_TOKENS.creative.highlighterTreatment).toBe('underline-gradient');
    // Only Creative reveals the ✨ sticker tool.
    expect(PAGE_THEME_TOKENS.pro.stickerTool).toBe(false);
    expect(PAGE_THEME_TOKENS.creative.stickerTool).toBe(true);
  });

  it('resolves + coerces unknown/garbage themes to Pro', () => {
    expect(pageThemeTokens('creative').theme).toBe('creative');
    expect(pageThemeTokens('rainbow').theme).toBe('pro');
    expect(pageThemeTokens(null).theme).toBe('pro');
    expect(pageThemeTokens(undefined).theme).toBe('pro');
    expect(coercePageTheme('creative')).toBe('creative');
    expect(coercePageTheme('PRO')).toBe('pro'); // case-sensitive on the wire → unknown → pro
    expect(coercePageTheme(42)).toBe('pro');
  });
});

describe('creative — highlighter swatches', () => {
  it('has the four spec colours and a default', () => {
    expect(HIGHLIGHTER_SWATCHES.map((s) => s.key)).toEqual(['amber', 'pink', 'teal', 'blue']);
    expect(HIGHLIGHTER_SWATCHES.map((s) => s.color)).toEqual(['#FAC775', '#F4C0D1', '#9FE1CB', '#B5D4F4']);
    expect(DEFAULT_HIGHLIGHT).toBe('#FAC775');
  });
  it('recognises known swatches case-insensitively, rejects others', () => {
    expect(isKnownSwatch('#FAC775')).toBe(true);
    expect(isKnownSwatch('#fac775')).toBe(true);
    expect(isKnownSwatch('#123456')).toBe(false);
    expect(isKnownSwatch('red')).toBe(false);
  });
});

describe('creative — callout tones + stickers', () => {
  it('covers the five tones with icons + accents', () => {
    expect(Object.keys(CALLOUT_TONES)).toEqual(['note', 'tip', 'warning', 'success', 'danger']);
    expect(CALLOUT_TONES.warning.icon).toBe('⚠️');
    expect(coerceCalloutTone('tip')).toBe('tip');
    expect(coerceCalloutTone('explosion')).toBe('note');
    expect(coerceCalloutTone(null)).toBe('note');
  });
  it('offers a non-empty sticker preset set led by the sparkle', () => {
    expect(STICKER_PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(STICKER_PRESETS[0]).toBe('✨');
  });
});

describe('creative — sanitizeColor (security gate)', () => {
  it('accepts plain colours', () => {
    expect(sanitizeColor('#FAC775')).toBe('#FAC775');
    expect(sanitizeColor('#fff')).toBe('#fff');
    expect(sanitizeColor('#11223344')).toBe('#11223344'); // 8-digit hex (with alpha)
    expect(sanitizeColor('rgb(10, 20, 30)')).toBe('rgb(10, 20, 30)');
    expect(sanitizeColor('rgba(10,20,30,0.5)')).toBe('rgba(10,20,30,0.5)');
    expect(sanitizeColor('hsl(200, 50%, 40%)')).toBe('hsl(200, 50%, 40%)');
    expect(sanitizeColor('  coral  ')).toBe('coral'); // trimmed + lowercased
    expect(sanitizeColor('RebeccaPurple')).toBe('rebeccapurple');
  });
  it('rejects anything that could carry CSS/script', () => {
    const hostile = [
      'red;}body{display:none}',
      'url(javascript:alert(1))',
      'expression(alert(1))',
      '#fff;background:url(x)',
      'rgb(0,0,0);}',
      '</style><script>',
      'var(--x)',
      'a'.repeat(64),
      '',
      '   ',
      123,
      null,
      undefined,
      {},
    ];
    for (const h of hostile) expect(sanitizeColor(h as unknown)).toBeNull();
  });
  it('STRESS: a thousand random-ish inputs never returns a string with a brace/semicolon/paren-call', () => {
    for (let i = 0; i < 1000; i++) {
      const candidate = `${i % 2 ? '#' : ''}${(i * 2654435761 >>> 0).toString(16)}${i % 3 ? ';}' : ''}`;
      const out = sanitizeColor(candidate);
      if (out !== null) {
        expect(out).not.toMatch(/[;{}]/);
        expect(out).not.toContain('url(');
      }
    }
  });
});
