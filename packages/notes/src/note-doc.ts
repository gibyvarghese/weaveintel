// SPDX-License-Identifier: MIT
/**
 * note-doc.ts — the SHARED, cross-platform note-document model.
 *
 * A note is stored as a ProseMirror document (`doc_json`). The web editor (TipTap) is the rich
 * authoring surface; the MOBILE editor is a lighter surface that still has to read and write the
 * SAME document so a note round-trips between platforms losslessly. This module is the one place
 * both platforms agree on that mapping:
 *
 *   • {@link NoteBlock} — a small, flat block model the mobile editor works in (paragraph, heading,
 *     bullet list, to-do list, and the Phase-4 `inkCanvas` freehand drawing).
 *   • {@link blocksToDoc} / {@link docToBlocks} — convert between that block model and `doc_json`.
 *   • {@link inkCanvasNode} — build the exact `inkCanvas` node the web renders (so ink drawn on a
 *     phone shows up untouched on the web — the Phase 7 "Done when").
 *
 * The critical invariant: **mobile never destroys web-only content.** A web note may contain nodes
 * the mobile editor cannot render (diagrams, images, callouts, toggles). `docToBlocks` preserves
 * each of those verbatim as an {@link UnsupportedBlock}, and `blocksToDoc` writes them back exactly,
 * so editing a note on a phone and syncing it never silently drops the diagram a teammate drew on
 * the web. Pure + dependency-light → fully unit-testable in Node.
 */
/** A ProseMirror node — the shape a rich-text editor (and note templates) use for content. */
export interface PMNode { type: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }
/** A ProseMirror document (a `doc` node with block content). */
export interface PMDoc { type: 'doc'; content: PMNode[] }
import { validateStrokes, type InkStroke } from './ink.js';

/** A paragraph of plain text (the mobile editor's default block). */
export interface ParagraphBlock { type: 'paragraph'; text: string }
/** A heading (level 1–3). */
export interface HeadingBlock { type: 'heading'; level: 1 | 2 | 3; text: string }
/** A bullet list — one string per item. */
export interface BulletBlock { type: 'bullet'; items: string[] }
/** A to-do checklist — these feed tasks via the extract pipeline. */
export interface TodoBlock { type: 'todo'; items: Array<{ text: string; checked: boolean }> }
/** A freehand ink drawing (Phase 4 model) — the headline of the mobile editor. */
export interface InkBlock { type: 'inkCanvas'; strokes: InkStroke[]; author: 'user' | 'ai' }
/**
 * Any node the mobile editor does NOT natively edit (diagram, image, callout, toggle, code, …),
 * preserved VERBATIM so a mobile round-trip never loses web-authored content.
 */
export interface UnsupportedBlock { type: 'unsupported'; nodeType: string; raw: PMNode }

export type NoteBlock = ParagraphBlock | HeadingBlock | BulletBlock | TodoBlock | InkBlock | UnsupportedBlock;

/** Block types the mobile editor can render + edit natively (everything else round-trips as `unsupported`). */
export const MOBILE_EDITABLE_BLOCKS: ReadonlySet<string> = new Set([
  'paragraph', 'heading', 'bullet', 'todo', 'inkCanvas',
]);

const EMPTY_DOC: PMDoc = { type: 'doc', content: [] };

// ── Building doc_json from blocks ───────────────────────────────────────────────

/** The text content of a paragraph/heading as a single ProseMirror text node (or empty). */
function textContent(text: string): PMNode[] {
  return text.length > 0 ? [{ type: 'text', text }] : [];
}

/**
 * Build the canonical `inkCanvas` node the web editor renders. Strokes are run through the package's
 * strict {@link validateStrokes} gate first, so an ink block is always safe + well-formed.
 */
export function inkCanvasNode(strokes: unknown, author: 'user' | 'ai' = 'user'): PMNode {
  return { type: 'inkCanvas', attrs: { author, strokes: validateStrokes(strokes) } };
}

