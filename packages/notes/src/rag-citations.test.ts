// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { locateQuote, buildCitedAnswerPrompt, parseCitedAnswer, verifyCitations, answerCitationCoverage, enforceCitationStrictness, type CitableSource, type Citation } from './rag.js';

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

const cite = (n: number, id: string): Citation => ({ n, sourceId: id, sourceKind: 'note', sourceTitle: id, quote: 'q', charStart: 0, charEnd: 1 });

describe('citationCoverage — grounding quality of an answer', () => {
  it('POSITIVE — every marker resolves to a verified source', () => {
    const c = answerCitationCoverage('The heart has four chambers [1] and pumps blood [2].', [cite(1, 'a'), cite(2, 'b')]);
    expect(c).toMatchObject({ markers: 2, groundedMarkers: 2, distinctSources: 2, grounded: true, ratio: 1 });
  });
  it('NEGATIVE — a marker with no verified citation lowers the ratio (hallucinated quote was dropped)', () => {
    // Answer claims [1] and [2] but only [1] survived verification.
    const c = answerCitationCoverage('Claim one [1]. Claim two [2].', [cite(1, 'a')]);
    expect(c.markers).toBe(2);
    expect(c.groundedMarkers).toBe(1);
    expect(c.ratio).toBe(0.5);
  });
  it('counts a repeated marker once + de-dupes distinct sources', () => {
    const c = answerCitationCoverage('A [1]. B [1]. C [2].', [cite(1, 'a'), cite(2, 'a')]); // both cites → same source id
    expect(c.markers).toBe(2);          // [1] and [2]
    expect(c.distinctSources).toBe(1);  // both point at source id 'a'
  });
  it('an answer with NO markers is trivially "grounded ratio 1" but not grounded when there are no citations', () => {
    expect(answerCitationCoverage('Just prose, no refs.', []).ratio).toBe(1);
    expect(answerCitationCoverage('Just prose, no refs.', []).grounded).toBe(false);
  });
  it('SECURITY/robustness — malformed marker-like text does not throw or over-count', () => {
    const c = answerCitationCoverage('Weird [x] [ 1 ] [12abc] [3].', [cite(3, 'a')]);
    expect(c.markers).toBe(1);          // only the well-formed [3]
    expect(c.groundedMarkers).toBe(1);
  });
  it('STRESS — a 20k-marker answer aggregates fast', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `claim [${(i % 5) + 1}]`).join(' ');
    const t = Date.now();
    const c = answerCitationCoverage(big, [cite(1, 'a'), cite(2, 'b')]);
    expect(Date.now() - t).toBeLessThan(300);
    expect(c.markers).toBe(5); // [1..5]
    expect(c.groundedMarkers).toBe(2);
  });
});

describe('enforceCitationStrictness — the grounding gate behind the admin dial', () => {
  it('passes when distinct sources meet the minimum', () => {
    expect(enforceCitationStrictness([cite(1, 'a'), cite(2, 'b')], 2)).toMatchObject({ ok: true, distinctSources: 2 });
  });
  it('fails with a plain reason when under the minimum', () => {
    const r = enforceCitationStrictness([], 1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not backed by anything/i);
  });
  it('min 0 means citations are optional — always ok', () => {
    expect(enforceCitationStrictness([], 0).ok).toBe(true);
  });
  it('a negative / fractional minimum is floored to a sane bar (no crash)', () => {
    expect(enforceCitationStrictness([cite(1, 'a')], -3).ok).toBe(true);
    expect(enforceCitationStrictness([cite(1, 'a')], 1.9).ok).toBe(true); // floor(1.9)=1, 1 distinct source
  });
});
