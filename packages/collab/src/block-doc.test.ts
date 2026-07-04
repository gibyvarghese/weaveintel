// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { BlockDoc, type BlockOp, type BlockSpec } from './block-doc.js';

function summary(doc: BlockDoc): string {
  return doc.blocks().map((b) => `${b.type}:${b.text}`).join('|');
}
function applyAll(doc: BlockDoc, ops: BlockOp[]): void { for (const op of ops) doc.apply(op); }

describe('BlockDoc — basic block editing', () => {
  it('builds a document from block specs and reads it back', () => {
    const specs: BlockSpec[] = [
      { type: 'heading', attrs: { level: 2 }, text: 'Title' },
      { type: 'paragraph', text: 'Hello world' },
      { type: 'taskItem', attrs: { checked: false }, text: 'Do the thing' },
    ];
    const doc = BlockDoc.fromBlocks('a', specs);
    const blocks = doc.blocks();
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'taskItem']);
    expect(blocks[0]!.attrs['level']).toBe(2);
    expect(blocks[1]!.text).toBe('Hello world');
    expect(blocks[2]!.attrs['checked']).toBe(false);
  });

  it('inserts text + new blocks; split + merge', () => {
    const doc = new BlockDoc('a');
    const { blockId } = doc.insertBlock(null, 'paragraph');
    doc.insertText(blockId, 0, 'HelloWorld');
    expect(summary(doc)).toBe('paragraph:HelloWorld');
    // Split after "Hello" → two paragraphs.
    doc.splitBlock(blockId, 5, 'paragraph');
    expect(doc.blocks().map((b) => b.text)).toEqual(['Hello', 'World']);
    // Merge the second back into the first.
    const second = doc.blocks()[1]!.id!;
    doc.mergeBlock(second);
    expect(summary(doc)).toBe('paragraph:HelloWorld');
  });

  it('setBlockType + setBlockAttr are last-write-wins', () => {
    const doc = new BlockDoc('a');
    const { blockId } = doc.insertBlock(null, 'paragraph');
    doc.insertText(blockId, 0, 'Heading text');
    doc.setBlockType(blockId, 'heading');
    doc.setBlockAttr(blockId, 'level', 1);
    expect(doc.blocks()[0]!.type).toBe('heading');
    expect(doc.blocks()[0]!.attrs['level']).toBe(1);
  });

  it('inline marks resolve to character offsets', () => {
    const doc = BlockDoc.fromBlocks('a', [{ type: 'paragraph', text: 'bold and plain' }]);
    const blockId = doc.blocks()[0]!.id;
    doc.addMark(blockId, 0, 4, 'bold');     // "bold"
    doc.addMark(blockId, 9, 14, 'italic');  // "plain"
    const marks = doc.blocks()[0]!.marks;
    expect(marks.find((m) => m.type === 'bold')).toMatchObject({ from: 0, to: 4 });
    expect(marks.find((m) => m.type === 'italic')).toMatchObject({ from: 9, to: 14 });
    // Remove the bold.
    doc.removeMark(blockId, 0, 4, 'bold');
    expect(doc.blocks()[0]!.marks.some((m) => m.type === 'bold')).toBe(false);
  });
});

