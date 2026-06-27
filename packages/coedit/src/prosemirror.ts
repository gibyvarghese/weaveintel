// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — ProseMirror ⇄ BlockDoc conversion + schema repair (weaveNotes Phase 1).
 *
 * Notes are stored as Tiptap/ProseMirror JSON (a TREE). The {@link BlockDoc} CRDT
 * works on a FLAT list of blocks. These pure functions translate between the two:
 *   - {@link pmToBlocks} flattens a ProseMirror doc into block specs (lists become
 *     a run of list-item blocks; inline `marks` become offset ranges);
 *   - {@link blocksToProseMirror} rebuilds a VALID ProseMirror doc (grouping
 *     consecutive list-item blocks back into their list wrapper, merging adjacent
 *     identical marks, and running {@link normalizeBlocks} so a doc produced by a
 *     concurrent CRDT merge is always schema-valid — clamp heading levels, drop
 *     empty leading text, guarantee at least one block).
 *
 * Unknown block/mark types are passed through verbatim (Automerge's pattern) so a
 * future schema never silently drops content. Pure + zero-dependency.
 */
import type { BlockSpec, BlockType, MarkType, RenderedBlock } from './block-doc.js';

// ─── ProseMirror → blocks ────────────────────────────────────────────────────────

const PM_MARK_NAMES: Record<string, MarkType> = { bold: 'bold', strong: 'bold', italic: 'italic', em: 'italic', code: 'code', strike: 'strike', s: 'strike', underline: 'underline', link: 'link', highlight: 'highlight', textColor: 'textColor' };

interface PMNode { type?: string; attrs?: Record<string, unknown>; content?: PMNode[]; text?: string; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> }

/** The `attrs` field a mark's `value` is read from / written to (Phase 1: colour marks carry their colour). */
function markValueOf(type: MarkType, attrs: Record<string, unknown> | undefined): string | undefined {
  if (type === 'link') return typeof attrs?.['href'] === 'string' ? (attrs['href'] as string) : undefined;
  if (type === 'highlight' || type === 'textColor') return typeof attrs?.['color'] === 'string' ? (attrs['color'] as string) : undefined;
  return undefined;
}

/** Extract the plain text + mark ranges of a node's inline content. */
function inlineOf(node: PMNode): { text: string; marks: NonNullable<BlockSpec['marks']> } {
  let text = '';
  const marks: NonNullable<BlockSpec['marks']> = [];
  for (const child of node.content ?? []) {
    if (child.type !== 'text' || typeof child.text !== 'string') continue;
    const start = text.length;
    text += child.text;
    for (const mk of child.marks ?? []) {
      const type = PM_MARK_NAMES[mk.type];
      if (!type) continue;
      const value = markValueOf(type, mk.attrs);
      marks.push({ from: start, to: text.length, type, ...(value !== undefined ? { value } : {}) });
    }
  }
  return { text, marks };
}

/** The first paragraph-ish text of a list item (`listItem`/`taskItem` wraps a paragraph). */
function listItemInline(item: PMNode): { text: string; marks: NonNullable<BlockSpec['marks']> } {
  const para = (item.content ?? []).find((c) => c.type === 'paragraph');
  return para ? inlineOf(para) : { text: '', marks: [] };
}

/**
 * The combined inline text + marks of a WRAPPER block (callout / toggle body) whose
 * children are paragraphs. The flat block model holds one text per block, so a
 * multi-paragraph callout collapses to a single newline-joined block — fine for the
 * short callouts/toggles weaveNotes Phase 1 produces, and it never drops content.
 */
function wrapperInline(node: PMNode): { text: string; marks: NonNullable<BlockSpec['marks']> } {
  let text = '';
  const marks: NonNullable<BlockSpec['marks']> = [];
  for (const child of node.content ?? []) {
    if (text.length > 0) text += '\n';
    const part = inlineOf(child);
    const offset = text.length;
    text += part.text;
    for (const m of part.marks) marks.push({ ...m, from: m.from + offset, to: m.to + offset });
  }
  return { text, marks };
}

/** Keep only a whitelisted, string/boolean set of attrs (bounded + clean for the CRDT). */
function pickAttrs(attrs: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = attrs?.[k];
    if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') out[k] = v;
  }
  return out;
}

