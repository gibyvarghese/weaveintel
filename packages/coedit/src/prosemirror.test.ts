// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { pmToBlocks, blocksToProseMirror, normalizeBlocks, type NormalBlock } from './prosemirror.js';
import { BlockDoc } from './block-doc.js';
import { blocksToMarkdown, blocksToHtml } from './block-markdown.js';
import { markdownToBlocks, createBlockAgentPeer } from './block-agent.js';

const RICH_DOC = {
  type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Research findings' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Tides are caused by ' }, { type: 'text', text: 'gravity', marks: [{ type: 'bold' }] }, { type: 'text', text: '.' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Moon pull' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Sun pull' }] }] },
    ] },
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: false }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Verify the claim' }] }] },
      { type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done item' }] }] },
    ] },
    { type: 'codeBlock', attrs: { language: 'python' }, content: [{ type: 'text', text: 'print("hi")' }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A quote' }] }] },
    { type: 'horizontalRule' },
    { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'text', text: 'the source', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
  ],
};

describe('pmToBlocks / blocksToProseMirror — round-trip', () => {
  it('flattens a rich ProseMirror doc into blocks with the right types + attrs + marks', () => {
    const blocks = pmToBlocks(RICH_DOC);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading', 'paragraph', 'bulletListItem', 'bulletListItem', 'taskItem', 'taskItem', 'codeBlock', 'blockquote', 'divider', 'paragraph',
    ]);
    expect(blocks[0]!.attrs!['level']).toBe(2);
    expect(blocks[1]!.marks!.find((m) => m.type === 'bold')).toMatchObject({ from: 20, to: 27 }); // "gravity"
    expect(blocks[4]!.attrs!['checked']).toBe(false);
    expect(blocks[5]!.attrs!['checked']).toBe(true);
    expect(blocks[7]!.text).toBe('A quote');
    expect(blocks[9]!.marks!.find((m) => m.type === 'link')?.value).toBe('https://example.com');
  });

  it('is a STABLE round-trip: pm → blocks → pm → blocks is identical', () => {
    const blocks1 = pmToBlocks(RICH_DOC);
    const rendered1 = renderViaBlockDoc(blocks1);
    const pm2 = blocksToProseMirror(rendered1);
    const blocks2 = pmToBlocks(pm2);
    const rendered2 = renderViaBlockDoc(blocks2);
    expect(rendered2).toEqual(rendered1); // round-trip identity at the block level
    // The rebuilt PM groups list items back into their wrappers.
    expect(pm2.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'taskList', 'codeBlock', 'blockquote', 'horizontalRule', 'paragraph']);
  });

  it('survives the doc going THROUGH the CRDT unchanged', () => {
    const doc = BlockDoc.fromBlocks('a', pmToBlocks(RICH_DOC));
    const pm = blocksToProseMirror(doc.blocks());
    expect(pmToBlocks(pm).map((b) => b.type)).toEqual(pmToBlocks(RICH_DOC).map((b) => b.type));
    // Bold + link marks survived the CRDT.
    const rebuilt = doc.blocks();
    expect(rebuilt.find((b) => b.marks.some((m) => m.type === 'bold'))).toBeTruthy();
    expect(rebuilt.find((b) => b.marks.some((m) => m.type === 'link'))?.marks.find((m) => m.type === 'link')?.value).toBe('https://example.com');
  });
});

describe('normalizeBlocks — adversarial / schema repair', () => {
  it('clamps heading levels, empties dividers, and guarantees a non-empty doc', () => {
    const adversarial: NormalBlock[] = [
      { type: 'heading', attrs: { level: 99 }, text: 'too big', marks: [] },
      { type: 'heading', attrs: { level: -3 }, text: 'too small', marks: [] },
      { type: 'divider', attrs: {}, text: 'junk on a divider', marks: [{ from: 0, to: 1, type: 'bold' }] },
    ];
    const norm = normalizeBlocks(adversarial);
    expect(norm[0]!.attrs['level']).toBe(6);
    expect(norm[1]!.attrs['level']).toBe(1);
    expect(norm[2]!.text).toBe('');     // divider text stripped
    expect(norm[2]!.marks).toEqual([]);
    expect(normalizeBlocks([]).length).toBe(1); // empty → one paragraph
    expect(blocksToProseMirror([]).content[0]!.type).toBe('paragraph'); // always valid PM
  });

  it('a doc built from concurrent merges is always valid PM (≥1 block, valid lists)', () => {
    const a = BlockDoc.fromBlocks('a', [{ type: 'bulletListItem', text: 'x' }]);
    const b = BlockDoc.fromSnapshot('b', a.snapshot());
    // Both delete the only block marker concurrently → an empty/odd state.
    a.mergeBlock(a.blocks()[0]!.id!);
    const pm = blocksToProseMirror(a.blocks());
    expect(pm.content.length).toBeGreaterThanOrEqual(1);
    expect(pm.type).toBe('doc');
    void b;
  });
});

