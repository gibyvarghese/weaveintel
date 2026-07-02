/**
 * Tests — answer variants (answer-variants.ts). Positive / negative / stress / security.
 */
import { describe, it, expect } from 'vitest';
import {
  makeVariantStack, addVariant, selectVariant, activeVariant, variantLabel,
  DEFAULT_MAX_VARIANTS, type AnswerVariant,
} from './answer-variants.js';

const v = (id: string, content = id): AnswerVariant => ({ id, content });

describe('makeVariantStack', () => {
  it('POSITIVE — newest is active by default', () => {
    const s = makeVariantStack([v('a'), v('b'), v('c')]);
    expect(s.activeIndex).toBe(2);
    expect(activeVariant(s)?.id).toBe('c');
  });
  it('respects an explicit activeIndex, clamped to range', () => {
    expect(makeVariantStack([v('a'), v('b')], 0).activeIndex).toBe(0);
    expect(makeVariantStack([v('a'), v('b')], 9).activeIndex).toBe(1); // clamped
    expect(makeVariantStack([v('a'), v('b')], -3).activeIndex).toBe(0); // clamped
  });
  it('empty stack → activeIndex 0, activeVariant null', () => {
    const s = makeVariantStack([]);
    expect(s.activeIndex).toBe(0);
    expect(activeVariant(s)).toBeNull();
  });
});

describe('addVariant — append-only, new one active, never loses history under the cap', () => {
  it('POSITIVE — appends + activates the new variant', () => {
    let s = makeVariantStack([v('a')]);
    s = addVariant(s, v('b'));
    expect(s.variants.map((x) => x.id)).toEqual(['a', 'b']);
    expect(activeVariant(s)?.id).toBe('b');
  });
  it('does NOT mutate the input stack (immutability)', () => {
    const s0 = makeVariantStack([v('a')]);
    const s1 = addVariant(s0, v('b'));
    expect(s0.variants.length).toBe(1); // original untouched
    expect(s1.variants.length).toBe(2);
  });
  it('prunes the OLDEST when exceeding maxKept, keeping the active (newest)', () => {
    let s = makeVariantStack([v('a')]);
    for (const id of ['b', 'c', 'd', 'e', 'f']) s = addVariant(s, v(id), 3);
    expect(s.variants.map((x) => x.id)).toEqual(['d', 'e', 'f']); // oldest a,b,c pruned
    expect(activeVariant(s)?.id).toBe('f');
  });
  it('maxKept of 1 keeps only the latest', () => {
    let s = makeVariantStack([v('a')]);
    s = addVariant(s, v('b'), 1);
    expect(s.variants.map((x) => x.id)).toEqual(['b']);
  });
  it('DEFAULT_MAX_VARIANTS caps at 5', () => {
    let s = makeVariantStack([v('v0')]);
    for (let i = 1; i < 20; i++) s = addVariant(s, v(`v${i}`));
    expect(s.variants.length).toBe(DEFAULT_MAX_VARIANTS);
    expect(activeVariant(s)?.id).toBe('v19');
  });
});

describe('selectVariant — lossless switching', () => {
  it('switches the active pointer', () => {
    let s = makeVariantStack([v('a'), v('b'), v('c')]);
    s = selectVariant(s, 0);
    expect(activeVariant(s)?.id).toBe('a');
    expect(s.variants.length).toBe(3); // nothing lost
  });
  it('NEGATIVE/SECURITY — an out-of-range or non-finite index is clamped, never throws', () => {
    const s = makeVariantStack([v('a'), v('b')]);
    expect(selectVariant(s, 99).activeIndex).toBe(1);
    expect(selectVariant(s, -5).activeIndex).toBe(0);
    expect(selectVariant(s, NaN).activeIndex).toBe(0);
    expect(selectVariant(s, Infinity).activeIndex).toBe(0);
  });
});

describe('variantLabel — the "2/3" pager', () => {
  it('hidden when there is only one variant', () => {
    expect(variantLabel(makeVariantStack([v('a')])).show).toBe(false);
  });
  it('shows position/total + prev/next affordances', () => {
    let s = makeVariantStack([v('a'), v('b'), v('c')]); // active = 2 (index)
    let l = variantLabel(s);
    expect(l).toMatchObject({ index: 3, total: 3, text: '3/3', show: true, canPrev: true, canNext: false });
    s = selectVariant(s, 1);
    l = variantLabel(s);
    expect(l).toMatchObject({ index: 2, total: 3, text: '2/3', canPrev: true, canNext: true });
    s = selectVariant(s, 0);
    expect(variantLabel(s)).toMatchObject({ index: 1, text: '1/3', canPrev: false, canNext: true });
  });
});

describe('STRESS — a large regenerate history stays bounded + correct', () => {
  it('1000 regenerations keep exactly maxKept, newest active', () => {
    let s = makeVariantStack([v('start')]);
    for (let i = 0; i < 1000; i++) s = addVariant(s, v(`r${i}`), 5);
    expect(s.variants.length).toBe(5);
    expect(activeVariant(s)?.id).toBe('r999');
    expect(variantLabel(s).text).toBe('5/5');
  });
});