/** Convert one mobile block to its ProseMirror node. */
function blockToNode(block: NoteBlock): PMNode {
  switch (block.type) {
    case 'paragraph':
      return { type: 'paragraph', content: textContent(block.text) };
    case 'heading':
      return { type: 'heading', attrs: { level: block.level }, content: textContent(block.text) };
    case 'bullet':
      return { type: 'bulletList', content: block.items.map((i) => ({ type: 'listItem', content: [{ type: 'paragraph', content: textContent(i) }] })) };
    case 'todo':
      return { type: 'taskList', content: block.items.map((i) => ({ type: 'taskItem', attrs: { checked: i.checked }, content: [{ type: 'paragraph', content: textContent(i.text) }] })) };
    case 'inkCanvas':
      return inkCanvasNode(block.strokes, block.author);
    case 'unsupported':
      return block.raw;
  }
}

/** Serialise a mobile block list to a `doc_json` string the server + web understand. */
export function blocksToDoc(blocks: NoteBlock[]): string {
  const doc: PMDoc = { type: 'doc', content: blocks.map(blockToNode) };
  return JSON.stringify(doc);
}

// ── Parsing doc_json into blocks ────────────────────────────────────────────────

/** Collapse a node's inline content to plain text (ignores marks; good enough for the mobile editor). */
function inlineText(node: PMNode | undefined): string {
  if (!node?.content) return node?.text ?? '';
  return node.content.map((c) => (c.text ?? inlineText(c))).join('');
}

function nodeToBlock(node: PMNode): NoteBlock {
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', text: inlineText(node) };
    case 'heading': {
      const lvl = Number(node.attrs?.['level']);
      const level = (lvl === 2 ? 2 : lvl === 3 ? 3 : 1) as 1 | 2 | 3;
      return { type: 'heading', level, text: inlineText(node) };
    }
    case 'bulletList':
      return { type: 'bullet', items: (node.content ?? []).map((li) => inlineText(li.content?.[0]).trim()) };
    case 'taskList':
      return {
        type: 'todo',
        items: (node.content ?? []).map((ti) => ({ text: inlineText(ti.content?.[0]).trim(), checked: ti.attrs?.['checked'] === true })),
      };
    case 'inkCanvas':
      return { type: 'inkCanvas', strokes: validateStrokes(node.attrs?.['strokes']), author: node.attrs?.['author'] === 'ai' ? 'ai' : 'user' };
    default:
      // Anything else (diagram, image, callout, toggle, codeBlock, blockquote, …) is preserved verbatim.
      return { type: 'unsupported', nodeType: node.type, raw: node };
  }
}

/** Parse a `doc_json` (string or object) into the flat mobile block model. Tolerant of malformed input. */
export function docToBlocks(docJson: string | PMDoc | null | undefined): NoteBlock[] {
  if (!docJson) return [];
  let doc: PMDoc;
  try {
    doc = (typeof docJson === 'string' ? JSON.parse(docJson) : docJson) as PMDoc;
  } catch {
    return [];
  }
  if (!doc || doc.type !== 'doc' || !Array.isArray(doc.content)) return [];
  return doc.content.map(nodeToBlock);
}

/** Plain-text preview of a block list (for the note list + search). */
export function blocksPlainText(blocks: NoteBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading') parts.push(b.text);
    else if (b.type === 'bullet') parts.push(b.items.join(' '));
    else if (b.type === 'todo') parts.push(b.items.map((i) => i.text).join(' '));
    else if (b.type === 'inkCanvas') parts.push('[ink drawing]');
  }
  return parts.filter(Boolean).join('\n').trim();
}

/** Does this note contain any ink? (used to label "syncs with ink intact" + the list badge). */
export function hasInk(blocks: NoteBlock[]): boolean {
  return blocks.some((b) => b.type === 'inkCanvas' && b.strokes.length > 0);
}

/** An empty starter doc (the mobile "new note" content). */
export function emptyNoteDoc(): string {
  return JSON.stringify(EMPTY_DOC);
}
