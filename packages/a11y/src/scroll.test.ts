/**
 * Tests — scroll preservation (scroll.ts). Positive / negative / stress / security(robustness).
 */
import { describe, it, expect } from 'vitest';
import { isAtBottom, captureScroll, resolveScrollTop, DEFAULT_AT_BOTTOM_THRESHOLD } from './scroll.js';

describe('isAtBottom', () => {
  it('POSITIVE — exactly at the bottom', () => {
    expect(isAtBottom(800, 1000, 200)).toBe(true); // 800 + 200 === 1000
  });
  it('within the threshold still counts as at-bottom (keeps a near-bottom reader following)', () => {
    expect(isAtBottom(780, 1000, 200, 24)).toBe(true);  // gap 20 <= 24
    expect(isAtBottom(770, 1000, 200, 24)).toBe(false); // gap 30 > 24
  });
  it('NEGATIVE — scrolled up is not at bottom', () => {
    expect(isAtBottom(0, 1000, 200)).toBe(false);
  });
  it('a container shorter than its viewport is trivially at bottom', () => {
    expect(isAtBottom(0, 150, 200)).toBe(true); // gap negative
  });
  it('ROBUSTNESS — non-finite inputs → false (never force-follow on garbage)', () => {
    expect(isAtBottom(NaN, 1000, 200)).toBe(false);
    expect(isAtBottom(800, Infinity, 200)).toBe(false);
  });
});

describe('captureScroll', () => {
  it('snapshots top + atBottom', () => {
    expect(captureScroll({ scrollTop: 300, scrollHeight: 1000, clientHeight: 200 })).toEqual({ top: 300, atBottom: false });
    expect(captureScroll({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 })).toEqual({ top: 800, atBottom: true });
  });
  it('clamps a negative/garbage scrollTop to 0', () => {
    expect(captureScroll({ scrollTop: -50, scrollHeight: 1000, clientHeight: 200 }).top).toBe(0);
    expect(captureScroll({ scrollTop: NaN, scrollHeight: 1000, clientHeight: 200 }).top).toBe(0);
  });
  it('uses the default threshold', () => {
    expect(DEFAULT_AT_BOTTOM_THRESHOLD).toBe(24);
  });
});

describe('resolveScrollTop — restore after a re-render', () => {
  it('POSITIVE — restores the exact prior offset when not at bottom', () => {
    expect(resolveScrollTop({ top: 300, atBottom: false }, 1000, 200)).toBe(300);
  });
  it('pins to the NEW bottom when the reader was at the bottom (content grew)', () => {
    expect(resolveScrollTop({ top: 800, atBottom: true }, 2000, 200)).toBe(1800); // new max = 2000-200
  });
  it('clamps a stale offset into the new (shorter) content — no blank gap', () => {
    expect(resolveScrollTop({ top: 900, atBottom: false }, 500, 200)).toBe(300); // max = 300
  });
  it('NEGATIVE — a missing snapshot → top (0)', () => {
    expect(resolveScrollTop(null, 1000, 200)).toBe(0);
    expect(resolveScrollTop(undefined, 1000, 200)).toBe(0);
  });
  it('ROBUSTNESS — non-finite content sizes never produce NaN/negative', () => {
    expect(resolveScrollTop({ top: 300, atBottom: false }, NaN, 200)).toBe(0);
    expect(resolveScrollTop({ top: NaN as unknown as number, atBottom: false }, 1000, 200)).toBe(0);
  });
  it('STRESS — huge content heights resolve instantly + correctly', () => {
    const t = Date.now();
    expect(resolveScrollTop({ top: 5_000_000, atBottom: false }, 10_000_000, 900)).toBe(5_000_000);
    expect(resolveScrollTop({ top: 0, atBottom: true }, 10_000_000, 900)).toBe(9_999_100);
    expect(Date.now() - t).toBeLessThan(50);
  });
});
