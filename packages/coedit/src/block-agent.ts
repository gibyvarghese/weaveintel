// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — the AI agent as a BLOCK co-editor (weaveNotes Phase 1).
 *
 * Models emit Markdown natively, so the agent contributes to a note by producing
 * Markdown which we parse into structured block ops and merge into the shared
 * {@link BlockDoc} — exactly like a human typing, so it converges with concurrent
 * human edits (the Phase 7 "agent as a CRDT peer" pattern, lifted to blocks).
 *
 * --- For someone new to this ---
 * When the AI writes "## Findings\n- point one", that becomes "add a heading block,
 * then add a bullet block" — the same kind of edits a person makes — so the AI and
 * a human can build the same note at once without clobbering each other.
 */
import { BlockDoc, type BlockOp, type BlockSpec, type BlockType, type RgaId } from './block-doc.js';

/** Parse a common-subset Markdown string into block specs (headings, lists, to-dos, code, quotes, paragraphs). */
export function markdownToBlocks(md: string): BlockSpec[] {
  const specs: BlockSpec[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? ''; const body: string[] = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) { body.push(lines[i]!); i++; }
      i++; // closing fence
      specs.push({ type: 'codeBlock', attrs: lang ? { language: lang } : {}, text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { const { text, marks } = inlineMd(heading[2]!); specs.push({ type: 'heading', attrs: { level: heading[1]!.length }, text, marks }); i++; continue; }
    const todo = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo) { const { text, marks } = inlineMd(todo[2]!); specs.push({ type: 'taskItem', attrs: { checked: todo[1]!.toLowerCase() === 'x' }, text, marks }); i++; continue; }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) { const { text, marks } = inlineMd(bullet[1]!); specs.push({ type: 'bulletListItem', attrs: {}, text, marks }); i++; continue; }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) { const { text, marks } = inlineMd(ordered[1]!); specs.push({ type: 'orderedListItem', attrs: {}, text, marks }); i++; continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { const { text, marks } = inlineMd(quote[1]!); specs.push({ type: 'blockquote', attrs: {}, text, marks }); i++; continue; }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { specs.push({ type: 'divider', attrs: {} }); i++; continue; }
    if (line.trim() === '') { i++; continue; } // blank line → block separator
    const { text, marks } = inlineMd(line);
    specs.push({ type: 'paragraph', attrs: {}, text, marks });
    i++;
  }
  return specs;
}

/** Parse inline `**bold**` / `_italic_` / `` `code` `` / `[text](href)` into text + mark ranges. */
function inlineMd(s: string): { text: string; marks: NonNullable<BlockSpec['marks']> } {
  const marks: NonNullable<BlockSpec['marks']> = [];
  let text = '';
  let i = 0;
  while (i < s.length) {
    // Link [text](href)
    const link = /^\[([^\]]*)\]\(([^)]*)\)/.exec(s.slice(i));
    if (link) { const start = text.length; text += link[1]!; marks.push({ from: start, to: text.length, type: 'link', value: link[2]! }); i += link[0].length; continue; }
    for (const [token, type] of [['**', 'bold'], ['__', 'bold'], ['~~', 'strike'], ['*', 'italic'], ['_', 'italic'], ['`', 'code']] as const) {
      if (s.startsWith(token, i)) {
        const end = s.indexOf(token, i + token.length);
        if (end !== -1) { const start = text.length; text += s.slice(i + token.length, end); marks.push({ from: start, to: text.length, type }); i = end + token.length; }
        else { text += s[i]; i++; }
        // eslint-disable-next-line no-labels
        break;
      }
    }
    // If no token matched above, advance one char (the for-loop `break` handled matches).
    if (!['**', '__', '~~', '*', '_', '`'].some((t) => s.startsWith(t, i)) && !/^\[([^\]]*)\]\(([^)]*)\)/.test(s.slice(i))) { text += s[i]; i++; }
  }
  return { text, marks };
}

/** Append a list of block specs to the END of a {@link BlockDoc}; returns the ops to broadcast. */
export function appendBlocksToDoc(doc: BlockDoc, specs: BlockSpec[]): BlockOp[] {
  const ops: BlockOp[] = [];
  const existing = doc.blocks();
  let after: RgaId | null = existing.length ? existing[existing.length - 1]!.id : null;
  for (const spec of specs) {
    const { ops: blockOps, blockId } = doc.insertBlock(after, spec.type as BlockType, spec.attrs ?? {});
    ops.push(...blockOps);
    if (spec.text) ops.push(...doc.insertText(blockId, 0, spec.text));
    for (const m of spec.marks ?? []) { const mo = doc.addMark(blockId, m.from, m.to, m.type, m.value); if (mo) ops.push(mo); }
    after = blockId;
  }
  return ops;
}

export interface BlockAgentPeer {
  readonly doc: BlockDoc;
  /** Append the agent's Markdown output as structured blocks; returns the ops. */
  appendMarkdown(markdown: string): BlockOp[];
  /** Append pre-built block specs; returns the ops. */
  appendBlocks(specs: BlockSpec[]): BlockOp[];
}

/** Wrap a {@link BlockDoc} (whose siteId should be the agent's) as a block co-editor. */
export function createBlockAgentPeer(doc: BlockDoc): BlockAgentPeer {
  return {
    doc,
    appendMarkdown: (markdown) => appendBlocksToDoc(doc, markdownToBlocks(markdown)),
    appendBlocks: (specs) => appendBlocksToDoc(doc, specs),
  };
}
