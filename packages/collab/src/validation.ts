// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — Op validation for the TRUSTED RELAY.
 *
 * CRDTs assume non-malicious peers — they converge, but they are NOT
 * Byzantine-tolerant. So the SERVER must validate every op a client submits
 * before applying + broadcasting it (mid-2026 research: Kleppmann BFT-CRDT).
 *
 * --- For someone new to this ---
 * Anyone can send the server an "edit". Before trusting it we check: is it
 * shaped like a real op? Is the character a sane size? And — most importantly —
 * is the editor claiming to BE someone else? Every op is signed with the
 * author's site id; the server knows which site id THIS connection was given
 * (from the login), and rejects any op that claims a different author. That stops
 * one user forging edits as another. We also cap how many ops and how much text
 * a single request may carry, so nobody can flood the document.
 */
import type { RgaOp, RgaId } from './rga.js';

export interface OpValidationOptions {
  /**
   * The site NAMESPACE this connection is authorised to author as (anti-forgery).
   * A user owns a namespace (e.g. `u:<userId>`); each of their devices/tabs uses
   * a distinct full site id UNDER it (`u:<userId>:<device>`), so replicas stay
   * unique while every op is still provably owned by the authenticated user. An
   * op's site is accepted iff it equals the namespace or begins `namespace + ':'`.
   */
  expectedSiteId: string;
  /** Max ops per submission (anti-flood). Default 5000. */
  maxOps?: number;
  /** Max characters in a single insert op. Default 64 (one grapheme cluster is fine). */
  maxCharsPerOp?: number;
}

/** True if `site` is owned by the `namespace` (exact, or a `namespace:device` child). */
export function siteOwnedBy(site: string, namespace: string): boolean {
  return site === namespace || site.startsWith(`${namespace}:`);
}

export interface OpValidationResult {
  ok: boolean;
  error?: string;
  /** The validated ops (a shallow copy), present only when `ok`. */
  ops?: RgaOp[];
}

function isRgaId(v: unknown): v is RgaId {
  return typeof v === 'object' && v !== null
    && typeof (v as RgaId).counter === 'number' && Number.isFinite((v as RgaId).counter) && (v as RgaId).counter > 0
    && typeof (v as RgaId).siteId === 'string' && (v as RgaId).siteId.length > 0 && (v as RgaId).siteId.length <= 64;
}

/**
 * Validate a batch of client-submitted ops. Rejects malformed shapes, oversized
 * inserts, floods, and — the key check — any op whose author site id is not the
 * connection's authenticated `expectedSiteId` (no identity forgery).
 */
export function validateClientOps(raw: unknown, opts: OpValidationOptions): OpValidationResult {
  const maxOps = opts.maxOps ?? 5000;
  const maxChars = opts.maxCharsPerOp ?? 64;
  if (!Array.isArray(raw)) return { ok: false, error: 'ops must be an array' };
  if (raw.length === 0) return { ok: false, error: 'no ops' };
  if (raw.length > maxOps) return { ok: false, error: `too many ops (> ${maxOps})` };

  const ops: RgaOp[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: 'op must be an object' };
    const op = item as Record<string, unknown>;
    if (op['type'] === 'ins') {
      if (!isRgaId(op['id'])) return { ok: false, error: 'invalid op id' };
      if (op['originId'] !== null && !isRgaId(op['originId'])) return { ok: false, error: 'invalid originId' };
      if (typeof op['value'] !== 'string' || op['value'].length === 0) return { ok: false, error: 'insert value must be a non-empty string' };
      if ([...(op['value'] as string)].length > maxChars) return { ok: false, error: `insert too long (> ${maxChars} chars)` };
      if (!siteOwnedBy((op['id'] as RgaId).siteId, opts.expectedSiteId)) return { ok: false, error: 'forbidden: cannot author an op as another site (identity forgery)' };
      ops.push({ type: 'ins', id: op['id'] as RgaId, originId: (op['originId'] as RgaId | null), value: op['value'] as string });
    } else if (op['type'] === 'del') {
      if (!isRgaId(op['opId'])) return { ok: false, error: 'invalid del opId' };
      if (!isRgaId(op['target'])) return { ok: false, error: 'invalid del target' };
      // A delete may TARGET any element (you can delete others' characters), but
      // the delete OP itself must be authored within this user's namespace.
      if (!siteOwnedBy((op['opId'] as RgaId).siteId, opts.expectedSiteId)) return { ok: false, error: 'forbidden: cannot author a delete as another site (identity forgery)' };
      ops.push({ type: 'del', opId: op['opId'] as RgaId, target: op['target'] as RgaId });
    } else {
      return { ok: false, error: `unknown op type: ${String(op['type'])}` };
    }
  }
  return { ok: true, ops };
}
