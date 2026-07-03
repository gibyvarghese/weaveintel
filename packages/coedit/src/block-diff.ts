// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — `diffBlocks`: turn a whole edited document into block ops
 * (for a notes/document product, the "diff-on-save" path).
 *
 * --- Why this exists ---
 * A rich-text editor (Tiptap/ProseMirror) hands us its FULL document on every
 * change — not a neat list of "ops". To co-edit through the {@link BlockDoc} CRDT
 * we must turn "here's the new whole document" into the minimal set of block ops
 * that transform the editor's *current replica* into that new document. `diffBlocks`
 * does exactly that: it diffs the replica's blocks against the target blocks and
 * emits + applies the ops, returning them to submit to the relay.
 *
 * --- Why this converges (the important bit) ---
 * The diff is computed against the client's OWN replica, which has already merged
 * everyone else's ops (the client applies remote ops from the live stream before it
 * saves). So the diff captures ONLY this client's local changes — never a stale
 * "make the whole document look like my screen", which would clobber a collaborator.
 * Two clients that each diff-against-their-synced-replica and submit therefore
 * converge, exactly like hand-written ops, because the underlying RGA merges them.
 *
 * The block alignment is a longest-common-subsequence over a (type+text) signature,
 * so an unchanged block keeps its identity (and its stable marker id); only genuinely
 * edited/added/removed blocks produce ops. Within a matched block, text is diffed by
 * common prefix/suffix (a tiny delete + insert), and inline marks are reconciled
 * against the post-edit positions. Minimality is a nicety; correctness comes from the
 * CRDT, so even a coarse diff stays convergent.
 */
import { BlockDoc, type BlockOp, type BlockSpec, type RgaId, type RenderedBlock } from './block-doc.js';

/** Signature used to match an old block to a new one (same type + same text = "the same block"). */
function sig(b: { type: string; text?: string }): string {
  return `${b.type}\n${b.text ?? ''}`;
}

