// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — BlockOp validation for the TRUSTED RELAY (weaveNotes Phase 2).
 *
 * Phase 7 added {@link validateClientOps} for plain-text {@link RgaOp}s. A NOTE is
 * co-edited as {@link BlockOp}s (insert a char/block marker, delete, set a block
 * attribute, add/remove an inline mark), so the relay needs the same trust check
 * for the richer op shape. CRDTs converge but are NOT Byzantine-tolerant, so before
 * the server applies + broadcasts a client's block ops it must verify every one.
 *
 * --- For someone new to this ---
 * The browser sends the server a little list of "edits" (block ops). We can't just
 * trust them: a malicious client could (a) claim to be a DIFFERENT user (forge the
 * author id), (b) send a 10MB "character", or (c) flood us with a million ops. So
 * this function checks, for each op: is it shaped correctly? are sizes sane? and —
 * the important one — is the AUTHOR id inside the namespace this logged-in
 * connection is allowed to write as? Anything off → reject the whole batch.
 */
import { siteOwnedBy } from './validation.js';
import type { RgaId } from './rga.js';
import {
  blockOpId,
  type BlockOp,
  type BlockType,
  type MarkType,
} from './block-doc.js';

/** The structural block types the relay accepts (the StarterKit subset). */
const BLOCK_TYPES = new Set<BlockType>([
  'paragraph', 'heading', 'bulletListItem', 'orderedListItem', 'taskItem', 'codeBlock', 'blockquote', 'divider',
]);
/** The inline mark types the relay accepts. */
const MARK_TYPES = new Set<MarkType>(['bold', 'italic', 'code', 'strike', 'underline', 'link']);

export interface BlockOpValidationOptions {
  /** The site NAMESPACE this connection may author as (e.g. `u:<userId>`) — anti-forgery. */
  expectedSiteId: string;
  /** Max ops per submission (anti-flood). Default 5000. */
  maxOps?: number;
  /** Max characters in a single text-insert op. Default 64 (one grapheme cluster is plenty). */
  maxCharsPerOp?: number;
  /** Max serialized length of an attribute value or a mark value (anti-bloat). Default 4096. */
  maxValueLen?: number;
  /** Max length of an attribute key. Default 64. */
  maxKeyLen?: number;
}

export interface BlockOpValidationResult {
  ok: boolean;
  error?: string;
  /** The validated ops (a shallow copy), present only when `ok`. */
  ops?: BlockOp[];
}

function isRgaId(v: unknown): v is RgaId {
  return typeof v === 'object' && v !== null
    && typeof (v as RgaId).counter === 'number' && Number.isFinite((v as RgaId).counter) && (v as RgaId).counter > 0
    && typeof (v as RgaId).siteId === 'string' && (v as RgaId).siteId.length > 0 && (v as RgaId).siteId.length <= 128;
}

/** A reasonably-bounded JSON value (no functions, sane serialized size). */
function valueWithinLimit(value: unknown, maxLen: number): boolean {
  try {
    const s = JSON.stringify(value ?? null);
    return typeof s === 'string' && s.length <= maxLen;
  } catch {
    return false; // circular / unserializable
  }
}

/**
 * Validate a batch of client-submitted BLOCK ops. Rejects malformed shapes,
 * oversized inserts/values, floods, unknown block/mark types, and — the key check
 * — any op whose AUTHOR site id ({@link blockOpId}) is not owned by the
 * connection's authenticated `expectedSiteId` namespace (no identity forgery).
 *
 * Note a deliberate asymmetry that mirrors {@link validateClientOps}: a delete/mark
 * may TARGET another peer's element (you can delete or format characters someone
 * else typed), but the op's own author id must live in your namespace.
 */
export function validateClientBlockOps(raw: unknown, opts: BlockOpValidationOptions): BlockOpValidationResult {
  const maxOps = opts.maxOps ?? 5000;
  const maxChars = opts.maxCharsPerOp ?? 64;
  const maxValueLen = opts.maxValueLen ?? 4096;
  const maxKeyLen = opts.maxKeyLen ?? 64;
  if (!Array.isArray(raw)) return { ok: false, error: 'ops must be an array' };
  if (raw.length === 0) return { ok: false, error: 'no ops' };
  if (raw.length > maxOps) return { ok: false, error: `too many ops (> ${maxOps})` };

  const ops: BlockOp[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: 'op must be an object' };
    const op = item as Record<string, unknown>;
    const t = op['t'];

    if (t === 'ins') {
      if (!isRgaId(op['id'])) return { ok: false, error: 'invalid op id' };
      if (op['originId'] !== null && !isRgaId(op['originId'])) return { ok: false, error: 'invalid originId' };
      if (op['kind'] === 'char') {
        if (typeof op['char'] !== 'string' || op['char'].length === 0) return { ok: false, error: 'char insert must be a non-empty string' };
        if ([...(op['char'] as string)].length > maxChars) return { ok: false, error: `char insert too long (> ${maxChars})` };
      } else if (op['kind'] === 'block') {
        if (!BLOCK_TYPES.has(op['blockType'] as BlockType)) return { ok: false, error: `unknown block type: ${String(op['blockType'])}` };
      } else {
        return { ok: false, error: `unknown ins kind: ${String(op['kind'])}` };
      }
    } else if (t === 'del') {
      if (!isRgaId(op['opId'])) return { ok: false, error: 'invalid del opId' };
      if (!isRgaId(op['target'])) return { ok: false, error: 'invalid del target' };
    } else if (t === 'attr') {
      if (!isRgaId(op['opId'])) return { ok: false, error: 'invalid attr opId' };
      if (op['block'] !== null && !isRgaId(op['block'])) return { ok: false, error: 'invalid attr block' };
      if (typeof op['key'] !== 'string' || op['key'].length === 0 || op['key'].length > maxKeyLen) return { ok: false, error: 'invalid attr key' };
      if (!valueWithinLimit(op['value'], maxValueLen)) return { ok: false, error: 'attr value too large or unserializable' };
    } else if (t === 'mark') {
      if (!isRgaId(op['opId'])) return { ok: false, error: 'invalid mark opId' };
      if (!isRgaId(op['startId']) || !isRgaId(op['endId'])) return { ok: false, error: 'invalid mark range' };
      if (!MARK_TYPES.has(op['markType'] as MarkType)) return { ok: false, error: `unknown mark type: ${String(op['markType'])}` };
      if (op['markValue'] !== undefined && (typeof op['markValue'] !== 'string' || op['markValue'].length > maxValueLen)) return { ok: false, error: 'invalid mark value' };
      if (typeof op['remove'] !== 'boolean') return { ok: false, error: 'mark.remove must be a boolean' };
    } else {
      return { ok: false, error: `unknown op type: ${String(t)}` };
    }

    // THE trust check: the op's author must be inside this connection's namespace.
    const author = blockOpId(op as unknown as BlockOp);
    if (!siteOwnedBy(author.siteId, opts.expectedSiteId)) {
      return { ok: false, error: 'forbidden: cannot author a block op as another site (identity forgery)' };
    }
    ops.push(op as unknown as BlockOp);
  }
  return { ok: true, ops };
}
