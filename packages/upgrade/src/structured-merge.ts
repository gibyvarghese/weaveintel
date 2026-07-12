// SPDX-License-Identifier: MIT
/**
 * Structured three-way merge of an id-keyed list.
 *
 * A field-level config merge treats each field as one atomic value: if a release adds an element to a list
 * and an operator edited a DIFFERENT element of the same list, the whole field reads as a conflict even
 * though the two changes don't touch the same element. That is too blunt for a list of independently
 * addressable things — a workflow's nodes, a policy's rules, a pipeline's stages.
 *
 * This merges such a list per element, keyed by an id field, with the same three-way logic a good config
 * merge uses per field — applied to each element independently:
 *   • an element the operator never touched that the release changed  → take the release's element
 *   • an element the operator customised that the release didn't       → keep the operator's element
 *   • an element the release ADDED (absent from base and operator)     → add it (the two coexist)
 *   • an element the operator ADDED (absent from base and release)     → keep it (the two coexist)
 *   • an element BOTH changed differently                              → a per-element conflict (kept local)
 *   • a remove-vs-edit                                                 → a conflict (the edit is kept,
 *                                                                        flagged) — never a silent drop of
 *                                                                        edited work; a clean removal is honoured.
 *
 * Pure, with its own stable-stringify for order-independent equality, so it is trivially unit-testable.
 */

/** An element of a mergeable list — must carry a string value at the chosen id key; the rest is opaque. */
export type KeyedItem = Record<string, unknown>;

/** The result of a structured list merge. */
export interface KeyedMergeResult<T extends KeyedItem> {
  /** The merged element list (order: base order first, then local-added, then remote-added — stable). */
  readonly items: T[];
  /** Elements needing a human: both sides changed one differently, or one edited while the other removed. */
  readonly conflicts: Array<{ id: string; reason: 'both_changed' | 'edit_vs_remove' }>;
}

/** Stable JSON — object keys sorted recursively — so equality is order-independent. Guards cycles. */
function stable(v: unknown): string {
  const seen = new WeakSet<object>();
  const norm = (x: unknown): unknown => {
    if (x && typeof x === 'object') {
      if (seen.has(x)) return null;
      seen.add(x);
      if (Array.isArray(x)) return x.map(norm);
      const obj = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, norm(obj[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

/**
 * Parse a list value (a JSON string or an already-parsed array) into elements carrying a string id.
 * @param value the raw value (JSON string, array, or junk).
 * @param idKey the property name that holds each element's id.
 * @returns the elements whose `idKey` is a string; everything else (bad JSON, non-array, id-less) → [].
 */
export function parseList<T extends KeyedItem>(value: unknown, idKey = 'id'): T[] {
  let arr: unknown = value;
  if (typeof value === 'string') { try { arr = JSON.parse(value); } catch { return []; } }
  if (!Array.isArray(arr)) return [];
  return arr.filter((s): s is T => !!s && typeof s === 'object' && typeof (s as KeyedItem)[idKey] === 'string');
}

/** Index a list by its id key (last write wins on duplicate ids, which are malformed anyway). */
function byId<T extends KeyedItem>(items: T[], idKey: string): Map<string, T> {
  return new Map(items.map((s) => [String(s[idKey]), s]));
}

/**
 * Three-way merge two id-keyed lists against their common base, per element.
 *
 * @param base the list we last shipped (Base) — JSON string or array.
 * @param local the list in the store now (Local, may carry operator edits) — JSON string or array.
 * @param remote the list this release ships (Remote) — JSON string or array.
 * @param idKey the property name identifying each element (default 'id').
 * @returns the merged list and any per-element conflicts. A conflict keeps the LOCAL element — never loses
 *   the operator's work — and is surfaced for review. Pure; no side effects.
 */
export function mergeKeyedList<T extends KeyedItem>(
  base: unknown,
  local: unknown,
  remote: unknown,
  idKey = 'id',
): KeyedMergeResult<T> {
  const baseList = parseList<T>(base, idKey);
  const localList = parseList<T>(local, idKey);
  const remoteList = parseList<T>(remote, idKey);
  const b = byId(baseList, idKey);
  const l = byId(localList, idKey);
  const r = byId(remoteList, idKey);
  const ids = new Set<string>([...b.keys(), ...l.keys(), ...r.keys()]);

  const items: T[] = [];
  const conflicts: KeyedMergeResult<T>['conflicts'] = [];
  const eq = (x?: T, y?: T) => stable(x ?? null) === stable(y ?? null);

  // Emit in a stable order: base order, then local-only additions, then remote-only additions.
  const order: string[] = [];
  const pushOrder = (list: T[]) => { for (const s of list) { const id = String(s[idKey]); if (ids.has(id) && !order.includes(id)) order.push(id); } };
  pushOrder(baseList); pushOrder(localList); pushOrder(remoteList);

  for (const id of order) {
    const bn = b.get(id); const ln = l.get(id); const rn = r.get(id);
    const inB = b.has(id), inL = l.has(id), inR = r.has(id);

    if (inL && inR) {
      if (eq(ln, rn)) { items.push(ln!); continue; }                    // both sides have the same element
      const localChanged = !inB || !eq(ln, bn);
      const remoteChanged = !inB || !eq(rn, bn);
      if (localChanged && !remoteChanged) { items.push(ln!); continue; } // operator customised; keep theirs
      if (!localChanged && remoteChanged) { items.push(rn!); continue; } // untouched; take the release's
      items.push(ln!); conflicts.push({ id, reason: 'both_changed' });   // both changed differently → keep local, flag
      continue;
    }
    if (inL && !inR) {
      if (inB && !eq(ln, bn)) { items.push(ln!); conflicts.push({ id, reason: 'edit_vs_remove' }); continue; } // remote removed an element the operator edited → conflict, keep local
      if (inB && eq(ln, bn)) continue;   // remote removed an untouched element → honour removal
      items.push(ln!); continue;          // operator-added element → keep it
    }
    if (!inL && inR) {
      if (inB && !eq(rn, bn)) { items.push(rn!); conflicts.push({ id, reason: 'edit_vs_remove' }); continue; } // operator removed an element the release changed → conflict, take release's (visible for review)
      if (inB && eq(rn, bn)) continue;   // operator removed an element the release didn't touch → honour removal
      items.push(rn!); continue;          // release-added element → add it (coexists with the operator's list)
    }
    // inB only → both removed → drop.
  }
  return { items, conflicts };
}
