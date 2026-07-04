// SPDX-License-Identifier: MIT
/**
 * @weaveintel/coedit — RGA text CRDT (Collaboration Phase 7).
 *
 * A CRDT (Conflict-free Replicated Data Type) lets many editors — humans AND an
 * AI agent — change the SAME document at the same time and always end up with the
 * exact same result, with NO central lock and NO manual conflict resolution.
 *
 * --- For someone new to this ---
 * Imagine two people typing into the same paragraph over a flaky connection. If
 * you just sent "insert at position 5" both ways, the positions would drift and
 * the text would scramble. A CRDT fixes this by giving every single character a
 * permanent unique ID and saying "insert AFTER character X" instead of "at
 * position 5". Because the IDs never move and there is a fixed rule for ordering
 * two characters that land in the same spot, every replica that has seen the same
 * edits rebuilds the identical text — guaranteed. Deletes don't remove a
 * character; they just hide it (a "tombstone") so it can still anchor others.
 *
 * Algorithm: **RGA** (Replicated Growable Array) — the simplest sequence CRDT
 * that is provably convergent, and what Automerge ships. Verified (mid-2026
 * research) against the Kleppmann/Gomes Isabelle proof + Sypytkowski's reference
 * implementation. Each element id is `(counter, siteId)`; an insert references
 * the id of the element it goes after; **concurrent inserts sharing one reference
 * are ordered by DESCENDING id (higher counter first; equal counter → higher
 * siteId first)** — that single deterministic rule is the whole convergence
 * proof. Tombstones for delete; a Lamport counter (`max(seen)+1`) keeps ids
 * causally ordered; ops whose reference has not arrived yet are BUFFERED until it
 * does (causal delivery).
 *
 * Strong Eventual Consistency: ops are commutative + idempotent (dedupe by id),
 * so any replica that has applied the same SET of ops — in ANY order — has
 * byte-identical text. Zero-dependency + pure (browser- and server-safe).
 */

/** A globally unique element id: a Lamport counter + the originating site. */
export interface RgaId {
  counter: number;
  siteId: string;
}

/** `a` sorts BEFORE `b` (to the LEFT) ⇔ `a` has the HIGHER id (descending order). */
export function idGreater(a: RgaId, b: RgaId): boolean {
  if (a.counter !== b.counter) return a.counter > b.counter;
  return a.siteId > b.siteId;
}
export function idEqual(a: RgaId, b: RgaId): boolean {
  return a.counter === b.counter && a.siteId === b.siteId;
}
export function idKey(id: RgaId): string {
  return `${id.counter}@${id.siteId}`;
}

/**
 * The two op kinds. Every op carries a unique `opId` minted from the AUTHOR's
 * Lamport clock so it propagates correctly via the state vector — for an insert
 * the opId IS the new element id; for a delete the opId is a FRESH id from the
 * deleter (NOT the target's id, which the peer already has — that was the subtle
 * bug a naive design hits: a delete keyed by its target id gets filtered out of
 * an offline sync because the target counter is already in the peer's vector).
 * `originId === null` means "insert at the very start" (after HEAD).
 */
export type RgaOp =
  | { type: 'ins'; id: RgaId; originId: RgaId | null; value: string }
  | { type: 'del'; opId: RgaId; target: RgaId };

/** The unique author-minted id of an op (drives dedupe + state-vector sync). */
export function opIdOf(op: RgaOp): RgaId {
  return op.type === 'ins' ? op.id : op.opId;
}

interface Node {
  id: RgaId;
  value: string;
  originId: RgaId | null;
  deleted: boolean;
}

/** A version vector: the max counter this replica has seen from each site. */
export type StateVector = Record<string, number>;

export interface RgaSnapshot {
  /** Visible-order list of every node (incl. tombstones) — the canonical state. */
  nodes: Array<{ id: RgaId; value: string; originId: RgaId | null; deleted: boolean }>;
}

/**
 * A single replica of a shared text document. Construct one per editor (each
 * human tab, and the agent) with a UNIQUE `siteId`. Local edits return an op to
 * broadcast; remote ops are fed to {@link apply}.
 */
export class RgaDoc {
  readonly siteId: string;
  #counter = 0;
  /** Visible-order array of nodes (index 0 is the first real element; HEAD is implicit/null). */
  #nodes: Node[] = [];
  #byId = new Map<string, number>(); // idKey → index in #nodes (rebuilt on structural change)
  /** Inserts whose `originId` has not arrived yet — replayed when it does (causal delivery). */
  #buffer: Array<Extract<RgaOp, { type: 'ins' }>> = [];
  /** Deletes whose target has not arrived yet — replayed when it does. */
  #delBuffer: Array<Extract<RgaOp, { type: 'del' }>> = [];
  /** Every applied opId (dedupe — idempotency across both ins + del). */
  #applied = new Set<string>();
  /** Highest counter seen per site (the state vector) — for offline sync. */
  #seen: StateVector = {};
  /** Every applied op, in apply order — the durable log used for sync (opsSince). */
  #log: RgaOp[] = [];

