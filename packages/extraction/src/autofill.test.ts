// SPDX-License-Identifier: MIT
/**
 * Tests for `autofillProperty` (weaveNotes Phase 6) with a FAKE generate function:
 * proves the typed value coercion, citation filtering (only declared sources), select
 * option enforcement, code-fence tolerance, and graceful failure.
 */
import { describe, it, expect } from 'vitest';
import { autofillProperty } from './autofill.js';
import type { GenerateFn } from './knowledge-graph.js';

const gen = (payload: string): GenerateFn => async () => payload;

describe('autofillProperty', () => {
  const rows = [
    { rowId: 'r1', title: 'Acme', context: 'Founded in 1999. [src:note1]', sourceIds: ['src:note1', 'src:web1'] },
    { rowId: 'r2', title: 'Globex', context: 'Started 2010. [src:note2]', sourceIds: ['src:note2'] },
  ];

  it('fills a number column with citations restricted to each row\'s sources', async () => {
    const g = gen(JSON.stringify([
      { rowId: 'r1', value: '1999', citations: ['src:note1', 'src:bogus'] }, // bogus dropped (not in r1 sources)
      { rowId: 'r2', value: 2010, citations: ['src:note2'] },
    ]));
    const cells = await autofillProperty({ property: { name: 'Founded', type: 'number' }, rows, generate: g });
    expect(cells).toEqual([
      { rowId: 'r1', value: 1999, citations: ['src:note1'] },   // coerced to number, bogus citation removed
      { rowId: 'r2', value: 2010, citations: ['src:note2'] },
    ]);
  });

  it('enforces select options (out-of-range → null)', async () => {
    const g = gen(JSON.stringify([{ rowId: 'r1', value: 'Enterprise', citations: [] }, { rowId: 'r2', value: 'Other', citations: [] }]));
    const cells = await autofillProperty({ property: { name: 'Tier', type: 'select', options: ['Enterprise', 'SMB'] }, rows, generate: g });
    expect(cells.find((c) => c.rowId === 'r1')!.value).toBe('Enterprise');
    expect(cells.find((c) => c.rowId === 'r2')!.value).toBeNull(); // not an allowed option
  });

  it('ignores unknown rowIds and tolerates code fences', async () => {
    const g = gen('```json\n[{"rowId":"r1","value":"A summary","citations":["src:web1"]},{"rowId":"ghost","value":"x"}]\n```');
    const cells = await autofillProperty({ property: { name: 'Summary', type: 'text' }, rows, generate: g });
    expect(cells.map((c) => c.rowId)).toEqual(['r1']); // ghost row dropped
    expect(cells[0]!.value).toBe('A summary');
  });

  it('returns [] on bad output / no rows / model error', async () => {
    expect(await autofillProperty({ property: { name: 'X', type: 'text' }, rows, generate: gen('nope') })).toEqual([]);
    expect(await autofillProperty({ property: { name: 'X', type: 'text' }, rows: [], generate: gen('[]') })).toEqual([]);
    expect(await autofillProperty({ property: { name: 'X', type: 'text' }, rows, generate: async () => { throw new Error('down'); } })).toEqual([]);
  });
});
