// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { locateQuote, buildCitedAnswerPrompt, parseCitedAnswer, verifyCitations, type CitableSource } from './rag.js';

const HEART = 'The human heart has four chambers: two atria and two ventricles. It pumps blood around the body.';
const CELL = 'Mitochondria are the powerhouse of the cell, producing ATP through respiration.';
const sources: CitableSource[] = [
  { n: 1, id: 'note-heart', kind: 'note', title: 'Heart', content: HEART },
  { n: 2, id: 'note-cell', kind: 'note', title: 'Cell', content: CELL },
];

describe('locateQuote — anti-hallucination span finder', () => {
  it('finds an exact substring span', () => {
    const s = locateQuote(HEART, 'four chambers');
    expect(s).not.toBeNull();
    expect(HEART.slice(s!.start, s!.end)).toBe('four chambers');
  });
  it('finds a quote that differs only in whitespace + case', () => {
    const s = locateQuote(HEART, 'Four   Chambers'); // extra spaces + casing
    expect(s).not.toBeNull();
    expect(HEART.slice(s!.start, s!.end).toLowerCase().replace(/\s+/g, ' ')).toBe('four chambers');
  });
  it('returns null for a quote NOT in the source (hallucinated)', () => {
    expect(locateQuote(HEART, 'three chambers')).toBeNull();
    expect(locateQuote(HEART, 'the heart has a single ventricle')).toBeNull();
  });
  it('rejects too-short / empty quotes', () => {
    expect(locateQuote(HEART, 'a')).toBeNull();
    expect(locateQuote(HEART, '')).toBeNull();
    expect(locateQuote('', 'anything')).toBeNull();
  });
  it('handles ellipsis quotes (wildcards) by locating the enclosing span', () => {
    const s = locateQuote(HEART, 'four chambers … pumps blood'); // model elided the middle
    expect(s).not.toBeNull();
    const span = HEART.slice(s!.start, s!.end);
    expect(span.startsWith('four chambers')).toBe(true);
    expect(span.endsWith('pumps blood')).toBe(true);
    // a … quote whose tail is absent stays unverifiable
    expect(locateQuote(HEART, 'four chambers ... unicorns')).toBeNull();
  });
});

describe('buildCitedAnswerPrompt', () => {
  it('instructs verbatim quoting and embeds the sources + question', () => {
    const { system, user } = buildCitedAnswerPrompt('how many chambers?', sources);
    expect(system).toMatch(/verbatim|WORD-FOR-WORD/i);
    expect(system).toMatch(/do not paraphrase/i);
    expect(user).toContain('four chambers');
    expect(user).toContain('how many chambers?');
    expect(user).toContain('[1]');
  });
});

describe('parseCitedAnswer', () => {
  it('parses {answer, citations} even with surrounding prose', () => {
    const reply = 'Sure! {"answer":"It has four chambers [1].","citations":[{"source":1,"quote":"four chambers"}]} done';
    const { answer, citations } = parseCitedAnswer(reply);
    expect(answer).toContain('four chambers');
    expect(citations).toEqual([{ source: 1, quote: 'four chambers' }]);
  });
  it('falls back to the raw text + no citations on malformed output', () => {
    const { answer, citations } = parseCitedAnswer('no json here');
    expect(answer).toBe('no json here');
    expect(citations).toEqual([]);
  });
});

describe('verifyCitations — keeps verified, DROPS hallucinated', () => {
  it('keeps a real quote, drops an invented one', () => {
    const raw = [
      { source: 1, quote: 'four chambers' },     // real → kept
      { source: 1, quote: 'seven chambers' },    // invented → dropped
      { source: 2, quote: 'powerhouse of the cell' }, // real → kept
    ];
    const v = verifyCitations(raw, sources);
    expect(v.map((c) => c.quote)).toEqual(['four chambers', 'powerhouse of the cell']);
    expect(v[0]).toMatchObject({ sourceId: 'note-heart', n: 1 });
    expect(v.every((c) => HEART.includes(c.quote) || CELL.includes(c.quote))).toBe(true);
  });
  it('drops a citation that references a non-existent source number', () => {
    expect(verifyCitations([{ source: 9, quote: 'four chambers' }], sources)).toEqual([]);
  });
  it('dedupes identical spans', () => {
    const v = verifyCitations([{ source: 1, quote: 'four chambers' }, { source: 1, quote: 'four chambers' }], sources);
    expect(v.length).toBe(1);
  });
  it('SECURITY: a citation can never fabricate source text — quote is sliced from the real source', () => {
    // Even if the model returns a quote with injected text, we only keep it if it is genuinely present,
    // and the returned `quote` is taken from the SOURCE (slice), not echoed from the model.
    const v = verifyCitations([{ source: 1, quote: 'four chambers' }], sources);
    expect(v[0]!.quote).toBe(HEART.slice(v[0]!.charStart, v[0]!.charEnd));
  });
});