  constructor(siteId: string) {
    if (!siteId) throw new Error('RgaDoc requires a non-empty siteId');
    this.siteId = siteId;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** The visible text (tombstones skipped), left to right. */
  text(): string {
    let out = '';
    for (const n of this.#nodes) if (!n.deleted) out += n.value;
    return out;
  }

  /** Number of VISIBLE characters. */
  get length(): number {
    let n = 0;
    for (const node of this.#nodes) if (!node.deleted) n++;
    return n;
  }

  /** The id of the visible character at `index`, or null for the HEAD (start). */
  idAtVisibleIndex(index: number): RgaId | null {
    if (index <= 0) return null;
    let visible = 0;
    for (const node of this.#nodes) {
      if (node.deleted) continue;
      visible++;
      if (visible === index) return node.id;
    }
    // Past the end → anchor to the last visible element (append).
    for (let i = this.#nodes.length - 1; i >= 0; i--) if (!this.#nodes[i]!.deleted) return this.#nodes[i]!.id;
    return null;
  }

  /** This replica's state vector (max counter seen per site). */
  stateVector(): StateVector {
    return { ...this.#seen };
  }

  /** Whether an element id exists in this replica (visible or tombstoned). */
  hasId(id: RgaId): boolean {
    return this.#byId.has(idKey(id));
  }

  /**
   * The VISIBLE index of the element `id`. If that element is tombstoned (or
   * unknown), returns the index of the next visible element to its right — so a
   * cursor anchored to it still resolves to a sensible place. Used to turn a
   * relative cursor position back into a concrete index for rendering.
   */
  visibleIndexOfId(id: RgaId): number {
    const idx = this.#byId.get(idKey(id));
    if (idx === undefined) return this.length;
    let visible = 0;
    for (let i = 0; i < this.#nodes.length; i++) {
      const node = this.#nodes[i]!;
      if (i === idx) return visible + (node.deleted ? 0 : 1); // position AFTER this element
      if (!node.deleted) visible++;
    }
    return visible;
  }

  // ── Local edits ────────────────────────────────────────────────────────────

  /** Insert one character at a VISIBLE index; returns the op to broadcast. */
  localInsert(index: number, value: string): Extract<RgaOp, { type: 'ins' }> {
    if (value.length !== 1) throw new Error('localInsert takes exactly one character (use localInsertText for strings)');
    const originId = this.idAtVisibleIndex(index);
    const id: RgaId = { counter: this.#counter + 1, siteId: this.siteId };
    const op: Extract<RgaOp, { type: 'ins' }> = { type: 'ins', id, originId, value };
    this.apply(op);
    return op;
  }

  /** Insert a whole string at a VISIBLE index; returns the ops (one per char, chained). */
  localInsertText(index: number, text: string): RgaOp[] {
    const ops: RgaOp[] = [];
    let at = index;
    for (const ch of [...text]) {
      ops.push(this.localInsert(at, ch));
      at++;
    }
    return ops;
  }

  /** Delete the visible character at 0-based `index`; returns the op, or null if out of range. */
  localDelete(index: number): Extract<RgaOp, { type: 'del' }> | null {
    // idAtVisibleIndex is 1-based (the Nth visible char), so the 0-based char at
    // `index` is the (index+1)-th visible element.
    const target = this.idAtVisibleIndex(index + 1);
    if (!target) return null;
    const opId: RgaId = { counter: this.#counter + 1, siteId: this.siteId };
    const op: Extract<RgaOp, { type: 'del' }> = { type: 'del', opId, target };
    this.apply(op);
    return op;
  }

  // ── Apply a remote (or local) op ───────────────────────────────────────────

  /**
   * Apply an op. Idempotent (a duplicate is ignored), commutative, and causal —
   * an insert whose `originId` is not present yet is buffered and replayed when
   * the origin arrives. Returns true if the op (or a buffered one) was applied.
   */
  apply(op: RgaOp): boolean {
    // Idempotency: every op has a unique opId — a duplicate is ignored.
    if (this.#applied.has(idKey(opIdOf(op)))) return false;
    if (op.type === 'del') {
      const idx = this.#byId.get(idKey(op.target));
      if (idx === undefined) {
        // Target not here yet — buffer the delete until its element arrives.
        this.#delBuffer.push(op);
        return false;
      }
      const node = this.#nodes[idx]!;
      node.deleted = true;
      this.#record(op);
      return true;
    }
    // Insert.
    if (this.#byId.has(idKey(op.id))) { this.#applied.add(idKey(op.id)); return false; }
    // Causal delivery: the origin must already exist (or be HEAD = null).
    if (op.originId !== null && !this.#byId.has(idKey(op.originId))) {
      this.#buffer.push(op);
      return false;
    }
    this.#integrate(op);
    this.#record(op);
    this.#drainBuffer();
    return true;
  }

  /** Apply many ops (any order); returns how many landed. */
  applyMany(ops: RgaOp[]): number {
    let n = 0;
    for (const op of ops) if (this.apply(op)) n++;
    return n;
  }

  // ── Sync (offline reconcile) ───────────────────────────────────────────────

  /** The ops this replica has that the peer (described by `since`) is missing. */
  opsSince(since: StateVector): RgaOp[] {
    return this.#log.filter((op) => {
      const opId = opIdOf(op);
      return opId.counter > (since[opId.siteId] ?? 0);
    });
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────

  snapshot(): RgaSnapshot {
    return { nodes: this.#nodes.map((n) => ({ id: { ...n.id }, value: n.value, originId: n.originId ? { ...n.originId } : null, deleted: n.deleted })) };
  }

  /** Load a snapshot into a FRESH doc (rebuilds indexes + seen vector). */
  static fromSnapshot(siteId: string, snap: RgaSnapshot): RgaDoc {
    const doc = new RgaDoc(siteId);
    doc.#nodes = snap.nodes.map((n) => ({ id: { ...n.id }, value: n.value, originId: n.originId ? { ...n.originId } : null, deleted: n.deleted }));
    doc.#reindex();
    // A deterministic synthetic site for reconstructed delete ops, so a
    // snapshot-loaded doc can still serve `opsSince` (deletes propagate). Two
    // replicas loading the same snapshot synthesize identical del ops (stable
    // node order) → consistent dedupe.
    let snapDelCounter = 0;
    for (const n of doc.#nodes) {
      doc.#applied.add(idKey(n.id));
      doc.#seen[n.id.siteId] = Math.max(doc.#seen[n.id.siteId] ?? 0, n.id.counter);
      doc.#counter = Math.max(doc.#counter, n.id.counter);
      // Reconstruct a log entry so a snapshot-loaded doc can still serve opsSince.
      doc.#log.push({ type: 'ins', id: n.id, originId: n.originId, value: n.value });
      if (n.deleted) {
        const opId: RgaId = { counter: ++snapDelCounter, siteId: `__snap__:${siteId}` };
        doc.#applied.add(idKey(opId));
        doc.#seen[opId.siteId] = opId.counter;
        doc.#log.push({ type: 'del', opId, target: n.id });
      }
    }
    return doc;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * The RGA integration scan (canonical Kleppmann/Sypytkowski `shift`): place
   * `op` after its origin, then walk RIGHT skipping every element whose id is
   * GREATER than the new id, stopping at the first element with a smaller id.
   * This is a PURE id comparison (not restricted to same-origin siblings): the
   * Lamport-ordered ids guarantee that the run of greater-id elements to skip is
   * exactly the concurrent inserts and their subtrees that belong to our left.
   * Sorting by this single descending-id rule on every replica is the whole
   * convergence proof.
   */
  #integrate(op: Extract<RgaOp, { type: 'ins' }>): void {
    let i = op.originId === null ? 0 : this.#byId.get(idKey(op.originId))! + 1;
    while (i < this.#nodes.length && idGreater(this.#nodes[i]!.id, op.id)) i++;
    this.#nodes.splice(i, 0, { id: op.id, value: op.value, originId: op.originId, deleted: false });
    this.#reindex();
  }

  /** Re-derive the idKey→index map after a structural change. */
  #reindex(): void {
    this.#byId.clear();
    for (let i = 0; i < this.#nodes.length; i++) this.#byId.set(idKey(this.#nodes[i]!.id), i);
  }

  /** Record an op into the applied-set + seen-vector + log (for dedupe + sync). */
  #record(op: RgaOp): void {
    const opId = opIdOf(op);
    this.#applied.add(idKey(opId));
    this.#seen[opId.siteId] = Math.max(this.#seen[opId.siteId] ?? 0, opId.counter);
    // Lamport clock: advance past any counter we have seen, so the NEXT local op
    // is strictly greater than everything observed (keeps ids causally ordered).
    this.#counter = Math.max(this.#counter, opId.counter);
    this.#log.push(op);
  }

  /** Replay buffered inserts/deletes whose dependency may now exist (until stable). */
  #drainBuffer(): void {
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
        if (idx !== undefined) {
          if (!this.#applied.has(idKey(op.opId))) { this.#nodes[idx]!.deleted = true; this.#record(op); }
          this.#delBuffer.splice(i, 1); i--; progressed = true;
        }
      }
    }
  }
}
