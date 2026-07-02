// SPDX-License-Identifier: MIT
/**
 * Tests for `extractKnowledgeGraph` (weaveNotes Phase 5) using a FAKE generate
 * function — proves the prompt→JSON→sanitize path: dedup, type clamping, malformed
 * relations dropped, code-fence tolerance, and graceful failure on bad output.
 */
import { describe, it, expect } from 'vitest';
import { extractKnowledgeGraph, type GenerateFn } from './knowledge-graph.js';

const gen = (payload: string): GenerateFn => async () => payload;

describe('extractKnowledgeGraph', () => {
  it('parses entities + relations and connects relation endpoints', async () => {
    const g = await extractKnowledgeGraph('doc', gen(JSON.stringify({
      entities: [{ name: 'Alice', type: 'person' }, { name: 'Acme', type: 'organization' }],
      relations: [{ subject: 'Alice', predicate: 'works at', object: 'Acme' }],
    })));
    expect(g.entities.map((e) => e.name).sort()).toEqual(['Acme', 'Alice']);
    expect(g.relations).toEqual([{ subject: 'Alice', predicate: 'works_at', object: 'Acme' }]); // predicate snake_cased
  });

  it('dedupes entities by name, clamps unknown types to "other", and adds missing relation endpoints', async () => {
    const g = await extractKnowledgeGraph('doc', gen(JSON.stringify({
      entities: [{ name: 'Qubit', type: 'frobnicate' }, { name: 'qubit', type: 'technology' }],
      relations: [{ subject: 'Qubit', predicate: 'is_a', object: 'Topological Qubit' }],
    })));
    expect(g.entities.filter((e) => e.name.toLowerCase() === 'qubit').length).toBe(1); // deduped
    expect(g.entities.find((e) => e.name === 'Qubit')!.type).toBe('other'); // unknown type clamped
    expect(g.entities.some((e) => e.name === 'Topological Qubit')).toBe(true); // endpoint added
  });

  it('tolerates code fences / leading prose around the JSON', async () => {
    const g = await extractKnowledgeGraph('doc', gen('Sure! Here you go:\n```json\n{"entities":[{"name":"Mars","type":"location"}],"relations":[]}\n```'));
    expect(g.entities).toEqual([{ name: 'Mars', type: 'location' }]);
  });

  it('drops malformed relations (missing fields)', async () => {
    const g = await extractKnowledgeGraph('doc', gen(JSON.stringify({
      entities: [{ name: 'A', type: 'concept' }],
      relations: [{ subject: 'A', object: 'B' }, { subject: 'A', predicate: 'rel', object: 'B' }],
    })));
    expect(g.relations).toEqual([{ subject: 'A', predicate: 'rel', object: 'B' }]);
  });

  it('returns an empty graph on non-JSON output or empty text (never throws)', async () => {
    expect(await extractKnowledgeGraph('doc', gen('I cannot do that.'))).toEqual({ entities: [], relations: [] });
    expect(await extractKnowledgeGraph('', gen('{}'))).toEqual({ entities: [], relations: [] });
    expect(await extractKnowledgeGraph('doc', async () => { throw new Error('model down'); })).toEqual({ entities: [], relations: [] });
  });
});