/** Longest-common-subsequence index pairs over two signature arrays (classic DP). */
function lcsPairs(a: string[], b: string[]): Array<{ i: number; j: number }> {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: Array<{ i: number; j: number }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push({ i, j }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** Length of the common prefix of two strings (by code unit). */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
/** Length of the common suffix, not overlapping an already-counted prefix of `prefix`. */
function commonSuffix(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

function attrsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  return true;
}

function markKey(m: { from: number; to: number; type: string; value?: string }): string {
  return `${m.from}|${m.to}|${m.type}|${m.value ?? ''}`;
}

/** Reconcile a matched block in place: type, attrs, text (prefix/suffix diff), then marks. */
function reconcileBlock(doc: BlockDoc, cur: RenderedBlock, tgt: BlockSpec, ops: BlockOp[]): void {
  if (cur.id === null) return; // the implicit leading block has no marker to retarget; seeded docs never hit this
  const id = cur.id;

  // 1. Block type.
  if (cur.type !== tgt.type) ops.push(doc.setBlockType(id, tgt.type));

  // 2. Block attributes (LWW; only push changed/added keys — stale keys are harmless under LWW).
  const tgtAttrs = tgt.attrs ?? {};
  if (!attrsEqual(cur.attrs, tgtAttrs)) {
    for (const [k, v] of Object.entries(tgtAttrs)) {
      if (JSON.stringify(cur.attrs[k]) !== JSON.stringify(v)) ops.push(doc.setBlockAttr(id, k, v));
    }
  }

  // 3. Text — common prefix/suffix so a small edit stays small (and keeps surrounding char ids stable).
  const oldText = cur.text;
  const newText = tgt.text ?? '';
  if (oldText !== newText) {
    const p = commonPrefix(oldText, newText);
    const s = commonSuffix(oldText, newText, p);
    const delCount = oldText.length - p - s;
    if (delCount > 0) ops.push(...doc.deleteText(id, p, delCount));
    const insStr = newText.slice(p, newText.length - s);
    if (insStr) ops.push(...doc.insertText(id, p, insStr));
  }

  // 4. Inline marks — reconcile against POST-edit positions (re-read so offsets follow the text ops).
  const postCur = doc.blocks().find((b) => b.id !== null && cur.id !== null && b.id.counter === cur.id.counter && b.id.siteId === cur.id.siteId);
  const curMarks = postCur?.marks ?? [];
  const tgtMarks = tgt.marks ?? [];
  const tgtSet = new Set(tgtMarks.map(markKey));
  const curSet = new Set(curMarks.map(markKey));
  for (const m of curMarks) {
    if (tgtSet.has(markKey(m))) continue;
    const op = doc.removeMark(id, m.from, m.to, m.type);
    if (op) ops.push(op);
  }
  for (const m of tgtMarks) {
    if (curSet.has(markKey(m))) continue;
    const op = doc.addMark(id, m.from, m.to, m.type, m.value);
    if (op) ops.push(op);
  }
}

/** Insert a brand-new block after `afterId`, with its text + attrs + marks; returns the new block id. */
function insertNewBlock(doc: BlockDoc, afterId: RgaId | null, spec: BlockSpec, ops: BlockOp[]): RgaId {
  const { ops: blockOps, blockId } = doc.insertBlock(afterId, spec.type, spec.attrs ?? {});
  ops.push(...blockOps);
  if (spec.text) ops.push(...doc.insertText(blockId, 0, spec.text));
  for (const m of spec.marks ?? []) {
    const op = doc.addMark(blockId, m.from, m.to, m.type, m.value);
    if (op) ops.push(op);
  }
  return blockId;
}

/**
 * Diff the document's CURRENT blocks against `target` and apply the difference as
 * block ops, returning the ops to submit to the relay. `target` is what the editor
 * now contains (e.g. `pmToBlocks(editor.getJSON())`). The doc is mutated in place to
 * match `target` (modulo concurrent remote ops, which the CRDT will still merge).
 */
export function diffBlocks(doc: BlockDoc, target: BlockSpec[]): BlockOp[] {
  const ops: BlockOp[] = [];
  const current = doc.blocks();
  const anchors = lcsPairs(current.map(sig), target.map(sig));
  anchors.push({ i: current.length, j: target.length }); // sentinel tail

  let ci = 0, tj = 0;
  let prevId: RgaId | null = null; // anchor for inserts = id of the last block placed in doc order

  for (const anchor of anchors) {
    const curGap = current.slice(ci, anchor.i);
    const tgtGap = target.slice(tj, anchor.j);
    const paired = Math.min(curGap.length, tgtGap.length);

    // Unmatched-on-both — treat index-wise pairs as in-place edits (keeps block ids stable).
    for (let k = 0; k < paired; k++) {
      reconcileBlock(doc, curGap[k]!, tgtGap[k]!, ops);
      if (curGap[k]!.id !== null) prevId = curGap[k]!.id;
    }
    // Extra OLD blocks → delete entirely (clear the text, then merge away the marker
    // so nothing is left behind — `mergeBlock` alone only removes the boundary).
    for (let k = paired; k < curGap.length; k++) {
      const old = curGap[k]!;
      const id = old.id;
      if (id === null) continue;
      if (old.text.length > 0) ops.push(...doc.deleteText(id, 0, old.text.length));
      ops.push(...doc.mergeBlock(id));
    }
    // Extra NEW blocks → insert.
    for (let k = paired; k < tgtGap.length; k++) {
      prevId = insertNewBlock(doc, prevId, tgtGap[k]!, ops);
    }
    // The matched anchor block (signatures equal → only attrs/marks can differ).
    if (anchor.i < current.length && anchor.j < target.length) {
      reconcileBlock(doc, current[anchor.i]!, target[anchor.j]!, ops);
      if (current[anchor.i]!.id !== null) prevId = current[anchor.i]!.id;
    }
    ci = anchor.i + 1;
    tj = anchor.j + 1;
  }
  return ops;
}
