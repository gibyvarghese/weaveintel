// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  blocksToDoc, docToBlocks, blocksPlainText, hasInk, inkCanvasNode, emptyNoteDoc,
  type NoteBlock,
} from './note-doc.js';
import type { InkStroke } from './ink.js';

const stroke = (overrides: Partial<InkStroke> = {}): InkStroke => ({
  points: [{ x: 0, y: 0 }, { x: 10, y: 12 }, { x: 20, y: 8 }],
  color: '#14201B', width: 3, tool: 'pen', author: 'user', ...overrides,
});

describe('note-doc — the shared mobile ⇆ web block model', () => {
  it('round-trips text blocks (paragraph / heading / bullet / todo) through doc_json', () => {
    const blocks: NoteBlock[] = [
      { type: 'heading', level: 1, text: 'Field notes' },
      { type: 'paragraph', text: 'Visited the north site today.' },
      { type: 'bullet', items: ['Soil dry', 'Fence broken'] },
      { type: 'todo', items: [{ text: 'Order wire', checked: false }, { text: 'Call Sam', checked: true }] },
    ];
    const round = docToBlocks(blocksToDoc(blocks));
    expect(round).toEqual(blocks);
  });

  it('produces the exact inkCanvas node the web renders (strokes + author in attrs)', () => {
    const node = inkCanvasNode([stroke()], 'user');
    expect(node.type).toBe('inkCanvas');
    expect(node.attrs?.['author']).toBe('user');
    expect(Array.isArray(node.attrs?.['strokes'])).toBe(true);
    expect((node.attrs?.['strokes'] as InkStroke[])[0]!.tool).toBe('pen');
  });

  it('round-trips an ink drawing with strokes INTACT (the Phase 7 "Done when")', () => {
    const blocks: NoteBlock[] = [
      { type: 'paragraph', text: 'Sketch of the valve:' },
      { type: 'inkCanvas', strokes: [stroke(), stroke({ color: '#C2410C', tool: 'highlighter', width: 8 })], author: 'user' },
    ];
    const docJson = blocksToDoc(blocks);
    // Simulate the web reading the synced note: parse the doc_json the server stored.
    const parsed = JSON.parse(docJson) as { content: Array<{ type: string; attrs?: { strokes?: InkStroke[]; author?: string } }> };
    const ink = parsed.content.find((n) => n.type === 'inkCanvas')!;
    expect(ink.attrs?.author).toBe('user');
    expect(ink.attrs?.strokes).toHaveLength(2);
    expect(ink.attrs?.strokes![0]!.points).toHaveLength(3);
    expect(ink.attrs?.strokes![1]!.tool).toBe('highlighter');
    // And the mobile parser reads its own output back identically.
    expect(hasInk(docToBlocks(docJson))).toBe(true);
  });

  it('PRESERVES web-only nodes (diagram/image/callout) verbatim across a mobile round-trip', () => {
    // A note authored on the web with rich nodes the mobile editor cannot render.
    const webDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
        { type: 'diagram', attrs: { scene: { nodes: [{ id: 'a', label: 'Start' }], edges: [] } } },
        { type: 'callout', attrs: { tone: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Careful' }] }] },
        { type: 'image', attrs: { src: 'artifact://x', alt: 'chart' } },
      ],
    };
    const blocks = docToBlocks(JSON.stringify(webDoc));
    // The mobile editor sees them as opaque "unsupported" blocks…
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'unsupported', 'unsupported', 'unsupported']);
    expect(blocks.filter((b) => b.type === 'unsupported').map((b) => (b as { nodeType: string }).nodeType))
      .toEqual(['diagram', 'callout', 'image']);

    // …and writing back reproduces the ORIGINAL nodes exactly (the diagram is never dropped).
    const reEmitted = JSON.parse(blocksToDoc(blocks));
    expect(reEmitted).toEqual(webDoc);
  });

  it('mobile editing text around a web diagram keeps the diagram intact', () => {
    const webDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'diagram', attrs: { scene: { nodes: [], edges: [] } } },
      ],
    };
    const blocks = docToBlocks(JSON.stringify(webDoc));
    // The phone user edits the paragraph + adds an ink sketch — the diagram block is untouched.
    (blocks[0] as { text: string }).text = 'after edit';
    blocks.push({ type: 'inkCanvas', strokes: [stroke()], author: 'user' });
    const out = JSON.parse(blocksToDoc(blocks)) as { content: Array<{ type: string }> };
    expect(out.content.map((n) => n.type)).toEqual(['paragraph', 'diagram', 'inkCanvas']);
    expect(out.content[1]).toEqual(webDoc.content[1]); // diagram byte-identical
  });

  it('plain-text preview summarises every block kind', () => {
    const blocks: NoteBlock[] = [
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'paragraph', text: 'Body text' },
      { type: 'bullet', items: ['one', 'two'] },
      { type: 'inkCanvas', strokes: [stroke()], author: 'user' },
    ];
    const text = blocksPlainText(blocks);
    expect(text).toContain('Title');
    expect(text).toContain('Body text');
    expect(text).toContain('one two');
    expect(text).toContain('[ink drawing]');
  });
});

describe('note-doc — robustness + security (negative/stress)', () => {
  it('tolerates malformed / empty / non-doc input without throwing', () => {
    expect(docToBlocks(null)).toEqual([]);
    expect(docToBlocks(undefined)).toEqual([]);
    expect(docToBlocks('')).toEqual([]);
    expect(docToBlocks('not json{')).toEqual([]);
    expect(docToBlocks('{"type":"notadoc"}')).toEqual([]);
    expect(docToBlocks('{"type":"doc"}')).toEqual([]); // no content array
    expect(docToBlocks(emptyNoteDoc())).toEqual([]);
  });

  it('sanitises hostile ink strokes via the package gate (no script, bounded points)', () => {
    const hostile = [{
      points: [{ x: 'javascript:alert(1)', y: NaN }, { x: 5, y: 5 }],
      color: '"><script>alert(1)</script>', width: 99999, tool: 'not-a-tool',
    }];
    const node = inkCanvasNode(hostile, 'user');
    const strokes = node.attrs?.['strokes'] as InkStroke[];
    // validateStrokes coerces coords to numbers, clamps width, and keeps only known tools.
    if (strokes.length > 0) {
      expect(strokes[0]!.tool === 'pen' || strokes[0]!.tool === 'highlighter' || strokes[0]!.tool === 'eraser').toBe(true);
      expect(strokes[0]!.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
      expect(strokes[0]!.width).toBeLessThanOrEqual(1000);
    }
  });

  it('STRESS: a large note (500 blocks incl. ink) round-trips and stays structurally identical', () => {
    const blocks: NoteBlock[] = [];
    for (let i = 0; i < 500; i++) {
      blocks.push(i % 50 === 0
        ? { type: 'inkCanvas', strokes: [stroke()], author: 'user' }
        : { type: 'paragraph', text: `line ${i}` });
    }
    const round = docToBlocks(blocksToDoc(blocks));
    expect(round).toHaveLength(500);
    expect(round.filter((b) => b.type === 'inkCanvas')).toHaveLength(10);
  });
});