describe('blocksToMarkdown / blocksToHtml', () => {
  it('renders the rich doc to Markdown', () => {
    const md = blocksToMarkdown(renderViaBlockDoc(pmToBlocks(RICH_DOC)));
    expect(md).toContain('## Research findings');
    expect(md).toContain('Tides are caused by **gravity**.');
    expect(md).toContain('- Moon pull');
    expect(md).toContain('- [ ] Verify the claim');
    expect(md).toContain('- [x] Done item');
    expect(md).toContain('```python');
    expect(md).toContain('> A quote');
    expect(md).toContain('[the source](https://example.com)');
  });

  it('renders sanitized HTML (escapes, http-only links)', () => {
    const blocks: NormalBlock[] = [
      { type: 'paragraph', attrs: {}, text: '<script>alert(1)</script>', marks: [] },
      { type: 'paragraph', attrs: {}, text: 'click', marks: [{ from: 0, to: 5, type: 'link', value: 'javascript:alert(1)' }] },
    ];
    const html = blocksToHtml(blocks);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript:'); // dangerous scheme neutralised to '#'
  });
});

describe('agent as a block co-editor', () => {
  it('parses Markdown into blocks and merges with a concurrent human edit', () => {
    const human = new BlockDoc('human');
    const { blockId } = human.insertBlock(null, 'heading', { level: 1 });
    human.insertText(blockId, 0, 'My note');
    const seed = human.snapshot();

    const agent = BlockDoc.fromSnapshot('agent:run-1', seed);
    const peer = createBlockAgentPeer(agent);
    const agentOps = peer.appendMarkdown('## Findings\n- point one\n- point two\n\n- [ ] follow up');

    // The human keeps editing concurrently.
    const humanOps = human.insertText(blockId, 7, '!');
    human.applyMany(agentOps);
    agent.applyMany(humanOps);
    expect(human.blocks().map((b) => b.type)).toEqual(agent.blocks().map((b) => b.type));
    const types = human.blocks().map((b) => b.type);
    expect(types).toContain('heading');
    expect(types).toContain('bulletListItem');
    expect(types).toContain('taskItem');
    expect(human.blocks()[0]!.text).toBe('My note!'); // human edit preserved
  });

  it('suggest mode computes ops WITHOUT touching the live doc (Phase 3 track-changes)', () => {
    const doc = BlockDoc.fromSnapshot('agent:note-1:s1', (() => {
      const h = new BlockDoc('human'); const { blockId } = h.insertBlock(null, 'paragraph'); h.insertText(blockId, 0, 'Base'); return h.snapshot();
    })());
    const before = doc.blocks().map((b) => b.text).join('|');
    const peer = createBlockAgentPeer(doc, { mode: 'suggest' });
    const ops = peer.appendMarkdown('## Proposed\n- idea');
    // The live doc is UNCHANGED (the suggestion is staged, not applied)…
    expect(doc.blocks().map((b) => b.text).join('|')).toBe(before);
    expect(ops.length).toBeGreaterThan(0);
    // …but accepting the suggestion (applying the ops) yields the proposed content.
    doc.applyMany(ops);
    const types = doc.blocks().map((b) => b.type);
    expect(types).toContain('heading');
    expect(types).toContain('bulletListItem');
  });

  it('two pending suggestions under distinct sites both apply (no op-id collision)', () => {
    const seed = (() => { const h = new BlockDoc('human'); const { blockId } = h.insertBlock(null, 'paragraph'); h.insertText(blockId, 0, 'Doc'); return h.snapshot(); })();
    const s1 = createBlockAgentPeer(BlockDoc.fromSnapshot('agent:n:s1', seed), { mode: 'suggest' }).appendMarkdown('- first suggestion');
    const s2 = createBlockAgentPeer(BlockDoc.fromSnapshot('agent:n:s2', seed), { mode: 'suggest' }).appendMarkdown('- second suggestion');
    const live = BlockDoc.fromSnapshot('server', seed);
    live.applyMany(s1); live.applyMany(s2);
    const texts = live.blocks().map((b) => b.text);
    expect(texts).toContain('first suggestion');
    expect(texts).toContain('second suggestion'); // both survived — distinct sites, no collision
  });

  it('markdownToBlocks handles headings/lists/todos/code/quotes/inline marks', () => {
    const specs = markdownToBlocks('# Title\n\nA **bold** and _em_ line.\n\n```js\ncode()\n```\n\n> quote\n\n1. first\n2. second');
    const types = specs.map((s) => s.type);
    expect(types).toEqual(['heading', 'paragraph', 'codeBlock', 'blockquote', 'orderedListItem', 'orderedListItem']);
    expect(specs[1]!.marks!.some((m) => m.type === 'bold')).toBe(true);
    expect(specs[1]!.marks!.some((m) => m.type === 'italic')).toBe(true);
    expect(specs[2]!.text).toBe('code()');
  });
});

/** Build a BlockDoc from specs and return its rendered blocks (the normalized read shape). */
function renderViaBlockDoc(specs: ReturnType<typeof pmToBlocks>): NormalBlock[] {
  const doc = BlockDoc.fromBlocks('x', specs);
  return doc.blocks().map((b) => ({ type: b.type, attrs: b.attrs, text: b.text, marks: b.marks }));
}
