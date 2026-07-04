// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collab — the `CoeditDoc` port (the co-editing seam).
 *
 * The port IS the product; the CRDT engine is an adapter behind it. Everything that
 * co-edits a document — the sync relay, the agent-as-peer, the awareness/cursor layer —
 * talks to this small interface, never to a concrete engine. That is what lets the engine
 * be swapped (a Yjs-backed adapter, a server-authoritative OT adapter, …) WITHOUT touching
 * a single caller. See `docs/adapters.md` for how another engine implements this port.
 *
 * The seam is deliberately tiny — the five verbs every collaborative document needs
 * (research: xi-editor's CRDT engine, Zed's `Buffer`, Yjs's `Doc`, AFFiNE's storage layer
 * all converge on the same shape):
 *
 *   • insert / delete   — local edits, returning the ops they produced
 *   • applyOps          — merge remote ops (idempotent, commutative, convergent)
 *   • snapshot          — a serialisable state (live content + tombstone summary)
 *   • awareness         — anchor a cursor to a stable position that survives concurrent edits
 *
 * The REFERENCE adapter is the hand-rolled, zero-dependency RGA (`createRgaDoc`). It keeps
 * all of its buffering / tombstone / convergence / contract tests intact — the port wraps
 * it, it does not replace it.
 */
import type { RgaOp, RgaSnapshot, StateVector } from './rga.js';
import { RgaDoc } from './rga.js';
import type { RelativePosition } from './awareness.js';
import { cursorFromIndex, indexFromCursor } from './awareness.js';

/**
 * The unit of change a {@link CoeditDoc} emits and accepts. It is the wire format both ends
 * of a sync agree on; the engine defines its shape. For the RGA reference adapter that is an
 * {@link RgaOp}; a different engine (Yjs update bytes, an OT operation) would define its own,
 * but the {@link CoeditDoc} contract — apply is idempotent + order-independent + convergent —
 * is identical.
 */
export type CoeditOp = RgaOp;
/** A serialisable document state (live content + compressed tombstone summary). */
export type CoeditSnapshot = RgaSnapshot;
/** Per-site causal clock; drives "give me the ops I haven't seen" sync. */
export type CoeditStateVector = StateVector;

/**
 * A live collaborative document. One replica per participant (each browser tab, the server,
 * and the agent) with a UNIQUE `siteId`. Local edits return the ops they produced so the host
 * can broadcast them; remote ops merge via {@link CoeditDoc.applyOps}. The whole point of the
 * port: callers depend on THIS, never on the engine underneath.
 */
export interface CoeditDoc {
  /** This replica's unique site id (a user site, the server, or an `agent:*` site). */
  readonly siteId: string;
  /** Length of the visible text, in characters. */
  readonly length: number;

  /** The current visible text. */
  text(): string;

  /** Insert `text` at a visible index; the ops are applied locally and returned for broadcast. */
  insert(index: number, text: string): CoeditOp[];
  /**
   * Delete `count` visible characters starting at `index` (default 1); the ops are applied
   * locally and returned. Stops early if it runs past the end of the document.
   */
  delete(index: number, count?: number): CoeditOp[];

  /** Merge remote ops. Idempotent + order-independent; returns how many were NEWLY applied. */
  applyOps(ops: CoeditOp[]): number;

  /** The ops the caller (at `since`) has not yet seen — the sync delta. */
  opsSince(since: CoeditStateVector): CoeditOp[];
  /** This replica's causal state vector. */
  stateVector(): CoeditStateVector;
  /** A serialisable snapshot — persist it, or ship it to a joining peer as their starting state. */
  snapshot(): CoeditSnapshot;

  /**
   * Fork an INDEPENDENT shadow replica with the same content (optionally a new site id). Edits
   * on the fork do not touch this doc — used for speculative / suggested (HITL) edits whose ops
   * are computed but not committed to the live document.
   */
  fork(siteId?: string): CoeditDoc;

  /**
   * Anchor a visible index to a stable {@link RelativePosition} that survives concurrent edits
   * around it (awareness / live cursors). Resolve it later with {@link CoeditDoc.resolve}.
   */
  anchor(index: number): RelativePosition;
  /** Resolve an anchored position back to a concrete visible index in the current document. */
  resolve(pos: RelativePosition): number;
}

/**
 * Adapt an existing {@link RgaDoc} to the {@link CoeditDoc} port (no snapshot round-trip). Use
 * this when you already hold a live RGA replica — e.g. one restored from persisted state — and
 * want to hand it to a port consumer such as {@link createAgentPeer}.
 */
export function fromRgaDoc(doc: RgaDoc): CoeditDoc {
  return {
    get siteId() {
      return doc.siteId;
    },
    get length() {
      return doc.length;
    },
    text: () => doc.text(),
    insert: (index, text) => doc.localInsertText(index, text),
    delete: (index, count = 1) => {
      const ops: CoeditOp[] = [];
      // Each delete removes the visible char at `index`; the next char shifts into its place,
      // so deleting `count` consecutive characters means calling localDelete at the same index.
      // Bound by the shrinking visible length so we never re-delete past the end.
      for (let i = 0; i < count && index < doc.length; i++) {
        const op = doc.localDelete(index);
        if (!op) break; // nothing visible remains at this index
        ops.push(op);
      }
      return ops;
    },
    applyOps: (ops) => doc.applyMany(ops),
    opsSince: (since) => doc.opsSince(since),
    stateVector: () => doc.stateVector(),
    snapshot: () => doc.snapshot(),
    fork: (siteId) => fromRgaDoc(RgaDoc.fromSnapshot(siteId ?? doc.siteId, doc.snapshot())),
    anchor: (index) => cursorFromIndex(doc, index),
    resolve: (pos) => indexFromCursor(doc, pos),
  };
}

/**
 * Create a {@link CoeditDoc} backed by the zero-dependency RGA reference adapter. Pass a
 * `snapshot` to restore a persisted document, or omit it to start empty. This is the default
 * engine; it requires nothing external and carries the full RGA convergence/contract guarantees.
 */
export function createRgaDoc(siteId: string, snapshot?: CoeditSnapshot): CoeditDoc {
  return fromRgaDoc(snapshot ? RgaDoc.fromSnapshot(siteId, snapshot) : new RgaDoc(siteId));
}