describe('BlockDoc — CONVERGENCE', () => {
  it('two replicas concurrently editing different blocks converge', () => {
    const seed = BlockDoc.fromBlocks('seed', [{ type: 'paragraph', text: 'A' }, { type: 'paragraph', text: 'B' }]);
    const seedOps = seed.opsSince({});
    const alice = new BlockDoc('alice'); applyAll(alice, seedOps);
    const bob = new BlockDoc('bob'); applyAll(bob, seedOps);

    const aBlock = alice.blocks()[0]!.id;
    const bBlock = bob.blocks()[1]!.id;
    const aOps = alice.insertText(aBlock, 1, 'lice'); // "Alice"
    const bOps = bob.insertText(bBlock, 1, 'ravo');   // "Bravo"
    applyAll(alice, bOps); applyAll(bob, aOps);
    expect(summary(alice)).toBe(summary(bob));
    expect(alice.blocks().map((b) => b.text)).toEqual(['Alice', 'Bravo']);
  });

  it('concurrent block inserts at the same point converge (deterministic order)', () => {
    const seed = BlockDoc.fromBlocks('seed', [{ type: 'paragraph', text: 'X' }]);
    const seedOps = seed.opsSince({});
    const a = new BlockDoc('a'); applyAll(a, seedOps);
    const b = new BlockDoc('b'); applyAll(b, seedOps);
    const after = a.blocks()[0]!.id!;
    const aOps = a.insertBlock(after, 'heading').ops; a.insertText(a.blocks()[1]!.id, 0, 'fromA');
    const allA = a.opsSince(seed.stateVector());
    const bAfter = b.blocks()[0]!.id!;
    b.insertBlock(bAfter, 'paragraph'); b.insertText(b.blocks()[1]!.id, 0, 'fromB');
    const allB = b.opsSince(seed.stateVector());
    void aOps;
    a.applyMany(allB); b.applyMany(allA);
    expect(summary(a)).toBe(summary(b)); // converged
    expect(a.blocks().length).toBe(3);
  });

  it('split + concurrent insert at the split point converge (no interleave)', () => {
    const seed = BlockDoc.fromBlocks('seed', [{ type: 'paragraph', text: 'HelloWorld' }]);
    const sv = seed.snapshot();
    const a = BlockDoc.fromSnapshot('a', sv);
    const b = BlockDoc.fromSnapshot('b', sv);
    const blockId = a.blocks()[0]!.id;
    const aOps = a.splitBlock(blockId, 5).ops;              // A splits after "Hello"
    const bOps = b.insertText(b.blocks()[0]!.id, 5, 'XYZ'); // B inserts at the same point
    a.applyMany(bOps); b.applyMany(aOps);
    expect(summary(a)).toBe(summary(b));                    // converged
  });

  it('concurrent CONFLICTING marks (same span+type) converge by (lamport, siteId) tiebreak', () => {
    // Two replicas highlight the SAME span with DIFFERENT colours at the SAME lamport. The LWW
    // tiebreak must pick the SAME winner on both — deterministically the higher siteId ('bob' > 'alice').
    // Before the fix (siteId compared to '') the winner depended on apply ORDER → divergence.
    const seed = BlockDoc.fromBlocks('seed', [{ type: 'paragraph', text: 'highlight me' }]);
    const snap = seed.snapshot();
    const alice = BlockDoc.fromSnapshot('alice', snap);
    const bob = BlockDoc.fromSnapshot('bob', snap);
    const aOps = [alice.addMark(alice.blocks()[0]!.id, 0, 9, 'highlight', 'amber')!];
    const bOps = [bob.addMark(bob.blocks()[0]!.id, 0, 9, 'highlight', 'teal')!];
    alice.applyMany(bOps); bob.applyMany(aOps);

    const aMark = alice.blocks()[0]!.marks.find((m) => m.type === 'highlight');
    const bMark = bob.blocks()[0]!.marks.find((m) => m.type === 'highlight');
    expect(aMark?.value).toBe(bMark?.value);   // both replicas AGREE
    expect(aMark?.value).toBe('teal');         // and it's deterministically the higher siteId's value

    // The winner SURVIVES a snapshot round-trip identically (siteId is preserved, not blanked).
    const reloaded = BlockDoc.fromSnapshot('carol', alice.snapshot());
    expect(reloaded.blocks()[0]!.marks.find((m) => m.type === 'highlight')?.value).toBe('teal');
    // Re-applying the LOSING op after reload must NOT flip the winner (tiebreak still deterministic).
    reloaded.applyMany(aOps);
    expect(reloaded.blocks()[0]!.marks.find((m) => m.type === 'highlight')?.value).toBe('teal');
  });

  it('fuzz: N replicas with random block + text ops all converge', () => {
    function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; }; }
    for (let trial = 0; trial < 6; trial++) {
      const r = rng(99 + trial * 13);
      const seed = BlockDoc.fromBlocks('seed', [{ type: 'paragraph', text: 'seed' }]);
      const snap = seed.snapshot();
      const docs = ['a', 'b', 'c'].map((s) => BlockDoc.fromSnapshot(s, snap));
      const all: BlockOp[] = [];
      for (let round = 0; round < 30; round++) {
        const doc = docs[Math.floor(r() * docs.length)]!;
        const blocks = doc.blocks();
        const blk = blocks[Math.floor(r() * blocks.length)]!;
        const choice = r();
        if (choice < 0.4) all.push(...doc.insertText(blk.id, Math.floor(r() * (blk.text.length + 1)), String.fromCharCode(97 + Math.floor(r() * 26))));
        else if (choice < 0.6 && blk.text.length > 0) all.push(...doc.deleteText(blk.id, Math.floor(r() * blk.text.length), 1));
        else if (choice < 0.8) all.push(...doc.insertBlock(blk.id, r() < 0.5 ? 'paragraph' : 'heading').ops);
        else if (blk.id) all.push(...doc.splitBlock(blk.id, Math.floor(r() * (blk.text.length + 1))).ops);
      }
      for (const doc of docs) {
        const shuffled = [...all];
        for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
        doc.applyMany(shuffled); doc.applyMany(shuffled); // twice = idempotency
      }
      const texts = docs.map((d) => summary(d));
      expect(new Set(texts).size).toBe(1); // ALL converged
    }
  });
});

describe('BlockDoc — sync + snapshot', () => {
  it('opsSince delivers exactly the missing ops; snapshot round-trips', () => {
    const a = BlockDoc.fromBlocks('a', [{ type: 'heading', attrs: { level: 1 }, text: 'Doc' }, { type: 'paragraph', text: 'body' }]);
    const b = new BlockDoc('b');
    b.applyMany(a.opsSince(b.stateVector()));
    expect(summary(b)).toBe(summary(a));
    const restored = BlockDoc.fromSnapshot('c', a.snapshot());
    expect(summary(restored)).toBe(summary(a));
    expect(restored.blocks()[0]!.attrs['level']).toBe(1);
  });

  it('a second setBlockAttr after a snapshot reload WINS (mint clock advances past restored attr ops)', () => {
    // Regression: fromSnapshot bumped the mint clock from element ops only, not attr/mark ops. So a
    // second edit to the SAME attr on the SAME site re-minted the same counter → lamport tie → the
    // stale value wrongly won (a diagram/ink scene edit was silently dropped after a reload).
    const doc = BlockDoc.fromBlocks('s', [{ type: 'diagram', attrs: { scene: { nodes: ['a'] } } }]);
    const bid = doc.blocks()[0]!.id;
    doc.apply(doc.setBlockAttr(bid, 'scene', { nodes: ['a', 'b'] })); // first edit (highest counter is now an attr op)
    const reloaded = BlockDoc.fromSnapshot('s', doc.snapshot());      // reload under the SAME site
    reloaded.apply(reloaded.setBlockAttr(bid, 'scene', { nodes: ['a', 'b', 'c'] })); // second edit
    expect((reloaded.blocks()[0]!.attrs['scene'] as { nodes: string[] }).nodes).toEqual(['a', 'b', 'c']);
  });
});
