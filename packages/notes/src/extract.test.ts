// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { extractTaskItems, extractPlainText } from './extract.js';

const doc = (content: unknown[]) => ({ type: 'doc', content });
const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const todo = (checked: boolean, text: string) => ({ type: 'taskItem', attrs: { checked }, content: [para(text)] });

describe('extractTaskItems', () => {
  it('returns the text of UNCHECKED to-dos only', () => {
    const d = doc([
      { type: 'taskList', content: [todo(false, 'Email the client'), todo(true, 'Already done'), todo(false, 'Book the room')] },
    ]);
    expect(extractTaskItems(d)).toEqual(['Email the client', 'Book the room']);
  });

  it('skips empty / whitespace-only to-dos and trims', () => {
    const d = doc([{ type: 'taskList', content: [todo(false, '   '), todo(false, '  Trim me  ')] }]);
    expect(extractTaskItems(d)).toEqual(['Trim me']);
  });

  it('recurses into nested structures', () => {
    const d = doc([
      { type: 'bulletList', content: [{ type: 'listItem', content: [
        { type: 'taskList', content: [todo(false, 'Nested todo')] },
      ] }] },
    ]);
    expect(extractTaskItems(d)).toEqual(['Nested todo']);
  });

  it('is null-safe / malformed-safe (negative)', () => {
    expect(extractTaskItems(null)).toEqual([]);
    expect(extractTaskItems(undefined)).toEqual([]);
    expect(extractTaskItems('not a doc')).toEqual([]);
    expect(extractTaskItems({ type: 'taskItem' })).toEqual([]); // no attrs/content
    expect(extractTaskItems(doc([{ type: 'taskItem', attrs: { checked: false } }]))).toEqual([]); // no text content
  });

  it('handles a large doc without blowing up (stress)', () => {
    const items = Array.from({ length: 1000 }, (_, i) => todo(i % 2 === 0, `Task ${i}`));
    const got = extractTaskItems(doc([{ type: 'taskList', content: items }]));
    expect(got.length).toBe(500); // half are unchecked
  });
});

describe('extractPlainText', () => {
  it('joins all text nodes across the tree', () => {
    const d = doc([{ type: 'heading', content: [{ type: 'text', text: 'Title' }] }, para(' body')]);
    expect(extractPlainText(d)).toBe('Title body');
    expect(extractPlainText(null)).toBe('');
  });
});