/** Flatten a ProseMirror doc JSON into an ordered list of {@link BlockSpec}s. */
export function pmToBlocks(pm: unknown): BlockSpec[] {
  const doc = pm as PMNode;
  const out: BlockSpec[] = [];
  for (const node of doc?.content ?? []) {
    switch (node.type) {
      case 'heading': {
        const { text, marks } = inlineOf(node);
        const level = Math.min(6, Math.max(1, Number(node.attrs?.['level'] ?? 1)));
        out.push({ type: 'heading', attrs: { level }, text, marks });
        break;
      }
      case 'paragraph': { const { text, marks } = inlineOf(node); out.push({ type: 'paragraph', attrs: {}, text, marks }); break; }
      case 'codeBlock': case 'code_block': {
        const { text } = inlineOf(node);
        out.push({ type: 'codeBlock', attrs: { ...(node.attrs?.['language'] ? { language: node.attrs['language'] } : {}) }, text });
        break;
      }
      case 'bulletList': case 'bullet_list':
        for (const item of node.content ?? []) { const { text, marks } = listItemInline(item); out.push({ type: 'bulletListItem', attrs: {}, text, marks }); }
        break;
      case 'orderedList': case 'ordered_list':
        for (const item of node.content ?? []) { const { text, marks } = listItemInline(item); out.push({ type: 'orderedListItem', attrs: {}, text, marks }); }
        break;
      case 'taskList': case 'task_list':
        for (const item of node.content ?? []) { const { text, marks } = listItemInline(item); out.push({ type: 'taskItem', attrs: { checked: item.attrs?.['checked'] === true }, text, marks }); }
        break;
      case 'blockquote':
        for (const child of node.content ?? []) { const { text, marks } = inlineOf(child); out.push({ type: 'blockquote', attrs: {}, text, marks }); }
        break;
      case 'horizontalRule': case 'horizontal_rule': out.push({ type: 'divider', attrs: {} }); break;
      // ── Phase 1 creative blocks ──────────────────────────────────────────────
      case 'callout': { const { text, marks } = wrapperInline(node); out.push({ type: 'callout', attrs: pickAttrs(node.attrs, ['tone', 'author']), text, marks }); break; }
      case 'toggle': { const { text, marks } = wrapperInline(node); out.push({ type: 'toggle', attrs: pickAttrs(node.attrs, ['summary', 'open', 'author']), text, marks }); break; }
      case 'image': out.push({ type: 'image', attrs: pickAttrs(node.attrs, ['src', 'alt', 'author']) }); break;
      case 'sticker': out.push({ type: 'sticker', attrs: pickAttrs(node.attrs, ['emoji', 'author']) }); break;
      case 'washiDivider': out.push({ type: 'washiDivider', attrs: pickAttrs(node.attrs, ['pattern']) }); break;
      default:
        // Unknown block → pass through as a paragraph holding its text (never drop content).
        { const { text, marks } = inlineOf(node); if (text) out.push({ type: 'paragraph', attrs: { unknownType: node.type }, text, marks }); }
        break;
    }
  }
  return out;
}

// ─── blocks → ProseMirror ────────────────────────────────────────────────────────

/** A normalized block ready for serialization (the {@link RenderedBlock} read shape). */
export type NormalBlock = Pick<RenderedBlock, 'type' | 'attrs' | 'text' | 'marks'>;

/**
 * Deterministic schema repair: guarantees a valid ProseMirror-able block list after
 * any concurrent merge. Clamps heading levels, coerces malformed types to
 * paragraph, and ensures the document has at least one block.
 */
export function normalizeBlocks(blocks: NormalBlock[]): NormalBlock[] {
  const out: NormalBlock[] = [];
  for (const b of blocks) {
    const type = b.type;
    if (type === 'heading') {
      const level = Math.min(6, Math.max(1, Number(b.attrs['level'] ?? 1)));
      out.push({ ...b, attrs: { ...b.attrs, level } });
    } else if (type === 'divider') {
      out.push({ type: 'divider', attrs: {}, text: '', marks: [] }); // dividers never carry text/marks
    } else if (type === 'image' || type === 'sticker' || type === 'washiDivider') {
      out.push({ ...b, text: '', marks: [] }); // attribute-only atoms never carry text/marks
    } else {
      out.push(b);
    }
  }
  if (out.length === 0) out.push({ type: 'paragraph', attrs: {}, text: '', marks: [] });
  return out;
}

/** Merge adjacent same-type (and same-value) marks so round-trips are stable. */
function mergeMarks(marks: NormalBlock['marks']): NormalBlock['marks'] {
  const sorted = [...marks].sort((a, b) => a.from - b.from || a.to - b.to || a.type.localeCompare(b.type));
  const out: NormalBlock['marks'] = [];
  for (const m of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.type === m.type && prev.value === m.value && m.from <= prev.to) { prev.to = Math.max(prev.to, m.to); }
    else out.push({ ...m });
  }
  return out;
}

