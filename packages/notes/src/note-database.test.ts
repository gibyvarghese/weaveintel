// SPDX-License-Identifier: MIT
/**
 * Tests for the weaveNotes Phase 6 typed-property model: schema parsing, value
 * coercion per type, row validation, and rollup aggregation. Positive + negative
 * (bad values coerced/rejected; malformed schema dropped) + every rollup function.
 */
import { describe, it, expect } from 'vitest';
import { parseSchema, coerceValue, validateRow, computeRollup, isViewType, type PropertyDef } from './note-database.js';

describe('parseSchema', () => {
  it('parses valid properties and drops malformed ones', () => {
    const schema = parseSchema(JSON.stringify([
      { key: 'title', name: 'Title', type: 'text' },
      { key: 'status', name: 'Status', type: 'select', options: ['todo', 'done'] },
      { key: 'cost', type: 'number' },              // name defaults to key
      { key: 'bad', type: 'frobnicate' },           // unknown type → dropped
      { type: 'text' },                              // no key → dropped
      { key: 'tasks', name: 'Tasks', type: 'relation', relationDatabaseId: 'db2' },
      { key: 'done', name: 'Done %', type: 'rollup', rollup: { relationKey: 'tasks', targetKey: 'complete', fn: 'percent_checked' } },
    ]));
    expect(schema.map((p) => p.key)).toEqual(['title', 'status', 'cost', 'tasks', 'done']);
    expect(schema.find((p) => p.key === 'cost')!.name).toBe('cost');
    expect(schema.find((p) => p.key === 'status')!.options).toEqual(['todo', 'done']);
    expect(schema.find((p) => p.key === 'done')!.rollup!.fn).toBe('percent_checked');
  });
  it('returns [] for malformed JSON', () => { expect(parseSchema('not json')).toEqual([]); });
});

describe('coerceValue', () => {
  it('coerces by type', () => {
    expect(coerceValue('42', { type: 'number' })).toBe(42);
    expect(coerceValue('nan', { type: 'number' })).toBeNull();
    expect(coerceValue('true', { type: 'checkbox' })).toBe(true);
    expect(coerceValue('2026-06-26T10:00:00Z', { type: 'date' })).toBe('2026-06-26');
    expect(coerceValue('not a date', { type: 'date' })).toBeNull();
    expect(coerceValue('https://x.com', { type: 'url' })).toBe('https://x.com');
    expect(coerceValue('javascript:alert(1)', { type: 'url' })).toBeNull(); // only http(s)
    expect(coerceValue('a@b.com', { type: 'email' })).toBe('a@b.com');
    expect(coerceValue('nope', { type: 'email' })).toBeNull();
  });
  it('enforces select options + parses multi_select', () => {
    expect(coerceValue('done', { type: 'select', options: ['todo', 'done'] })).toBe('done');
    expect(coerceValue('other', { type: 'select', options: ['todo', 'done'] })).toBeNull();
    expect(coerceValue('a, b, x', { type: 'multi_select', options: ['a', 'b'] })).toEqual(['a', 'b']);
  });
  it('coerces relation to an id array', () => {
    expect(coerceValue('r1', { type: 'relation' })).toEqual(['r1']);
    expect(coerceValue(['r1', 'r2', 3], { type: 'relation' })).toEqual(['r1', 'r2']);
  });
});

describe('validateRow', () => {
  const schema: PropertyDef[] = [
    { key: 'name', name: 'Name', type: 'text' },
    { key: 'cost', name: 'Cost', type: 'number' },
    { key: 'roll', name: 'Roll', type: 'rollup', rollup: { relationKey: 'x', targetKey: 'y', fn: 'count' } },
  ];
  it('coerces present fields, skips rollups, reports type errors', () => {
    const { values, errors } = validateRow({ name: 'Widget', cost: 'abc', roll: 99 }, schema);
    expect(values).toEqual({ name: 'Widget', cost: null }); // rollup excluded
    expect(errors.some((e) => /Cost/.test(e))).toBe(true);
  });
});

describe('computeRollup', () => {
  const related = [{ complete: true, cost: 10 }, { complete: false, cost: 20 }, { complete: true, cost: 30 }];
  it('aggregates every function', () => {
    expect(computeRollup({ relationKey: 'r', targetKey: 'cost', fn: 'count' }, related)).toBe(3);
    expect(computeRollup({ relationKey: 'r', targetKey: 'cost', fn: 'sum' }, related)).toBe(60);
    expect(computeRollup({ relationKey: 'r', targetKey: 'cost', fn: 'average' }, related)).toBe(20);
    expect(computeRollup({ relationKey: 'r', targetKey: 'cost', fn: 'min' }, related)).toBe(10);
    expect(computeRollup({ relationKey: 'r', targetKey: 'cost', fn: 'max' }, related)).toBe(30);
    expect(computeRollup({ relationKey: 'r', targetKey: 'complete', fn: 'percent_checked' }, related)).toBe(67);
    expect(computeRollup({ relationKey: 'r', targetKey: 'complete', fn: 'count_unique' }, related)).toBe(2);
    expect(computeRollup({ relationKey: 'r', targetKey: 'cost', fn: 'show_original' }, related)).toEqual([10, 20, 30]);
  });
});

describe('isViewType', () => {
  it('accepts the five view types', () => {
    for (const v of ['table', 'board', 'calendar', 'timeline', 'gallery']) expect(isViewType(v)).toBe(true);
    expect(isViewType('kanban')).toBe(false);
  });
});
