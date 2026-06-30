// SPDX-License-Identifier: MIT
/**
 * Tests for weaveNotes Phase 8 workspace-RAG helpers: query-centred snippets, reciprocal
 * rank fusion, numbered cited-context assembly, and citation-marker parsing.
 */
import { describe, it, expect } from 'vitest';
import { snippetAround, reciprocalRankFusion, buildCitedContext, parseCitedIds, buildQueryExpansionPrompt, parseExpandedQueries, MAX_QUERY_VARIANTS, type RagHit } from './rag.js';

describe('snippetAround', () => {
  it('returns the whole text when shorter than the limit', () => {
    expect(snippetAround('A short note.', 'note', 240)).toBe('A short note.');
  });
  it('centres the excerpt on the first query-word match', () => {
    const content = `${'x '.repeat(200)}the mitochondria is the powerhouse ${'y '.repeat(200)}`;
    const snip = snippetAround(content, 'mitochondria powerhouse', 80);
    expect(snip).toContain('mitochondria');
    expect(snip.length).toBeLessThanOrEqual(82); // maxLen + ellipses
    expect(snip.startsWith('…')).toBe(true);
  });
  it('falls back to the start when nothing matches', () => {
    const snip = snippetAround('a'.repeat(500), 'zzz', 50);
    expect(snip).toBe(`${'a'.repeat(50)}…`);
  });
  it('collapses whitespace', () => {
    expect(snippetAround('a\n\n  b   c', 'a')).toBe('a b c');
  });
});

describe('reciprocalRankFusion', () => {
  it('rewards items ranked highly across multiple lists', () => {
    const a = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
    const b = [{ id: 'y' }, { id: 'x' }, { id: 'w' }];
    const fused = reciprocalRankFusion([a, b]);
    // y and x both appear near the top of both lists; they should lead w and z.
    expect(fused[0]!.id === 'x' || fused[0]!.id === 'y').toBe(true);
    const ids = fused.map((f) => f.id);
    expect(ids.indexOf('x')).toBeLessThan(ids.indexOf('z'));
    expect(ids.indexOf('y')).toBeLessThan(ids.indexOf('w'));
  });
  it('is score-scale independent (only ranks matter)', () => {
    const only = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }]]);
    expect(only.map((f) => f.id)).toEqual(['a', 'b']);
    expect(only[0]!.score).toBeGreaterThan(only[1]!.score);
  });
  it('handles an empty input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
  });
});

describe('buildCitedContext', () => {
  const hits: RagHit[] = [
    { id: 'n1', kind: 'note', title: 'Tides', content: 'The Bay of Fundy has the highest tides on Earth.', score: 0.9 },
    { id: 'r1', kind: 'run', title: 'Chat about tides', content: 'We learned the tidal range exceeds sixteen metres.', score: 0.8 },
  ];
  it('numbers sources and builds a context block', () => {
    const { context, sources } = buildCitedContext(hits, 'tides', { maxSources: 6 });
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ n: 1, id: 'n1', kind: 'note', title: 'Tides' });
    expect(sources[1]).toMatchObject({ n: 2, id: 'r1', kind: 'run' });
    expect(context).toContain('[1] (note: Tides)');
    expect(context).toContain('[2] (run: Chat about tides)');
    expect(context).toContain('highest tides on Earth');
  });
  it('caps the number of sources', () => {
    const many: RagHit[] = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, kind: 'note', title: `N${i}`, content: 'x', score: 1 }));
    expect(buildCitedContext(many, 'x', { maxSources: 3 }).sources).toHaveLength(3);
  });
});

describe('parseCitedIds', () => {
  const { sources } = buildCitedContext([
    { id: 'n1', kind: 'note', title: 'A', content: 'a', score: 1 },
    { id: 'r1', kind: 'run', title: 'B', content: 'b', score: 1 },
    { id: 'n2', kind: 'note', title: 'C', content: 'c', score: 1 },
  ], 'x');
  it('maps [n] markers back to source ids in first-mention order, deduped', () => {
    const cited = parseCitedIds('The answer draws on [2] and also [1], plus [2] again.', sources);
    expect(cited.map((c) => c.id)).toEqual(['r1', 'n1']);
  });
  it('handles grouped markers like [1, 3]', () => {
    expect(parseCitedIds('Both [1, 3] agree.', sources).map((c) => c.id)).toEqual(['n1', 'n2']);
  });
  it('ignores out-of-range numbers', () => {
    expect(parseCitedIds('See [9].', sources)).toEqual([]);
  });
});

describe('query expansion (multi-query + HyDE)', () => {
  it('asks for N rephrasings + a hypothetical answer, returning strict JSON', () => {
    const { system, user } = buildQueryExpansionPrompt('how did revenue change in Q3?', { n: 3 });
    expect(system).toMatch(/queries/);
    expect(system).toMatch(/hypothetical/i);
    expect(system).toMatch(/JSON/);
    expect(user).toContain('how did revenue change in Q3?');
  });
  it('clamps the requested count to the 2–4 band', () => {
    expect(buildQueryExpansionPrompt('q', { n: 99 }).system).toMatch(/4 alternative/);
    expect(buildQueryExpansionPrompt('q', { n: 1 }).system).toMatch(/2 alternative/);
  });
  it('parses variants, always puts the original first, dedupes, and caps', () => {
    const reply = '{"queries":["Q3 revenue change","quarterly sales growth","revenue change in Q3?"],"hypothetical":"Revenue rose 12% in Q3."}';
    const r = parseExpandedQueries(reply, 'how did revenue change in Q3?', { max: 4 });
    expect(r.variants[0]).toBe('how did revenue change in Q3?');   // original first
    expect(r.variants).toContain('Q3 revenue change');
    // "revenue change in Q3?" duplicates the original case-insensitively-ish? it's distinct text → kept
    expect(new Set(r.variants).size).toBe(r.variants.length);       // no dupes
    expect(r.variants.length).toBeLessThanOrEqual(4);
    expect(r.hypothetical).toBe('Revenue rose 12% in Q3.');
  });
  it('dedupes a variant identical to the original (case-insensitive)', () => {
    const r = parseExpandedQueries('{"queries":["My Query","other"]}', 'my query');
    expect(r.variants.filter((v) => v.toLowerCase() === 'my query').length).toBe(1);
  });
  it('is robust to junk / missing fields / surrounding prose', () => {
    expect(parseExpandedQueries('not json at all', 'orig').variants).toEqual(['orig']);
    expect(parseExpandedQueries('', 'orig').hypothetical).toBeNull();
    const wrapped = parseExpandedQueries('Sure!\n{"queries":["a","b"]}\nthanks', 'orig');
    expect(wrapped.variants).toEqual(['orig', 'a', 'b']);
    expect(parseExpandedQueries('{"queries":[1,null,{},"  "]}', 'orig').variants).toEqual(['orig']); // non-strings/empties dropped
  });
  it('never returns more than MAX_QUERY_VARIANTS', () => {
    const many = JSON.stringify({ queries: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(parseExpandedQueries(many, 'orig').variants.length).toBeLessThanOrEqual(MAX_QUERY_VARIANTS);
  });
});
