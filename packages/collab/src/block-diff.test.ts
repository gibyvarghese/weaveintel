// SPDX-License-Identifier: MIT
/**
 * Tests for `diffBlocks` — the weaveNotes Phase 2 "diff-on-save" helper.
 *
 * The contract: after `diffBlocks(doc, target)`, the doc's rendered blocks equal
 * `target` (type + text + attrs + marks). And — the property that makes it safe
 * for collaboration — when two clients each diff against their OWN replica (which
 * has merged the other's ops), submitting the resulting ops CONVERGES, never
 * clobbering. We prove both, plus the structural edits (insert / delete / retype /
 * checkbox toggle / text edit / marks).
 */
import { describe, it, expect } from 'vitest';
import { BlockDoc, type BlockSpec, type RenderedBlock } from './block-doc.js';
import { pmToBlocks } from './prosemirror.js';
import { diffBlocks } from './block-diff.js';

/** Compare the doc's blocks to a target, ignoring ids. */
function shape(blocks: RenderedBlock[]): Array<{ type: string; text: string; attrs: Record<string, unknown>; marks: string[] }> {
  return blocks.map((b) => ({ type: b.type, text: b.text, attrs: b.attrs, marks: b.marks.map((m) => `${m.from}-${m.to}:${m.type}${m.value ? `(${m.value})` : ''}`) }));
}
function targetShape(specs: BlockSpec[]) {
  return specs.map((b) => ({ type: b.type, text: b.text ?? '', attrs: b.attrs ?? {}, marks: (b.marks ?? []).map((m) => `${m.from}-${m.to}:${m.type}${m.value ? `(${m.value})` : ''}`) }));
}

function docFrom(specs: BlockSpec[]): BlockDoc {
  return BlockDoc.fromBlocks('server', specs);
}

describe('diffBlocks — converges the replica onto the target', () => {
  it('edits text inside a block (prefix/suffix diff)', () => {
    const doc = docFrom([{ type: 'paragraph', text: 'The quick brown fox' }]);
    diffBlocks(doc, [{ type: 'paragraph', text: 'The quick red fox' }]);
    expect(doc.blocks()[0]!.text).toBe('The quick red fox');
  });

  it('appends a new block', () => {
    const doc = docFrom([{ type: 'heading', text: 'Title', attrs: { level: 1 } }]);
    const target: BlockSpec[] = [{ type: 'heading', text: 'Title', attrs: { level: 1 } }, { type: 'paragraph', text: 'Body' }];
    diffBlocks(doc, target);
    expect(shape(doc.blocks())).toEqual(targetShape(target));
  });

  it('deletes a block (merge away the marker)', () => {
    const doc = docFrom([{ type: 'paragraph', text: 'one' }, { type: 'paragraph', text: 'two' }, { type: 'paragraph', text: 'three' }]);
    const target: BlockSpec[] = [{ type: 'paragraph', text: 'one' }, { type: 'paragraph', text: 'three' }];
    diffBlocks(doc, target);
    expect(doc.blocks().map((b) => b.text)).toEqual(['one', 'three']);
  });

  it('retypes a block and toggles a checkbox attribute', () => {
    const doc = docFrom([{ type: 'taskItem', text: 'Do it', attrs: { checked: false } }]);
    diffBlocks(doc, [{ type: 'taskItem', text: 'Do it', attrs: { checked: true } }]);
    expect(doc.blocks()[0]!.attrs['checked']).toBe(true);
    diffBlocks(doc, [{ type: 'paragraph', text: 'Do it' }]);
    expect(doc.blocks()[0]!.type).toBe('paragraph');
  });

  it('adds and removes an inline mark', () => {
    const doc = docFrom([{ type: 'paragraph', text: 'Hello world' }]);
    diffBlocks(doc, [{ type: 'paragraph', text: 'Hello world', marks: [{ from: 0, to: 5, type: 'bold' }] }]);
    expect(doc.blocks()[0]!.marks.some((m) => m.type === 'bold' && m.from === 0 && m.to === 5)).toBe(true);
    diffBlocks(doc, [{ type: 'paragraph', text: 'Hello world' }]);
    expect(doc.blocks()[0]!.marks.length).toBe(0);
  });

  it('handles a complex multi-block rewrite (insert + delete + edit at once)', () => {
    const doc = docFrom([
      { type: 'heading', text: 'Plan', attrs: { level: 2 } },
      { type: 'paragraph', text: 'First draft' },
      { type: 'bulletListItem', text: 'old item' },
    ]);
    const target: BlockSpec[] = [
      { type: 'heading', text: 'Plan v2', attrs: { level: 2 } },
      { type: 'paragraph', text: 'Second draft', marks: [{ from: 0, to: 6, type: 'italic' }] },
      { type: 'bulletListItem', text: 'new item' },
      { type: 'bulletListItem', text: 'another' },
    ];
    diffBlocks(doc, target);
    expect(shape(doc.blocks())).toEqual(targetShape(target));
  });

  it('round-trips a ProseMirror doc via pmToBlocks', () => {
    const doc = docFrom([{ type: 'paragraph', text: 'start' }]);
    const pm = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'H' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'edited' }] },
    ] };
    const target = pmToBlocks(pm);
    diffBlocks(doc, target);
    expect(shape(doc.blocks())).toEqual(targetShape(target));
  });
});

describe('diffBlocks — concurrent diff-on-save converges (no clobber)', () => {
  it('two clients each edit a different block of their synced replica → converge', () => {
    // Shared starting doc.
    const seed: BlockSpec[] = [{ type: 'paragraph', text: 'alpha' }, { type: 'paragraph', text: 'beta' }];
    const server = BlockDoc.fromBlocks('server', seed);
    const snap = server.snapshot();

    // Two clients load the same snapshot as their replica.
    const a = BlockDoc.fromSnapshot('u:a:1', snap);
    const b = BlockDoc.fromSnapshot('u:b:1', snap);

    // A edits block 1; B edits block 2 — each diffs against its OWN replica.
    const aOps = diffBlocks(a, [{ type: 'paragraph', text: 'alpha-A' }, { type: 'paragraph', text: 'beta' }]);
    const bOps = diffBlocks(b, [{ type: 'paragraph', text: 'alpha' }, { type: 'paragraph', text: 'beta-B' }]);

    // Server applies both; clients pull each other's ops (as the live stream would deliver).
    server.applyMany(aOps); server.applyMany(bOps);
    a.applyMany(bOps); b.applyMany(aOps);

    // All three converge, and BOTH edits survived (no clobber).
    expect(a.text()).toBe(b.text());
    expect(b.text()).toBe(server.text());
    expect(server.text()).toContain('alpha-A');
    expect(server.text()).toContain('beta-B');
  });
});
