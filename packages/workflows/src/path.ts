/**
 * @weaveintel/workflows — path.ts
 * Tiny dotted-path read/write helpers used by inputMap/outputMap.
 *
 * Supported syntax:
 *   foo.bar.baz
 *   foo.bar[0].baz   (bracketed index)
 *   foo.bar.0.baz    (numeric segment, also treated as array index when target is array)
 *
 * No wildcards, no filters, no functions — for the 80% case. Anything more
 * elaborate belongs in a dedicated expression layer.
 */

const SEGMENT_RE = /[^.[\]]+|\[(\d+)\]/g;

function splitPath(path: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  SEGMENT_RE.lastIndex = 0;
  while ((m = SEGMENT_RE.exec(path)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[0]);
  }
  return out;
}

/** Read a value at a dotted path. Returns `undefined` if any hop misses. */
export function readPath(source: unknown, path: string): unknown {
  if (!path) return source;
  const segments = splitPath(path);
  let cursor: unknown = source;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cursor = cursor[idx];
      continue;
    }
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

/**
 * Write a value at a dotted path, creating intermediate objects as needed.
 * Mutates `target` in place.
 *
 * - Numeric segments after an existing array branch create/extend the array.
 * - All other intermediate creates are plain objects.
 */
export function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!path) return;
  const segments = splitPath(path);
  if (segments.length === 0) return;
  let cursor: Record<string, unknown> | unknown[] = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const nextSeg = segments[i + 1]!;
    const nextWantsArray = /^\d+$/.test(nextSeg);
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return;
      let nextNode = cursor[idx];
      if (nextNode === null || nextNode === undefined) {
        nextNode = nextWantsArray ? [] : {};
        cursor[idx] = nextNode;
      }
      cursor = nextNode as Record<string, unknown> | unknown[];
    } else {
      const cur = cursor as Record<string, unknown>;
      let nextNode = cur[seg];
      if (nextNode === null || nextNode === undefined) {
        nextNode = nextWantsArray ? [] : {};
        cur[seg] = nextNode;
      }
      cursor = nextNode as Record<string, unknown> | unknown[];
    }
  }
  const last = segments[segments.length - 1]!;
  if (Array.isArray(cursor)) {
    const idx = Number(last);
    if (Number.isInteger(idx)) cursor[idx] = value;
    return;
  }
  (cursor as Record<string, unknown>)[last] = value;
}

/**
 * Build a new input object from `inputMap` against `variables`.
 * Keys of the result are the inputMap keys (treated as dotted paths into the
 * output). Values are read from `variables` via the inputMap value paths.
 */
export function applyInputMap(
  inputMap: Record<string, string>,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [outKey, srcPath] of Object.entries(inputMap)) {
    const value = readPath(variables, srcPath);
    writePath(out, outKey, value);
  }
  return out;
}

/**
 * Apply an outputMap by reading from `result` (dotted paths) and writing
 * into `variables` (dotted paths). Mutates `variables` in place.
 *
 * If a value path is the literal `"$"` or empty string, the entire result
 * is written. This makes the common "stash whole result" case ergonomic.
 */
export function applyOutputMap(
  outputMap: Record<string, string>,
  result: unknown,
  variables: Record<string, unknown>,
): void {
  for (const [destPath, srcPath] of Object.entries(outputMap)) {
    const value = !srcPath || srcPath === '$' ? result : readPath(result, srcPath);
    writePath(variables, destPath, value);
  }
}
