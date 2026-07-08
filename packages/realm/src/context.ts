// SPDX-License-Identifier: MIT
/**
 * Realm context — "who is asking, and where do they sit in the tenant tree?"
 *
 * Resolution needs the asking tenant's lineage (itself + its ancestors, each with a depth) so it can
 * pick the *nearest* owner of a config and decide what a parent has chosen to share downward. That
 * lineage comes straight from the Phase 0 tenant hierarchy (`@weaveintel/identity`).
 */
import type { TenantHierarchyStore } from '@weaveintel/identity';

/** One tenant on the lineage from root to the asking tenant. */
export interface LineageNode {
  readonly tenantId: string;
  /** Depth in the tree — roots are 0, deeper is larger. */
  readonly depth: number;
}

/**
 * The asking tenant's position. `lineage` runs root → … → self (self is the last element). A "system"
 * / global caller has `tenantId: null` and an empty lineage — it sees only global records.
 */
export interface RealmContext {
  readonly tenantId: string | null;
  readonly depth: number;
  /** root → self; ancestors are all but the last. */
  readonly lineage: readonly LineageNode[];
}

/** The global/system context — sees only global records, no tenant overrides. */
export const GLOBAL_CONTEXT: RealmContext = { tenantId: null, depth: -1, lineage: [] };

/** Immediate parent tenant id, or null at a root. */
export function parentTenantId(ctx: RealmContext): string | null {
  return ctx.lineage.length >= 2 ? ctx.lineage[ctx.lineage.length - 2]!.tenantId : null;
}

/** Ancestor tenant ids ABOVE the immediate parent (grandparent → root). */
export function strictGrandAncestorIds(ctx: RealmContext): string[] {
  return ctx.lineage.slice(0, Math.max(0, ctx.lineage.length - 2)).map((n) => n.tenantId);
}

/** Depth of a given owner tenant id within this context's lineage, or undefined if not an ancestor/self. */
export function ownerDepth(ctx: RealmContext, ownerTenantId: string | null): number | undefined {
  if (ownerTenantId == null) return undefined; // global
  return ctx.lineage.find((n) => n.tenantId === ownerTenantId)?.depth;
}

/**
 * Build a context from the tenant hierarchy: fetch the tenant and its ancestors, ordered root → self.
 * Pass `null` for the global/system caller.
 */
export async function buildRealmContext(
  hierarchy: TenantHierarchyStore,
  tenantId: string | null,
): Promise<RealmContext> {
  if (tenantId == null) return GLOBAL_CONTEXT;
  const self = await hierarchy.get(tenantId);
  if (!self) throw new Error(`buildRealmContext: tenant ${JSON.stringify(tenantId)} not found.`);
  const ancestors = await hierarchy.ancestors(tenantId); // root → parent
  const lineage: LineageNode[] = [
    ...ancestors.map((a) => ({ tenantId: a.id, depth: a.depth })),
    { tenantId: self.id, depth: self.depth },
  ];
  return { tenantId, depth: self.depth, lineage };
}
