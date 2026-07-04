// SPDX-License-Identifier: MIT
/**
 * JSON Patch (RFC 6902) + JSON Pointer (RFC 6901) — the wire format for AG-UI
 * `STATE_DELTA` events (Collaboration Phase 6).
 *
 * --- For someone new to this ---
 * Instead of resending a whole shared-state object every time one field changes,
 * we send a tiny list of EDITS: "replace the value at /status with 'completed'",
 * "add to the end of /presence this person". That list of edits is a "JSON
 * Patch" — a standard (RFC 6902) so any AG-UI client can apply it. A "JSON
 * Pointer" (RFC 6901) is just the address of a field, like `/presence/0/userId`.
 *
 * Two directions:
 *   - {@link applyJsonPatch}  — given a document + a patch, produce the new
 *     document. ATOMIC: if any operation fails (a bad path, or a failed `test`),
 *     the whole patch is rejected and the original is returned unchanged, so a
 *     client falls back to requesting a fresh `STATE_SNAPSHOT` rather than ending
 *     up in a half-applied, inconsistent state.
 *   - {@link diffJsonPatch}  — given the previous + next document, COMPUTE the
 *     minimal patch. The server uses this to turn "here is the new collaborative
 *     state" into a small delta to put on the wire.
 *
 * Zero-dependency + pure (no I/O, browser-safe). Scope: the op set RFC 6902
 * defines (add/remove/replace/move/copy/test); arrays are diffed as whole-value
 * replacements (correct, and simplest for the small state objects we ship).
 */

export type JsonPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown };

export type JsonPatch = JsonPatchOp[];

// ─── JSON Pointer (RFC 6901) ────────────────────────────────────────────────────

/** Decode a single reference token (`~1` → `/`, `~0` → `~`). */
function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}
/** Encode a single reference token. */
function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}
/** Parse a JSON Pointer string into its reference tokens. `''` → `[]` (whole doc). */
export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (pointer[0] !== '/') throw new Error(`invalid JSON Pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(unescapeToken);
}
/** Build a JSON Pointer string from reference tokens. */
export function toPointer(tokens: Array<string | number>): string {
  return tokens.map((t) => `/${escapeToken(String(t))}`).join('');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep structural clone (small JSON-only documents). */
function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (isObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out as unknown as T;
  }
  return v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** Read the value at a pointer, or `{ found:false }` if it does not exist. */
function getAt(doc: unknown, tokens: string[]): { found: boolean; value?: unknown } {
  let cur: unknown = doc;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      const idx = token === '-' ? cur.length : Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false };
      cur = cur[idx];
    } else if (isObject(cur)) {
      if (!(token in cur)) return { found: false };
      cur = cur[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

/** Apply a single op to `doc` IN PLACE (doc is already a private clone). */
function applyOne(doc: Record<string, unknown> | unknown[], op: JsonPatchOp): void {
  const setOrAdd = (path: string, value: unknown, isAdd: boolean): void => {
    const tokens = parsePointer(path);
    if (tokens.length === 0) throw new Error('cannot add/replace the whole document');
    const parentTokens = tokens.slice(0, -1);
    const key = tokens[tokens.length - 1]!;
    const parentRes = getAt(doc, parentTokens);
    if (!parentRes.found) throw new Error(`path not found: ${path}`);
    const parent = parentRes.value;
    if (Array.isArray(parent)) {
      const idx = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) throw new Error(`bad array index: ${path}`);
      if (isAdd) parent.splice(idx, 0, value);
      else { if (idx >= parent.length) throw new Error(`replace out of range: ${path}`); parent[idx] = value; }
    } else if (isObject(parent)) {
      if (!isAdd && !(key in parent)) throw new Error(`replace of missing key: ${path}`);
      parent[key] = value;
    } else {
      throw new Error(`cannot set on non-container: ${path}`);
    }
  };
  const removeAt = (path: string): unknown => {
    const tokens = parsePointer(path);
    if (tokens.length === 0) throw new Error('cannot remove the whole document');
    const parentTokens = tokens.slice(0, -1);
    const key = tokens[tokens.length - 1]!;
    const parentRes = getAt(doc, parentTokens);
    if (!parentRes.found) throw new Error(`path not found: ${path}`);
    const parent = parentRes.value;
    if (Array.isArray(parent)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) throw new Error(`bad array index: ${path}`);
      return parent.splice(idx, 1)[0];
    } else if (isObject(parent)) {
      if (!(key in parent)) throw new Error(`remove of missing key: ${path}`);
      const v = parent[key]; delete parent[key]; return v;
    }
    throw new Error(`cannot remove from non-container: ${path}`);
  };

  switch (op.op) {
    case 'add': setOrAdd(op.path, op.value, true); break;
    case 'replace': setOrAdd(op.path, op.value, false); break;
    case 'remove': removeAt(op.path); break;
    case 'move': { const v = removeAt(op.from); setOrAdd(op.path, v, true); break; }
    case 'copy': { const r = getAt(doc, parsePointer(op.from)); if (!r.found) throw new Error(`copy source not found: ${op.from}`); setOrAdd(op.path, clone(r.value), true); break; }
    case 'test': { const r = getAt(doc, parsePointer(op.path)); if (!r.found || !deepEqual(r.value, op.value)) throw new Error(`test failed at ${op.path}`); break; }
    default: throw new Error(`unknown op: ${(op as { op: string }).op}`);
  }
}

/**
 * Apply a JSON Patch to a document and return the new document. ATOMIC: on ANY
 * failure the original is returned unchanged and `ok:false` is set, so the caller
 * can request a fresh snapshot instead of using a half-applied state.
 */
export function applyJsonPatch<T>(doc: T, patch: JsonPatch): { ok: boolean; doc: T; error?: string } {
  const working = clone(doc) as Record<string, unknown> | unknown[];
  try {
    for (const op of patch) applyOne(working, op);
    return { ok: true, doc: working as T };
  } catch (err) {
    return { ok: false, doc, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Diff (compute the minimal patch) ───────────────────────────────────────────

function diffInto(prev: unknown, next: unknown, base: string, out: JsonPatch): void {
  if (deepEqual(prev, next)) return;
  // Objects: recurse per key (add/remove/replace).
  if (isObject(prev) && isObject(next)) {
    for (const k of Object.keys(prev)) {
      if (!(k in next)) out.push({ op: 'remove', path: `${base}/${escapeToken(k)}` });
    }
    for (const k of Object.keys(next)) {
      const childPath = `${base}/${escapeToken(k)}`;
      if (!(k in prev)) out.push({ op: 'add', path: childPath, value: clone(next[k]) });
      else diffInto(prev[k], next[k], childPath, out);
    }
    return;
  }
  // Arrays + scalars + type changes: whole-value replace (simple + correct).
  out.push({ op: 'replace', path: base === '' ? '' : base, value: clone(next) });
}

/**
 * Compute the minimal JSON Patch that turns `prev` into `next`. Objects are
 * diffed key-by-key; arrays + scalars are emitted as whole-value replacements.
 * (For the small collaborative-state objects we ship, this is both correct and
 * the cheapest to reason about.)
 */
export function diffJsonPatch(prev: unknown, next: unknown): JsonPatch {
  const out: JsonPatch = [];
  // A whole-document replace cannot use path '' for `replace` per spec where the
  // root changes type; for our object-rooted state we always recurse from {}.
  if (isObject(prev) && isObject(next)) diffInto(prev, next, '', out);
  else if (!deepEqual(prev, next)) out.push({ op: 'replace', path: '', value: clone(next) });
  return out;
}
