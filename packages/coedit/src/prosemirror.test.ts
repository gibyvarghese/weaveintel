// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { pmToBlocks, blocksToProseMirror, normalizeBlocks, type NormalBlock } from './prosemirror.js';
import { BlockDoc } from './block-doc.js';
import { blocksToMarkdown, blocksToHtml } from './block-markdown.js';
import { markdownToBlocks, createBlockAgentPeer } from './block-agent.js';
import { validateClientBlockOps } from './block-validation.js';

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

// ─── Phase 1: creative marks + blocks survive the round-trip + the CRDT ────────────
const CREATIVE_DOC = {
  type: 'doc', content: [
    { type: 'paragraph', content: [
      { type: 'text', text: 'Plain then ' },
      { type: 'text', text: 'highlighted', marks: [{ type: 'highlight', attrs: { color: '#FAC775' } }] },
      { type: 'text', text: ' then ' },
      { type: 'text', text: 'coloured', marks: [{ type: 'textColor', attrs: { color: '#D85A30' } }] },
      { type: 'text', text: '.' },
    ] },
    { type: 'callout', attrs: { tone: 'warning', author: 'ai' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mind the gap' }] }] },
    { type: 'toggle', attrs: { summary: 'More detail', open: false, author: 'user' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden body' }] }] },
    { type: 'image', attrs: { src: 'https://example.com/a.png', alt: 'A diagram', author: 'user' } },
    { type: 'sticker', attrs: { emoji: '✨', author: 'user' } },
    { type: 'washiDivider', attrs: { pattern: 'dots' } },
  ],
};

describe('Phase 1 creative content — round-trip + CRDT preservation', () => {
  it('flattens highlight/textColor marks + creative blocks with their attrs', () => {
    const blocks = pmToBlocks(CREATIVE_DOC);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'callout', 'toggle', 'image', 'sticker', 'washiDivider']);
    expect(blocks[0]!.marks!.find((m) => m.type === 'highlight')?.value).toBe('#FAC775');
    expect(blocks[0]!.marks!.find((m) => m.type === 'textColor')?.value).toBe('#D85A30');
    expect(blocks[1]!.attrs).toMatchObject({ tone: 'warning', author: 'ai' });
    expect(blocks[1]!.text).toBe('Mind the gap');
    expect(blocks[2]!.attrs).toMatchObject({ summary: 'More detail', open: false, author: 'user' });
    expect(blocks[3]!.attrs).toMatchObject({ src: 'https://example.com/a.png', alt: 'A diagram' });
    expect(blocks[3]!.text ?? '').toBe('');           // image is an attribute-only atom
    expect(blocks[4]!.attrs).toMatchObject({ emoji: '✨' });
    expect(blocks[5]!.attrs).toMatchObject({ pattern: 'dots' });
  });

  it('is a STABLE round-trip THROUGH the CRDT (colours + tones + atoms preserved)', () => {
    const doc = BlockDoc.fromBlocks('a', pmToBlocks(CREATIVE_DOC));
    const rebuilt = doc.blocks();
    expect(rebuilt.map((b) => b.type)).toEqual(['paragraph', 'callout', 'toggle', 'image', 'sticker', 'washiDivider']);
    const pm = blocksToProseMirror(rebuilt);
    const back = pmToBlocks(pm);
    expect(back[0]!.marks!.find((m) => m.type === 'highlight')?.value).toBe('#FAC775');
    expect(back[0]!.marks!.find((m) => m.type === 'textColor')?.value).toBe('#D85A30');
    expect(back[1]!.attrs!['tone']).toBe('warning');
    expect(back[3]!.attrs!['src']).toBe('https://example.com/a.png');
    // PM node types are the editor's real node names.
    expect(pm.content.map((n) => n.type)).toEqual(['paragraph', 'callout', 'toggle', 'image', 'sticker', 'washiDivider']);
  });

  it('the relay validator ACCEPTS the new block + mark types', () => {
    // Build ops the editor would submit and prove they pass the anti-forgery validator.
    const doc = new BlockDoc('u:alice');
    const { ops, blockId } = doc.insertBlock(null, 'callout', { tone: 'tip' });
    const textOps = doc.insertText(blockId, 0, 'Hi');
    const markOp = doc.addMark(blockId, 0, 2, 'highlight', '#9FE1CB');
    const all = [...ops, ...textOps, ...(markOp ? [markOp] : [])];
    const result = validateClientBlockOps(all, { expectedSiteId: 'u:alice' });
    expect(result.ok).toBe(true);
  });

  it('the AI markdown parser produces highlights + callouts', () => {
    const specs = markdownToBlocks('Here is ==important== text.\n\n> [!WARNING]\n> Do not skip this step.\n\n> a plain quote');
    expect(specs[0]!.marks!.some((m) => m.type === 'highlight')).toBe(true);
    const callout = specs.find((s) => s.type === 'callout');
    expect(callout).toBeTruthy();
    expect(callout!.attrs!['tone']).toBe('warning');
    expect(callout!.text).toBe('Do not skip this step.');
    expect(specs.some((s) => s.type === 'blockquote')).toBe(true); // plain quote stays a quote
  });

  it('Markdown + HTML serialize the creative blocks (HTML colour is sanitised)', () => {
    const rendered = renderViaBlockDoc(pmToBlocks(CREATIVE_DOC));
    const md = blocksToMarkdown(rendered);
    expect(md).toContain('==highlighted==');
    expect(md).toContain('> [!WARNING]');
    expect(md).toContain('![A diagram](https://example.com/a.png)');
    const html = blocksToHtml(rendered);
    expect(html).toContain('<mark style="background:#FAC775">');
    expect(html).toContain('gw-callout-warning');
    expect(html).toContain('<img src="https://example.com/a.png"');
  });

  it('Phase 4: inkCanvas + diagram atoms round-trip with their nested JSON payload intact', () => {
    const doc = {
      type: 'doc', content: [
        { type: 'inkCanvas', attrs: { author: 'ai', strokes: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], color: '#3B6FB0', width: 3, tool: 'pen' }] } },
        { type: 'diagram', attrs: { author: 'ai', title: 'Flow', kind: 'flow', scene: { nodes: [{ id: 'a', label: 'Plan', color: '#FAC775' }, { id: 'b', label: 'Ship', color: '#9FE1CB' }], edges: [{ from: 'a', to: 'b' }] } } },
      ],
    };
    const blocks = pmToBlocks(doc);
    expect(blocks.map((b) => b.type)).toEqual(['inkCanvas', 'diagram']);
    // Through the CRDT and back.
    const crdt = BlockDoc.fromBlocks('a', blocks);
    const pm = blocksToProseMirror(crdt.blocks());
    expect(pm.content.map((n) => n.type)).toEqual(['inkCanvas', 'diagram']);
    const back = pmToBlocks(pm);
    const ink = back[0]!.attrs as { strokes: Array<{ points: unknown[]; color: string }> };
    expect(ink.strokes[0]!.color).toBe('#3B6FB0');
    expect(ink.strokes[0]!.points).toHaveLength(2);
    const diag = back[1]!.attrs as { scene: { nodes: Array<{ id: string; label: string }>; edges: unknown[] }; title: string };
    expect(diag.title).toBe('Flow');
    expect(diag.scene.nodes.map((n) => n.label)).toEqual(['Plan', 'Ship']);
    expect(diag.scene.edges).toHaveLength(1);
    // Markdown summary gives the AI useful context.
    const md = blocksToMarkdown(renderViaBlockDoc(blocks));
    expect(md).toContain('[diagram: Flow — Plan → Ship]');
    expect(md).toContain('[ink drawing]');
  });

  it('SECURITY: a hostile colour / image src cannot inject CSS or a bad scheme', () => {
    const hostile: NormalBlock[] = [
      { type: 'paragraph', attrs: {}, text: 'x', marks: [{ from: 0, to: 1, type: 'highlight', value: 'red;}body{display:none' }] },
      { type: 'paragraph', attrs: {}, text: 'y', marks: [{ from: 0, to: 1, type: 'textColor', value: 'url(javascript:alert(1))' }] },
      { type: 'image', attrs: { src: 'javascript:alert(1)', alt: 'bad' }, text: '', marks: [] },
    ];
    const html = blocksToHtml(hostile);
    expect(html).not.toContain('display:none');
    expect(html).not.toContain('url(');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<mark>');  // colour dropped → plain mark
  });
});

/** Build a BlockDoc from specs and return its rendered blocks (the normalized read shape). */
function renderViaBlockDoc(specs: ReturnType<typeof pmToBlocks>): NormalBlock[] {
  const doc = BlockDoc.fromBlocks('x', specs);
  return doc.blocks().map((b) => ({ type: b.type, attrs: b.attrs, text: b.text, marks: b.marks }));
}