/** Build a ProseMirror text-node array (text split at mark boundaries) for one block. */
function inlineNodes(text: string, marks: NormalBlock['marks']): PMNode[] {
  if (text.length === 0) return [];
  const merged = mergeMarks(marks);
  // Boundaries where the active mark-set changes.
  const boundaries = new Set<number>([0, text.length]);
  for (const m of merged) { boundaries.add(Math.max(0, m.from)); boundaries.add(Math.min(text.length, m.to)); }
  const points = [...boundaries].sort((a, b) => a - b);
  const nodes: PMNode[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!; const to = points[i + 1]!;
    if (to <= from) continue;
    const active = merged.filter((m) => m.from <= from && m.to >= to);
    const node: PMNode = { type: 'text', text: text.slice(from, to) };
    if (active.length) node.marks = active.map((m) => {
      if (m.type === 'link') return { type: 'link', attrs: { href: m.value ?? '' } };
      if (m.type === 'highlight') return { type: 'highlight', ...(m.value ? { attrs: { color: m.value } } : {}) };
      if (m.type === 'textColor') return { type: 'textColor', attrs: { color: m.value ?? '' } };
      return { type: m.type };
    });
    nodes.push(node);
  }
  return nodes;
}

const LIST_ITEM: Partial<Record<BlockType, { list: string; item: string; itemAttrs?: (b: NormalBlock) => Record<string, unknown> }>> = {
  bulletListItem: { list: 'bulletList', item: 'listItem' },
  orderedListItem: { list: 'orderedList', item: 'listItem' },
  taskItem: { list: 'taskList', item: 'taskItem', itemAttrs: (b) => ({ checked: b.attrs['checked'] === true }) },
};

/** Rebuild a VALID ProseMirror doc JSON from a block list (groups list runs, normalizes). */
export function blocksToProseMirror(blocks: NormalBlock[]): { type: 'doc'; content: PMNode[] } {
  const norm = normalizeBlocks(blocks);
  const content: PMNode[] = [];
  let i = 0;
  while (i < norm.length) {
    const b = norm[i]!;
    const listSpec = LIST_ITEM[b.type];
    if (listSpec) {
      // Group the contiguous run of the same list-item type.
      const items: PMNode[] = [];
      while (i < norm.length && norm[i]!.type === b.type) {
        const item = norm[i]!;
        const para: PMNode = { type: 'paragraph', content: inlineNodes(item.text, item.marks) };
        items.push({ type: listSpec.item, ...(listSpec.itemAttrs ? { attrs: listSpec.itemAttrs(item) } : {}), content: [para] });
        i++;
      }
      content.push({ type: listSpec.list, content: items });
      continue;
    }
    if (b.type === 'blockquote') {
      content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inlineNodes(b.text, b.marks) }] });
    } else if (b.type === 'callout') {
      content.push({ type: 'callout', attrs: pickAttrs(b.attrs, ['tone', 'author']), content: [{ type: 'paragraph', content: inlineNodes(b.text, b.marks) }] });
    } else if (b.type === 'toggle') {
      content.push({ type: 'toggle', attrs: pickAttrs(b.attrs, ['summary', 'open', 'author']), content: [{ type: 'paragraph', content: inlineNodes(b.text, b.marks) }] });
    } else if (b.type === 'image') {
      content.push({ type: 'image', attrs: pickAttrs(b.attrs, ['src', 'alt', 'author']) });
    } else if (b.type === 'sticker') {
      content.push({ type: 'sticker', attrs: pickAttrs(b.attrs, ['emoji', 'author']) });
    } else if (b.type === 'washiDivider') {
      content.push({ type: 'washiDivider', attrs: pickAttrs(b.attrs, ['pattern']) });
    } else if (b.type === 'divider') {
      content.push({ type: 'horizontalRule' });
    } else if (b.type === 'codeBlock') {
      content.push({ type: 'codeBlock', ...(b.attrs['language'] ? { attrs: { language: b.attrs['language'] } } : {}), content: b.text ? [{ type: 'text', text: b.text }] : [] });
    } else if (b.type === 'heading') {
      content.push({ type: 'heading', attrs: { level: b.attrs['level'] ?? 1 }, content: inlineNodes(b.text, b.marks) });
    } else {
      content.push({ type: 'paragraph', content: inlineNodes(b.text, b.marks) });
    }
    i++;
  }
  if (content.length === 0) content.push({ type: 'paragraph', content: [] });
  return { type: 'doc', content };
}
