/**
 * Tests — focus-trap math (focus-trap.ts). Positive / negative / stress / security(robustness).
 */
import { describe, it, expect } from 'vitest';
import { nextTrapIndex, FOCUSABLE_SELECTOR } from './focus-trap.js';

describe('nextTrapIndex — Tab (forward)', () => {
  it('POSITIVE — advances by one', () => {
    expect(nextTrapIndex(3, 0, false)).toBe(1);
    expect(nextTrapIndex(3, 1, false)).toBe(2);
  });
  it('wraps from the last element back to the first', () => {
    expect(nextTrapIndex(3, 2, false)).toBe(0);
  });
  it('off-trap focus (current -1) Tabs to the first', () => {
    expect(nextTrapIndex(3, -1, false)).toBe(0);
  });
});

describe('nextTrapIndex — Shift+Tab (backward)', () => {
  it('POSITIVE — moves back by one', () => {
    expect(nextTrapIndex(3, 2, true)).toBe(1);
    expect(nextTrapIndex(3, 1, true)).toBe(0);
  });
  it('wraps from the first element to the last', () => {
    expect(nextTrapIndex(3, 0, true)).toBe(2);
  });
  it('off-trap focus (current -1) Shift+Tabs to the last', () => {
    expect(nextTrapIndex(3, -1, true)).toBe(2);
  });
});

describe('nextTrapIndex — edges', () => {
  it('a single focusable element always stays on itself', () => {
    expect(nextTrapIndex(1, 0, false)).toBe(0);
    expect(nextTrapIndex(1, 0, true)).toBe(0);
    expect(nextTrapIndex(1, -1, false)).toBe(0);
  });
  it('NEGATIVE — an empty trap returns -1 (nothing to focus)', () => {
    expect(nextTrapIndex(0, 0, false)).toBe(-1);
    expect(nextTrapIndex(0, -1, true)).toBe(-1);
  });
  it('ROBUSTNESS — non-finite / negative / fractional inputs never throw or return junk', () => {
    expect(nextTrapIndex(NaN, 0, false)).toBe(-1);
    expect(nextTrapIndex(-5, 0, false)).toBe(-1);
    expect(nextTrapIndex(3, NaN, false)).toBe(0);          // NaN current → treated as off-trap → first
    expect(nextTrapIndex(3, Infinity, false)).toBe(0);     // past the end → wrap to first
    expect(nextTrapIndex(3.9, 1.9, false)).toBe(2);        // floored: count 3, current 1 → 2
  });
  it('a current index past the end is clamped into range (no out-of-range result)', () => {
    expect(nextTrapIndex(3, 9, false)).toBe(0);            // clamped to last(2) → Tab wraps to 0
    expect(nextTrapIndex(3, 9, true)).toBe(1);             // clamped to last(2) → Shift+Tab → 1
  });
});

describe('STRESS', () => {
  it('a 100k-element trap resolves instantly', () => {
    const t = Date.now();
    expect(nextTrapIndex(100_000, 99_999, false)).toBe(0);
    expect(nextTrapIndex(100_000, 0, true)).toBe(99_999);
    expect(Date.now() - t).toBeLessThan(50);
  });
});

describe('FOCUSABLE_SELECTOR', () => {
  it('targets enabled controls + tabbable elements and excludes disabled / tabindex=-1', () => {
    expect(FOCUSABLE_SELECTOR).toContain('button:not([disabled])');
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
    expect(FOCUSABLE_SELECTOR).toContain('a[href]');
  });
});
