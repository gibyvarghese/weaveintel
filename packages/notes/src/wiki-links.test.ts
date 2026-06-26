// SPDX-License-Identifier: MIT
/**
 * Tests for weaveNotes Phase 5 wiki-link parsing + unlinked-mention detection.
 * Positive (links/aliases parsed; mentions found), negative (no false positives on
 * short titles, substrings, or already-linked titles), and ordering.
 */
import { describe, it, expect } from 'vitest';
import { parseWikiLinks, findUnlinkedMentions, titleKey } from './wiki-links.js';

describe('parseWikiLinks', () => {
  it('parses [[Title]] and [[Title|alias]]', () => {
    const links = parseWikiLinks('See [[Quantum Computing]] and [[Majorana Qubits|the qubits]] today.');
    expect(links.map((l) => l.target)).toEqual(['Quantum Computing', 'Majorana Qubits']);
    expect(links[1]!.alias).toBe('the qubits');
  });
  it('trims targets and skips empty ones', () => {
    const links = parseWikiLinks('a [[  Spaced Title  ]] b [[]] c [[|x]]');
    expect(links.map((l) => l.target)).toEqual(['Spaced Title']);
  });
  it('returns [] for text with no links', () => {
    expect(parseWikiLinks('plain text, no links')).toEqual([]);
    expect(parseWikiLinks('')).toEqual([]);
  });
});

describe('findUnlinkedMentions', () => {
  const candidates = [
    { id: 'n1', title: 'Quantum Computing' },
    { id: 'n2', title: 'Majorana Qubits' },
    { id: 'n3', title: 'AI' }, // short — should be ignored by default minTitleLength
  ];

  it('finds a plain-text title mention that is not yet linked', () => {
    const text = 'Today I read about Quantum Computing and how it relates to error correction.';
    const found = findUnlinkedMentions(text, candidates);
    expect(found.map((m) => m.id)).toEqual(['n1']);
    expect(found[0]!.count).toBe(1);
  });

  it('does NOT re-suggest a title that is already a [[wiki-link]]', () => {
    const text = 'I linked [[Quantum Computing]] but also mention Majorana Qubits in prose.';
    const found = findUnlinkedMentions(text, candidates, { linkedTitleKeys: new Set([titleKey('Quantum Computing')]) });
    // Quantum Computing is linked (excluded); Majorana Qubits is an unlinked mention.
    expect(found.map((m) => m.id)).toEqual(['n2']);
  });

  it('excludes the note itself and short titles; no substring false-positives', () => {
    const text = 'AISLE and QUANTUM are not the same as Quantum Computing. Self mention here.';
    const withSelf = [...candidates, { id: 'self', title: 'Self mention' }];
    const found = findUnlinkedMentions(text, withSelf, { excludeIds: new Set(['self']) });
    // 'AI' is too short (skipped); 'QUANTUM' alone is NOT a whole-phrase match for 'Quantum Computing';
    // 'Quantum Computing' IS present once; 'Self mention' excluded as self.
    expect(found.map((m) => m.id)).toEqual(['n1']);
  });

  it('counts multiple mentions and orders most-mentioned first', () => {
    const text = 'Majorana Qubits here. More Majorana Qubits there. And Quantum Computing once.';
    const found = findUnlinkedMentions(text, candidates);
    expect(found.map((m) => m.id)).toEqual(['n2', 'n1']); // n2 mentioned twice
    expect(found[0]!.count).toBe(2);
  });
});
