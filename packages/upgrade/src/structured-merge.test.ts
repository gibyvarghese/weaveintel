// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { mergeKeyedList, parseList } from './structured-merge.js';

const s = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

describe('@weaveintel/upgrade — structured id-keyed merge', () => {
  it('parseList tolerates JSON strings, arrays, and junk; drops id-less elements', () => {
    expect(parseList(JSON.stringify([s('a')]))).toEqual([s('a')]);
    expect(parseList([s('a')])).toEqual([s('a')]);
    expect(parseList('not json')).toEqual([]);
    expect(parseList({ not: 'array' })).toEqual([]);
    expect(parseList([{ noId: true }, s('ok')])).toEqual([s('ok')]);
  });

  it('POSITIVE: adopts an untouched element the release changed; keeps a customised one', () => {
    const base = [s('a', { v: 'A' }), s('b', { v: 'B' })];
    const local = [s('a', { v: 'A' }), s('b', { v: 'B-op' })]; // operator edited b
    const remote = [s('a', { v: 'A2' }), s('b', { v: 'B' })];  // release changed a
    const { items, conflicts } = mergeKeyedList<{ id: string; v: string }>(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(items.find((x) => x.id === 'a')!.v).toBe('A2');
    expect(items.find((x) => x.id === 'b')!.v).toBe('B-op');
  });

  it('POSITIVE: a release-added and an operator-added element coexist', () => {
    const { items, conflicts } = mergeKeyedList([s('a')], [s('a'), s('op')], [s('a'), s('rel')]);
    expect(conflicts).toEqual([]);
    expect(items.map((x) => String(x['id'])).sort()).toEqual(['a', 'op', 'rel']);
  });

  it('NEGATIVE (conflict): both change the same element differently → per-element conflict, local kept', () => {
    const { items, conflicts } = mergeKeyedList([s('a', { n: 0 })], [s('a', { n: 1 })], [s('a', { n: 2 })]);
    expect(conflicts).toEqual([{ id: 'a', reason: 'both_changed' }]);
    expect(items.find((x) => x['id'] === 'a')!['n']).toBe(1);
  });

  it('removal semantics: untouched removal honoured; edit-vs-remove is a conflict (work kept)', () => {
    const base = [s('a'), s('b'), s('c', { v: 0 })];
    const local = [s('a'), s('b'), s('c', { v: 1 })]; // operator edited c
    const remote = [s('a')];                           // release removed b and c
    const { items, conflicts } = mergeKeyedList(base, local, remote);
    expect(items.map((x) => String(x['id'])).sort()).toEqual(['a', 'c']);
    expect(conflicts).toEqual([{ id: 'c', reason: 'edit_vs_remove' }]);
  });

  it('a custom id key is honoured (e.g. "stepId")', () => {
    const base = [{ stepId: 'x', w: 0 }];
    const local = [{ stepId: 'x', w: 0 }];
    const remote = [{ stepId: 'x', w: 9 }];
    const { items } = mergeKeyedList(base, local, remote, 'stepId');
    expect(items[0]!['w']).toBe(9); // untouched → adopt release
  });

  it('no-op: identical lists merge to themselves with no conflicts (edge wiring preserved)', () => {
    const g = [s('a', { next: 'b' }), s('b', { next: null })];
    const { items, conflicts } = mergeKeyedList(g, g, g);
    expect(conflicts).toEqual([]);
    expect(items).toEqual(g);
  });

  it('order is stable: base order, then local additions, then remote additions', () => {
    const { items } = mergeKeyedList([s('a'), s('b')], [s('a'), s('b'), s('l')], [s('b'), s('a'), s('r')]);
    expect(items.map((x) => String(x['id']))).toEqual(['a', 'b', 'l', 'r']);
  });

  it('STRESS: 2,000-element lists merge deterministically', () => {
    const base = Array.from({ length: 2000 }, (_, i) => s(`n${i}`, { w: 0 }));
    const local = base.map((n) => (n.id === 'n5' ? s('n5', { w: 1 }) : n));
    const remote = base.map((n) => (n.id === 'n9' ? s('n9', { w: 2 }) : n));
    const { items, conflicts } = mergeKeyedList<{ id: string; w: number }>(base, local, remote);
    expect(conflicts).toEqual([]);
    expect(items.length).toBe(2000);
    expect(items.find((x) => x.id === 'n5')!.w).toBe(1);
    expect(items.find((x) => x.id === 'n9')!.w).toBe(2);
  });
});
