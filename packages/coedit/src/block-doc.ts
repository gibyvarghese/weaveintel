// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — BlockDoc: a rich-text / block-document CRDT (weaveNotes Phase 1).
 *
 * Phase 7's {@link RgaDoc} co-edits PLAIN text. A "note" is a STRUCTURED document
 * (headings, paragraphs, bullet/numbered lists, to-dos, code, quotes) with inline
 * formatting (bold/italic/links). `BlockDoc` makes that whole structure
 * co-editable + convergent, reusing the exact Phase 7 RGA algorithm.
 *
 * --- For someone new to this ---
 * The clever trick (the Automerge approach): instead of a tree, keep ONE flat
 * sequence of tiny elements — each element is either a single CHARACTER or a
 * "block marker" that says "a new block (a heading / a list item / …) starts
 * here". So the document `# Hi` then `world` is the sequence:
 *     [marker(heading), 'H', 'i', marker(paragraph), 'w','o','r','l','d']
 * Because it is just ONE sequence, all the proven plain-text CRDT machinery works
 * unchanged: every element has a permanent id, edits say "insert after element X",
 * and concurrent edits always converge. Splitting a paragraph in two = inserting a
 * marker (a normal insert). Merging two blocks = deleting a marker. No locks, no
 * trees, no conflict resolution code.
 *
 * On top of the sequence sit two small last-write-wins layers:
 *   - block ATTRIBUTES (a block's `type` + `level`/`checked`/`listType`/`depth`)
 *     — keyed by the marker's id, highest (lamport, siteId) wins per key;
 *   - inline MARKS (bold/italic/code/link) — spans anchored to the character ids
 *     they cover (a "Peritext-lite" model), so a span survives concurrent edits
 *     and add/remove of the same mark commute.
 *
 * Convergence (Strong Eventual Consistency) is inherited from the RGA: ops are
 * commutative + idempotent (dedup by a unique per-op id) + causally buffered.
 * Zero-dependency + pure (browser- and server-safe).
 */
import { idGreater, idKey, type RgaId } from './rga.js';

export type { RgaId };

/**
 * A block's structural type. The StarterKit subset weaveNotes Phase 0 targets,
 * PLUS the Phase 1 creative blocks (callout / toggle / image / sticker / washi
 * divider). Listing them here means the CRDT round-trip PRESERVES them (a
 * concurrent merge never silently flattens a callout back to a paragraph); the
 * web/desktop editors build their schema from the same set.
 */
export type BlockType =
  | 'paragraph' | 'heading' | 'bulletListItem' | 'orderedListItem' | 'taskItem'
  | 'codeBlock' | 'blockquote' | 'divider'
  // Phase 1 creative blocks (text-bearing: callout/toggle; attribute-only atoms: image/sticker/washiDivider).
  | 'callout' | 'toggle' | 'image' | 'sticker' | 'washiDivider'
  // Phase 4 creative blocks (attribute-only atoms holding their scene/strokes JSON in attrs).
  | 'inkCanvas' | 'diagram';

/** A block's last-write-wins attribute bag (level, checked, listType, depth, language, …). */
export type BlockAttrs = Record<string, unknown>;

/**
 * Inline mark types we round-trip. Phase 0: Tiptap StarterKit + link/underline/strike.
 * Phase 1 adds the creative marks `highlight` (multi-colour highlighter) and `textColor`
 * (coloured text) — both carry their colour in the mark's `value`, so authorship colour
 * survives a concurrent merge intact.
 */
export type MarkType = 'bold' | 'italic' | 'code' | 'strike' | 'underline' | 'link' | 'highlight' | 'textColor';

/** A rendered block (the read model the UI / serializers consume). */
export interface RenderedBlock {
  /** The marker element's id (`null` for the implicit leading block). */
  id: RgaId | null;
  type: BlockType;
  attrs: BlockAttrs;
  text: string;
  /** Inline marks resolved to character offsets within `text`. */
  marks: Array<{ from: number; to: number; type: MarkType; value?: string }>;
}

// ─── Ops ────────────────────────────────────────────────────────────────────────

/** Every op carries a unique author-minted `opId` (drives dedup + state-vector sync). */
export type BlockOp =
  // Insert a sequence element (a char or a block marker) after `originId` (null = start).
  | { t: 'ins'; id: RgaId; originId: RgaId | null; kind: 'char'; char: string }
  | { t: 'ins'; id: RgaId; originId: RgaId | null; kind: 'block'; blockType: BlockType }
  // Tombstone an element (char or marker). `opId` is a fresh author id.
  | { t: 'del'; opId: RgaId; target: RgaId }
  // LWW set a block attribute (block = the marker id; `null` = the leading block).
  | { t: 'attr'; opId: RgaId; block: RgaId | null; key: string; value: unknown }
  // Add / remove an inline mark over the inclusive char range [startId, endId].
  | { t: 'mark'; opId: RgaId; startId: RgaId; endId: RgaId; markType: MarkType; markValue?: string; remove: boolean };

export function blockOpId(op: BlockOp): RgaId {
  return op.t === 'ins' ? op.id : op.opId;
}

export type StateVector = Record<string, number>;

export interface BlockDocSnapshot {
  elements: Array<{ id: RgaId; originId: RgaId | null; deleted: boolean; kind: 'char' | 'block'; char?: string; blockType?: BlockType }>;
  attrs: Array<{ block: RgaId | null; key: string; value: unknown; lamport: number; siteId: string }>;
  marks: Array<{ opId: RgaId; startId: RgaId; endId: RgaId; markType: MarkType; markValue?: string; removed: boolean }>;
}

// ─── Internal element + helpers ──────────────────────────────────────────────────

interface Elem {
  id: RgaId;
  originId: RgaId | null;
  deleted: boolean;
  kind: 'char' | 'block';
  char?: string;        // kind==='char'
  blockType?: BlockType; // kind==='block' (the type at creation; can be overridden by an LWW attr)
}

const LEADING = '__leading__'; // attr-map key for the implicit leading block (block === null)
function blockKey(id: RgaId | null): string { return id === null ? LEADING : idKey(id); }

/** True if `a` wins over `b` under last-write-wins (higher lamport, then higher siteId). */
function lwwWins(a: { lamport: number; siteId: string }, b: { lamport: number; siteId: string }): boolean {
  return a.lamport > b.lamport || (a.lamport === b.lamport && a.siteId > b.siteId);
}

/** A spec for building a fresh document (used by `pmToBlocks` / `fromBlocks`). */
export interface BlockSpec {
  type: BlockType;
  attrs?: BlockAttrs;
  text?: string;
  /** Inline marks as offset ranges within `text`. */
  marks?: Array<{ from: number; to: number; type: MarkType; value?: string }>;
}

// ─── BlockDoc ────────────────────────────────────────────────────────────────────

export class BlockDoc {
  readonly siteId: string;
  #counter = 0;
  #elems: Elem[] = [];
  #byId = new Map<string, number>();
  #buffer: Array<Extract<BlockOp, { t: 'ins' }>> = [];
  #delBuffer: Array<Extract<BlockOp, { t: 'del' }>> = [];
  #applied = new Set<string>();
  #seen: StateVector = {};
  #log: BlockOp[] = [];
  /** LWW attributes: blockKey → attrKey → {value, lamport, siteId}. */
  #attrs = new Map<string, Map<string, { value: unknown; lamport: number; siteId: string }>>();
  /** Marks keyed by opId, the latest add/remove winning per (start,end,type) by lamport. */
  #marks = new Map<string, { startId: RgaId; endId: RgaId; markType: MarkType; markValue?: string; removed: boolean; lamport: number }>();

  constructor(siteId: string) {
    if (!siteId) throw new Error('BlockDoc requires a non-empty siteId');
    this.siteId = siteId;
  }

  // ── Local edits (return ops to broadcast) ──────────────────────────────────

  #mintId(): RgaId { return { counter: this.#counter + 1, siteId: this.siteId }; }

  /** Insert a new block marker after `afterBlockId` (null = the very start). */
  insertBlock(afterBlockId: RgaId | null, type: BlockType, attrs: BlockAttrs = {}): { ops: BlockOp[]; blockId: RgaId } {
    // Anchor: the LAST element of the "after" block (so the new marker starts a new block right after it).
    const originId = afterBlockId === null ? this.#startAnchor() : this.#lastElementOfBlock(afterBlockId);
    const id = this.#mintId();
    const ops: BlockOp[] = [{ t: 'ins', id, originId, kind: 'block', blockType: type }];
    this.apply(ops[0]!);
    for (const [k, v] of Object.entries(attrs)) ops.push(this.setBlockAttr(id, k, v));
    return { ops, blockId: id };
  }

  /** Insert text at a visible char index WITHIN a block. */
  insertText(blockId: RgaId | null, index: number, text: string): BlockOp[] {
    const ops: BlockOp[] = [];
    let anchor = index <= 0 ? this.#blockMarkerOrStart(blockId) : this.#charIdAtBlockIndex(blockId, index);
    for (const ch of [...text]) {
      const id = this.#mintId();
      const op: BlockOp = { t: 'ins', id, originId: anchor, kind: 'char', char: ch };
      this.apply(op); ops.push(op);
      anchor = id;
    }
    return ops;
  }

  /** Delete `count` visible chars starting at `index` within a block. */
  deleteText(blockId: RgaId | null, index: number, count: number): BlockOp[] {
    const ops: BlockOp[] = [];
    for (let i = 0; i < count; i++) {
      const charId = this.#charIdAtBlockIndex(blockId, index + 1); // 1-based → the (index+1)-th char
      if (!charId) break;
      const op: BlockOp = { t: 'del', opId: this.#mintId(), target: charId };
      this.apply(op); ops.push(op);
    }
    return ops;
  }

  /** Split a block at a char index — inserts a new marker; the tail chars become a new block. */
  splitBlock(blockId: RgaId | null, index: number, newType: BlockType = 'paragraph'): { ops: BlockOp[]; newBlockId: RgaId } {
    // The new marker goes right BEFORE the char currently at `index` (so that char + the rest move into the new block).
    const anchor = index <= 0 ? this.#blockMarkerOrStart(blockId) : this.#charIdAtBlockIndex(blockId, index);
    const id = this.#mintId();
    const op: BlockOp = { t: 'ins', id, originId: anchor, kind: 'block', blockType: newType };
    this.apply(op);
    return { ops: [op], newBlockId: id };
  }

  /** Merge a block into the previous one (deletes its starting marker). */
  mergeBlock(blockId: RgaId): BlockOp[] {
    const op: BlockOp = { t: 'del', opId: this.#mintId(), target: blockId };
    this.apply(op);
    return [op];
  }

  /** Set a block attribute (LWW). `block === null` targets the leading block. */
  setBlockAttr(block: RgaId | null, key: string, value: unknown): BlockOp {
    const op: BlockOp = { t: 'attr', opId: this.#mintId(), block, key, value };
    this.apply(op);
    return op;
  }
  /** Set the block's structural type (stored as the LWW `type` attribute). */
  setBlockType(block: RgaId | null, type: BlockType): BlockOp { return this.setBlockAttr(block, 'type', type); }

  /** Add an inline mark over a char range (offsets within the block). */
  addMark(blockId: RgaId | null, from: number, to: number, markType: MarkType, markValue?: string): BlockOp | null {
    return this.#markOp(blockId, from, to, markType, markValue, false);
  }
  removeMark(blockId: RgaId | null, from: number, to: number, markType: MarkType): BlockOp | null {
    return this.#markOp(blockId, from, to, markType, undefined, true);
  }
  #markOp(blockId: RgaId | null, from: number, to: number, markType: MarkType, markValue: string | undefined, remove: boolean): BlockOp | null {
    const startId = this.#charIdAtBlockIndex(blockId, from + 1);
    const endId = this.#charIdAtBlockIndex(blockId, to);
    if (!startId || !endId) return null;
    const op: BlockOp = { t: 'mark', opId: this.#mintId(), startId, endId, markType, ...(markValue !== undefined ? { markValue } : {}), remove };
    this.apply(op);
    return op;
  }

  // ── Apply a remote (or local) op ───────────────────────────────────────────

  apply(op: BlockOp): boolean {
    if (this.#applied.has(idKey(blockOpId(op)))) return false; // idempotent
    switch (op.t) {
      case 'ins': {
        if (this.#byId.has(idKey(op.id))) { this.#applied.add(idKey(op.id)); return false; }
        if (op.originId !== null && !this.#byId.has(idKey(op.originId))) { this.#buffer.push(op); return false; }
        this.#integrate(op); this.#record(op); this.#drain();
        return true;
      }
      case 'del': {
        const idx = this.#byId.get(idKey(op.target));
        if (idx === undefined) { this.#delBuffer.push(op); return false; }
        this.#elems[idx]!.deleted = true; this.#record(op);
        return true;
      }
      case 'attr': {
        const bk = blockKey(op.block);
        const m = this.#attrs.get(bk) ?? new Map();
        const cur = m.get(op.key);
        const cand = { value: op.value, lamport: op.opId.counter, siteId: op.opId.siteId };
        if (!cur || lwwWins(cand, cur)) { m.set(op.key, cand); this.#attrs.set(bk, m); }
        this.#record(op);
        return true;
      }
      case 'mark': {
        const k = `${idKey(op.startId)}|${idKey(op.endId)}|${op.markType}`;
        const cur = this.#marks.get(k);
        const lamport = op.opId.counter;
        if (!cur || lamport > cur.lamport || (lamport === cur.lamport && op.opId.siteId > '')) {
          this.#marks.set(k, { startId: op.startId, endId: op.endId, markType: op.markType, ...(op.markValue !== undefined ? { markValue: op.markValue } : {}), removed: op.remove, lamport });
        }
        this.#record(op);
        return true;
      }
    }
  }

  applyMany(ops: BlockOp[]): number { let n = 0; for (const op of ops) if (this.apply(op)) n++; return n; }

  // ── Sync ───────────────────────────────────────────────────────────────────

  stateVector(): StateVector { return { ...this.#seen }; }
  opsSince(since: StateVector): BlockOp[] {
    return this.#log.filter((op) => { const id = blockOpId(op); return id.counter > (since[id.siteId] ?? 0); });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The document as an ordered list of rendered blocks (the read model). */
  blocks(): RenderedBlock[] {
    const out: RenderedBlock[] = [];
    let cur: { id: RgaId | null; chars: Array<{ id: RgaId; ch: string }> } | null = null;
    const flush = () => { if (cur && (cur.id !== null || cur.chars.length > 0)) out.push(this.#renderBlock(cur)); cur = null; };
    for (const el of this.#elems) {
      if (el.deleted) continue;
      if (el.kind === 'block') { flush(); cur = { id: el.id, chars: [] }; }
      else { if (!cur) cur = { id: null, chars: [] }; cur.chars.push({ id: el.id, ch: el.char! }); }
    }
    flush();
    return out;
  }

  /** Plain text of the whole document (block contents joined by newlines). */
  text(): string { return this.blocks().map((b) => b.text).join('\n'); }

  // ── Snapshot ───────────────────────────────────────────────────────────────

  snapshot(): BlockDocSnapshot {
    const attrs: BlockDocSnapshot['attrs'] = [];
    for (const [bk, m] of this.#attrs) for (const [key, v] of m) {
      attrs.push({ block: bk === LEADING ? null : this.#parseBlockKey(bk), key, value: v.value, lamport: v.lamport, siteId: v.siteId });
    }
    const marks: BlockDocSnapshot['marks'] = [...this.#marks.values()].map((mk) => ({ opId: { counter: mk.lamport, siteId: '' }, startId: mk.startId, endId: mk.endId, markType: mk.markType, ...(mk.markValue !== undefined ? { markValue: mk.markValue } : {}), removed: mk.removed }));
    return {
      elements: this.#elems.map((e) => ({ id: { ...e.id }, originId: e.originId ? { ...e.originId } : null, deleted: e.deleted, kind: e.kind, ...(e.char !== undefined ? { char: e.char } : {}), ...(e.blockType !== undefined ? { blockType: e.blockType } : {}) })),
      attrs, marks,
    };
  }

  static fromSnapshot(siteId: string, snap: BlockDocSnapshot): BlockDoc {
    const doc = new BlockDoc(siteId);
    doc.#elems = snap.elements.map((e) => ({ id: { ...e.id }, originId: e.originId ? { ...e.originId } : null, deleted: e.deleted, kind: e.kind, ...(e.char !== undefined ? { char: e.char } : {}), ...(e.blockType !== undefined ? { blockType: e.blockType } : {}) }));
    doc.#reindex();
    for (const e of doc.#elems) {
      doc.#applied.add(idKey(e.id));
      doc.#bump(e.id);
      doc.#log.push(e.kind === 'block' ? { t: 'ins', id: e.id, originId: e.originId, kind: 'block', blockType: e.blockType ?? 'paragraph' } : { t: 'ins', id: e.id, originId: e.originId, kind: 'char', char: e.char ?? '' });
    }
    for (const a of snap.attrs) {
      const bk = blockKey(a.block); const m = doc.#attrs.get(bk) ?? new Map();
      m.set(a.key, { value: a.value, lamport: a.lamport, siteId: a.siteId }); doc.#attrs.set(bk, m);
    }
    for (const mk of snap.marks) doc.#marks.set(`${idKey(mk.startId)}|${idKey(mk.endId)}|${mk.markType}`, { startId: mk.startId, endId: mk.endId, markType: mk.markType, ...(mk.markValue !== undefined ? { markValue: mk.markValue } : {}), removed: mk.removed, lamport: mk.opId.counter });
    return doc;
  }

  /** Build a fresh document from a list of block specs (used by `pmToBlocks`). */
  static fromBlocks(siteId: string, specs: BlockSpec[]): BlockDoc {
    const doc = new BlockDoc(siteId);
    let prevBlock: RgaId | null = null;
    for (const spec of specs) {
      const { blockId } = doc.insertBlock(prevBlock, spec.type, spec.attrs ?? {});
      if (spec.text) doc.insertText(blockId, 0, spec.text);
      for (const m of spec.marks ?? []) doc.addMark(blockId, m.from, m.to, m.type, m.value);
      prevBlock = blockId;
    }
    return doc;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  #integrate(op: Extract<BlockOp, { t: 'ins' }>): void {
    let i = op.originId === null ? 0 : this.#byId.get(idKey(op.originId))! + 1;
    while (i < this.#elems.length && idGreater(this.#elems[i]!.id, op.id)) i++;
    const el: Elem = { id: op.id, originId: op.originId, deleted: false, kind: op.kind, ...(op.kind === 'char' ? { char: op.char } : { blockType: op.blockType }) };
    this.#elems.splice(i, 0, el);
    this.#reindex();
  }
  #reindex(): void { this.#byId.clear(); for (let i = 0; i < this.#elems.length; i++) this.#byId.set(idKey(this.#elems[i]!.id), i); }
  #bump(id: RgaId): void { this.#seen[id.siteId] = Math.max(this.#seen[id.siteId] ?? 0, id.counter); this.#counter = Math.max(this.#counter, id.counter); }
  #record(op: BlockOp): void { const id = blockOpId(op); this.#applied.add(idKey(id)); this.#bump(id); this.#log.push(op); }
  #drain(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.#buffer.length; i++) {
        const op = this.#buffer[i]!;
        if (op.originId === null || this.#byId.has(idKey(op.originId))) {
          if (!this.#applied.has(idKey(op.id)) && !this.#byId.has(idKey(op.id))) { this.#integrate(op); this.#record(op); }
          this.#buffer.splice(i, 1); i--; progressed = true;
        }
      }
      for (let i = 0; i < this.#delBuffer.length; i++) {
        const op = this.#delBuffer[i]!;
        const idx = this.#byId.get(idKey(op.target));
        if (idx !== undefined) { if (!this.#applied.has(idKey(op.opId))) { this.#elems[idx]!.deleted = true; this.#record(op); } this.#delBuffer.splice(i, 1); i--; progressed = true; }
      }
    }
  }

  /** Anchor for "insert at the very start of the document" (before everything). */
  #startAnchor(): RgaId | null { return null; }

  /** The id of the LAST non-deleted element belonging to `blockId` (so a new block goes after it). */
  #lastElementOfBlock(blockId: RgaId): RgaId | null {
    const start = this.#byId.get(idKey(blockId));
    if (start === undefined) return null;
    let last: RgaId = blockId;
    for (let i = start + 1; i < this.#elems.length; i++) {
      const el = this.#elems[i]!;
      if (el.kind === 'block') break; // next block begins
      if (!el.deleted) last = el.id;
      else last = el.id; // keep tombstones as anchors too (stable)
    }
    return last;
  }

  /** The anchor to insert at the START of a block: the block marker id (or doc start for the leading block). */
  #blockMarkerOrStart(blockId: RgaId | null): RgaId | null { return blockId; }

  /** The id of the `index`-th (1-based) VISIBLE char within `blockId`, or null. */
  #charIdAtBlockIndex(blockId: RgaId | null, index: number): RgaId | null {
    if (index <= 0) return blockId;
    let inBlock = blockId === null; // leading block starts at element 0
    let seen = 0;
    for (const el of this.#elems) {
      if (el.kind === 'block') { inBlock = blockId !== null && idKey(el.id) === idKey(blockId); continue; }
      if (!inBlock || el.deleted) continue;
      seen++;
      if (seen === index) return el.id;
    }
    // Past the end → the last visible char of the block (append).
    let last: RgaId | null = blockId;
    inBlock = blockId === null;
    for (const el of this.#elems) {
      if (el.kind === 'block') { if (inBlock && blockId !== null) break; inBlock = blockId !== null && idKey(el.id) === idKey(blockId); continue; }
      if (inBlock && !el.deleted) last = el.id;
    }
    return last;
  }

  #effectiveType(markerId: RgaId | null, fallback: BlockType): BlockType {
    const a = this.#attrs.get(blockKey(markerId))?.get('type');
    return (a?.value as BlockType | undefined) ?? fallback;
  }
  #effectiveAttrs(markerId: RgaId | null): BlockAttrs {
    const m = this.#attrs.get(blockKey(markerId));
    const out: BlockAttrs = {};
    if (m) for (const [k, v] of m) if (k !== 'type') out[k] = v.value;
    return out;
  }

  #renderBlock(cur: { id: RgaId | null; chars: Array<{ id: RgaId; ch: string }> }): RenderedBlock {
    const markerType = cur.id ? (this.#elemType(cur.id) ?? 'paragraph') : 'paragraph';
    const type = this.#effectiveType(cur.id, markerType);
    const attrs = this.#effectiveAttrs(cur.id);
    const text = cur.chars.map((c) => c.ch).join('');
    // Resolve marks: a mark applies if BOTH its anchors are visible chars in this block.
    const pos = new Map<string, number>();
    cur.chars.forEach((c, i) => pos.set(idKey(c.id), i));
    const marks: RenderedBlock['marks'] = [];
    for (const mk of this.#marks.values()) {
      if (mk.removed) continue;
      const s = pos.get(idKey(mk.startId)); const e = pos.get(idKey(mk.endId));
      if (s === undefined || e === undefined) continue;
      marks.push({ from: Math.min(s, e), to: Math.max(s, e) + 1, type: mk.markType, ...(mk.markValue !== undefined ? { value: mk.markValue } : {}) });
    }
    marks.sort((a, b) => a.from - b.from || a.to - b.to);
    return { id: cur.id, type, attrs, text, marks };
  }

  #elemType(id: RgaId): BlockType | undefined {
    const idx = this.#byId.get(idKey(id));
    return idx === undefined ? undefined : this.#elems[idx]!.blockType;
  }
  #parseBlockKey(bk: string): RgaId | null {
    if (bk === LEADING) return null;
    const at = bk.lastIndexOf('@');
    return { counter: Number(bk.slice(0, at)), siteId: bk.slice(at + 1) };
  }
}
