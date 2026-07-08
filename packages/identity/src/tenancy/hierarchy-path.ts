// SPDX-License-Identifier: MIT
/**
 * Materialized-path tree maths — the pure, storage-agnostic core of the tenant hierarchy.
 *
 * A tenant tree is stored the "materialized path" (a.k.a. path-enumeration) way: every node keeps a
 * string that spells out its lineage from the root, e.g. `/acme/emea/uk/`. From that one column you
 * get everything cheaply and portably (SQLite *and* Postgres, no `ltree`, no recursive CTEs):
 *
 *   • depth       — count the id segments.
 *   • ancestors   — chop the path into its prefixes (`/acme/`, `/acme/emea/`).
 *   • descendants — every row whose path starts with mine (`path LIKE '/acme/emea/uk/%'`).
 *   • move a whole branch — one string-replace UPDATE over that same prefix.
 *
 * These functions are pure (no database, no clock, no randomness) so they can be unit-tested to
 * death and reused unchanged by every storage backend.
 */

/** The single character that separates ids in a path. Ids may not contain it. */
export const PATH_SEPARATOR = '/';

/** Thrown when an id can't be placed in a path (empty, or contains the separator). */
export class InvalidTenantIdError extends Error {
  constructor(id: string) {
    super(
      `Tenant id ${JSON.stringify(id)} is not usable in a hierarchy path: it must be non-empty and must not contain "${PATH_SEPARATOR}".`,
    );
    this.name = 'InvalidTenantIdError';
  }
}

/** Validate an id is safe to embed in a materialized path. */
export function assertUsableTenantId(id: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.includes(PATH_SEPARATOR)) {
    throw new InvalidTenantIdError(String(id));
  }
}

/**
 * Build the path for a node given its parent's path (or `null`/`undefined` for a root) and its own id.
 *   root:  buildPath(null, 'acme')            → '/acme/'
 *   child: buildPath('/acme/', 'emea')        → '/acme/emea/'
 */
export function buildPath(parentPath: string | null | undefined, id: string): string {
  assertUsableTenantId(id);
  if (parentPath == null || parentPath === '') return `${PATH_SEPARATOR}${id}${PATH_SEPARATOR}`;
  if (!parentPath.startsWith(PATH_SEPARATOR) || !parentPath.endsWith(PATH_SEPARATOR)) {
    throw new Error(`Parent path ${JSON.stringify(parentPath)} is malformed (must start and end with "${PATH_SEPARATOR}").`);
  }
  return `${parentPath}${id}${PATH_SEPARATOR}`;
}

/** The id segments of a path, root-first. `/acme/emea/uk/` → ['acme','emea','uk']. */
export function segmentsOf(path: string): string[] {
  return path.split(PATH_SEPARATOR).filter((s) => s.length > 0);
}

/** Depth of a node. A root is depth 0, its children depth 1, and so on. */
export function depthOf(path: string): number {
  return Math.max(0, segmentsOf(path).length - 1);
}

/** This node's own id (the last segment). `/acme/emea/uk/` → 'uk'. */
export function idOf(path: string): string {
  const segs = segmentsOf(path);
  return segs[segs.length - 1] ?? '';
}

/** The immediate parent's path, or `null` for a root. `/acme/emea/` → '/acme/'. */
export function parentPathOf(path: string): string | null {
  const segs = segmentsOf(path);
  if (segs.length <= 1) return null;
  return `${PATH_SEPARATOR}${segs.slice(0, -1).join(PATH_SEPARATOR)}${PATH_SEPARATOR}`;
}

/** All ancestor paths, root-first, NOT including this node. `/acme/emea/uk/` → ['/acme/','/acme/emea/']. */
export function ancestorPaths(path: string): string[] {
  const segs = segmentsOf(path);
  const out: string[] = [];
  let acc = PATH_SEPARATOR;
  for (let i = 0; i < segs.length - 1; i++) {
    acc += `${segs[i]}${PATH_SEPARATOR}`;
    out.push(acc);
  }
  return out;
}

/** All ancestor ids, root-first, NOT including this node. */
export function ancestorIds(path: string): string[] {
  return segmentsOf(path).slice(0, -1);
}

/** Is `maybeAncestor` a strict ancestor of `path`? (A node is not its own ancestor.) */
export function isStrictAncestor(maybeAncestor: string, path: string): boolean {
  return path.length > maybeAncestor.length && path.startsWith(maybeAncestor);
}

/**
 * Would moving the node at `movingPath` under `newParentPath` create a cycle?
 * A cycle happens if the new parent IS the node, or is somewhere inside the node's own subtree —
 * a branch can't become its own descendant.
 */
export function wouldCreateCycle(movingPath: string, newParentPath: string | null | undefined): boolean {
  if (newParentPath == null || newParentPath === '') return false; // moving to a root position
  return newParentPath === movingPath || isStrictAncestor(movingPath, newParentPath);
}

/**
 * Rebase a path when a subtree moves. Given the moving node's old path, the new path it will take,
 * and any path currently inside that subtree, return where that inner node lands.
 *   rebase('/acme/emea/', '/globex/emea/', '/acme/emea/uk/') → '/globex/emea/uk/'
 */
export function rebasePath(oldSubtreeRoot: string, newSubtreeRoot: string, pathInSubtree: string): string {
  if (pathInSubtree !== oldSubtreeRoot && !isStrictAncestor(oldSubtreeRoot, pathInSubtree)) {
    throw new Error(`Path ${JSON.stringify(pathInSubtree)} is not inside subtree ${JSON.stringify(oldSubtreeRoot)}.`);
  }
  return newSubtreeRoot + pathInSubtree.slice(oldSubtreeRoot.length);
}

/** The depth change every node in a subtree undergoes when its root moves from `oldRoot` to `newRoot`. */
export function depthDelta(oldSubtreeRoot: string, newSubtreeRoot: string): number {
  return depthOf(newSubtreeRoot) - depthOf(oldSubtreeRoot);
}

/**
 * Escape a materialized-path prefix so it can be used literally inside a SQL `LIKE ... ESCAPE '\'`
 * pattern — otherwise an id containing `%` or `_` would act as a wildcard. Both SQLite and Postgres
 * honour an explicit `ESCAPE '\'` clause, so the generated `<escaped>%` matches exactly the subtree.
 */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/([\\%_])/g, '\\$1');
}
