// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { applyJsonPatch, diffJsonPatch, parsePointer, toPointer } from './json-patch.js';

describe('JSON Pointer (RFC 6901)', () => {
  it('parses + builds pointers, escaping ~ and /', () => {
    expect(parsePointer('')).toEqual([]);
    expect(parsePointer('/a/b/0')).toEqual(['a', 'b', '0']);
    expect(parsePointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(toPointer(['a', 0, 'b'])).toBe('/a/0/b');
    expect(toPointer(['a/b', 'c~d'])).toBe('/a~1b/c~0d');
  });
});

describe('applyJsonPatch (RFC 6902)', () => {
  it('add / replace / remove on objects + arrays', () => {
    const doc = { a: 1, list: [1, 2, 3], nested: { x: 1 } };
    expect(applyJsonPatch(doc, [{ op: 'replace', path: '/a', value: 2 }]).doc).toMatchObject({ a: 2 });
    expect(applyJsonPatch(doc, [{ op: 'add', path: '/b', value: 9 }]).doc).toMatchObject({ b: 9 });
    expect(applyJsonPatch(doc, [{ op: 'remove', path: '/a' }]).doc).not.toHaveProperty('a');
    expect((applyJsonPatch(doc, [{ op: 'add', path: '/list/-', value: 4 }]).doc as typeof doc).list).toEqual([1, 2, 3, 4]);
    expect((applyJsonPatch(doc, [{ op: 'remove', path: '/list/1' }]).doc as typeof doc).list).toEqual([1, 3]);
    expect(applyJsonPatch(doc, [{ op: 'replace', path: '/nested/x', value: 5 }]).doc).toMatchObject({ nested: { x: 5 } });
  });

  it('move / copy / test', () => {
    const doc = { a: 1, b: { c: 2 } };
    expect(applyJsonPatch(doc, [{ op: 'move', from: '/a', path: '/b/d' }]).doc).toEqual({ b: { c: 2, d: 1 } });
    expect(applyJsonPatch(doc, [{ op: 'copy', from: '/a', path: '/b/d' }]).doc).toEqual({ a: 1, b: { c: 2, d: 1 } });
    expect(applyJsonPatch(doc, [{ op: 'test', path: '/a', value: 1 }]).ok).toBe(true);
  });

  it('is ATOMIC: a failed op rejects the whole patch (original unchanged)', () => {
    const doc = { a: 1 };
    const res = applyJsonPatch(doc, [{ op: 'replace', path: '/a', value: 2 }, { op: 'test', path: '/a', value: 999 }]);
    expect(res.ok).toBe(false);
    expect(res.doc).toEqual({ a: 1 });           // not half-applied
    expect(res.error).toContain('test failed');
  });

  it('does not mutate the input document', () => {
    const doc = { a: 1, list: [1] };
    const out = applyJsonPatch(doc, [{ op: 'add', path: '/list/-', value: 2 }]);
    expect(doc.list).toEqual([1]);               // input untouched
    expect((out.doc as typeof doc).list).toEqual([1, 2]);
  });

  it('rejects a bad path without throwing', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/missing', value: 1 }]).ok).toBe(false);
  });
});

describe('diffJsonPatch — round-trips through applyJsonPatch', () => {
  const cases: Array<[unknown, unknown]> = [
    [{ a: 1 }, { a: 2 }],
    [{ a: 1, b: 2 }, { a: 1 }],
    [{ a: 1 }, { a: 1, c: 3 }],
    [{ status: 'running', presence: [{ id: 'a' }] }, { status: 'completed', presence: [{ id: 'a' }, { id: 'b' }] }],
    [{ nested: { x: 1, y: 2 } }, { nested: { x: 1, y: 9 } }],
  ];
  for (const [prev, next] of cases) {
    it(`${JSON.stringify(prev)} → ${JSON.stringify(next)}`, () => {
      const patch = diffJsonPatch(prev, next);
      const applied = applyJsonPatch(prev, patch);
      expect(applied.ok).toBe(true);
      expect(applied.doc).toEqual(next);
    });
  }

  it('emits an empty patch when nothing changed', () => {
    expect(diffJsonPatch({ a: 1 }, { a: 1 })).toEqual([]);
  });
});
