import { describe, it, expect } from 'vitest';
import {
  parseHex,
  relativeLuminance,
  contrastRatio,
  meetsAA,
  roundRatio,
  AA_CONTRAST_NORMAL,
  AA_CONTRAST_LARGE,
} from './color.js';

describe('color math', () => {
  it('parses 6-digit hex with and without leading #', () => {
    expect(parseHex('#FF8800')).toEqual({ r: 255, g: 136, b: 0 });
    expect(parseHex('ff8800')).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('expands 3-digit shorthand hex', () => {
    expect(parseHex('#0F0')).toEqual({ r: 0, g: 255, b: 0 });
  });

  it('throws on malformed hex', () => {
    expect(() => parseHex('#12')).toThrow(/Invalid hex/);
    expect(() => parseHex('nope')).toThrow(/Invalid hex/);
    expect(() => parseHex('#1234567')).toThrow(/Invalid hex/);
  });

  it('computes the WCAG luminance extremes', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 5);
  });

  it('computes the canonical black/white contrast as 21:1', () => {
    expect(roundRatio(contrastRatio('#000000', '#FFFFFF'))).toBe(21);
  });

  it('is symmetric in its arguments', () => {
    const a = contrastRatio('#123456', '#abcdef');
    const b = contrastRatio('#abcdef', '#123456');
    expect(a).toBe(b);
  });

  it('applies the correct AA thresholds by text size', () => {
    expect(meetsAA(AA_CONTRAST_NORMAL)).toBe(true);
    expect(meetsAA(AA_CONTRAST_NORMAL - 0.01)).toBe(false);
    expect(meetsAA(AA_CONTRAST_LARGE, true)).toBe(true);
    expect(meetsAA(AA_CONTRAST_LARGE - 0.01, true)).toBe(false);
    // A large-text-passing ratio can still fail normal-text.
    expect(meetsAA(3.5, false)).toBe(false);
    expect(meetsAA(3.5, true)).toBe(true);
  });
});
