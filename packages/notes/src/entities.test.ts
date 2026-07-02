// SPDX-License-Identifier: MIT
/**
 * Tests for weaveNotes Phase 3 entity resolution / disambiguation (GraphRAG graph quality).
 * Canonicalisation (case/punct/accents/articles/legal-suffixes), alias folding, acronym↔full-name
 * merge, best-display-name choice, type voting, and batching.
 */
import { describe, it, expect } from 'vitest';
import { canonicalizeEntityName, resolveEntities, chunk } from './entities.js';

describe('canonicalizeEntityName', () => {
  it('folds case, punctuation, articles and legal suffixes to one key', () => {
    const k = canonicalizeEntityName('OpenAI');
    expect(canonicalizeEntityName('Open AI')).not.toBe(k);         // a space IS a different token…
    expect(canonicalizeEntityName('OpenAI, Inc.')).toBe(k);        // …but punctuation + suffix fold
    expect(canonicalizeEntityName('the OpenAI')).toBe(k);
    expect(canonicalizeEntityName('  OPENAI  ')).toBe(k);
  });
  it('strips accents so São Paulo === Sao Paulo', () => {
    expect(canonicalizeEntityName('São Paulo')).toBe(canonicalizeEntityName('Sao Paulo'));
  });
  it('drops a trailing company suffix but keeps the core name', () => {
    expect(canonicalizeEntityName('Globex Corporation')).toBe('globex');
    expect(canonicalizeEntityName('Initech LLC')).toBe('initech');
  });
  it('returns empty for blank input', () => { expect(canonicalizeEntityName('   ')).toBe(''); });
});

describe('resolveEntities', () => {
  it('merges spelling variants into ONE canonical entity with aliases + count', () => {
    const out = resolveEntities([
      { name: 'OpenAI', type: 'org' },
      { name: 'OpenAI, Inc.', type: 'organization' },
      { name: 'the OpenAI' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(3);
    expect(out[0]!.aliases.sort()).toEqual(['OpenAI', 'OpenAI, Inc.', 'the OpenAI'].sort());
    expect(out[0]!.name).toBe('OpenAI, Inc.'); // fullest surface form
  });

  it('merges an acronym with its full name when both appear', () => {
    const out = resolveEntities([
      { name: 'World Health Organization' },
      { name: 'World Health Organization' },
      { name: 'WHO' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.count).toBe(3);
    expect(out[0]!.name).toBe('World Health Organization'); // full name preferred over the acronym
    expect(out[0]!.aliases).toContain('WHO');
  });

  it('keeps genuinely different entities apart + orders by mention count', () => {
    const out = resolveEntities([
      { name: 'Mars' }, { name: 'Mars' }, { name: 'Mars' },
      { name: 'Venus' },
    ]);
    expect(out.map((e) => e.name)).toEqual(['Mars', 'Venus']); // Mars first (3 > 1)
    expect(out.find((e) => e.name === 'Venus')!.count).toBe(1);
  });

  it('votes the most common type', () => {
    const out = resolveEntities([
      { name: 'Ada Lovelace', type: 'person' },
      { name: 'Ada Lovelace', type: 'person' },
      { name: 'Ada Lovelace', type: 'mathematician' },
    ]);
    expect(out[0]!.type).toBe('person');
  });

  it('is empty for no input', () => { expect(resolveEntities([])).toEqual([]); });
});

describe('chunk', () => {
  it('splits into batches of at most size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]); // size<1 → 1
  });
});
