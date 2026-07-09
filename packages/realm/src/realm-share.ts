// SPDX-License-Identifier: MIT
/**
 * Sharing a customization down the org tree, and promoting one up to the global default.
 *
 * Phase 1 let a tenant fork a config record; Phase 4 lets it SHARE that fork with the tenants beneath
 * it (a parent company's choice flowing to its subsidiaries), and — the other direction — lets a good
 * tenant customization be PROMOTED to the shared global default for everyone.
 *
 * Before you flip a share on, you want to know the **blast radius**: exactly which descendants will
 * start using your record, and which won't because they already have their own copy. This is the same
 * "who is affected, review high-impact changes before they propagate" discipline that change-management
 * and IaC tools apply — surfaced here for config so a `Share` is never a blind action.
 */
import type { ShareMode } from './realm-record.js';
import type { Payload, RealmConfigStore } from './realm-store.js';
import type { RealmVersionLog } from './realm-version.js';
import { publishToRealm } from './reconcile.js';

/** One descendant of the sharing tenant, with its depth in the tree. */
export interface DescendantNode {
  readonly tenantId: string;
  readonly depth: number;
}

/** Who a share reaches. `inheriting` start using the record; `shadowed` keep their own copy. */
export interface BlastRadius {
  readonly shareMode: ShareMode;
  /** Descendants in scope with no fork of their own → they WILL start using the shared record. */
  readonly inheriting: string[];
  /** Descendants in scope who already have their own copy → unaffected (their fork wins). */
  readonly shadowed: string[];
  /** Descendants outside the share scope (e.g. grandchildren when sharing only to `children`). */
  readonly outOfScope: number;
  /** Total descendants considered. */
  readonly total: number;
}

/**
 * Compute the blast radius of sharing a record owned by a tenant at `ownerDepth`, given the full list of
 * that tenant's descendants (from the tenant hierarchy) and the set of descendants that already have
 * their own fork of this logical key. Pure — no I/O — so a UI can preview it before confirming.
 *
 *  • `private`  → reaches nobody.
 *  • `children` → direct children only (depth === ownerDepth + 1).
 *  • `subtree`  → the whole branch below.
 */
export function blastRadius(
  ownerDepth: number,
  descendants: readonly DescendantNode[],
  shareMode: ShareMode,
  forkedTenantIds: ReadonlySet<string>,
): BlastRadius {
  const inScope = (d: DescendantNode): boolean => {
    if (shareMode === 'private') return false;
    if (shareMode === 'children') return d.depth === ownerDepth + 1;
    return d.depth > ownerDepth; // subtree
  };
  const inheriting: string[] = [];
  const shadowed: string[] = [];
  let outOfScope = 0;
  for (const d of descendants) {
    if (!inScope(d)) { outOfScope += 1; continue; }
    if (forkedTenantIds.has(d.tenantId)) shadowed.push(d.tenantId);
    else inheriting.push(d.tenantId);
  }
  return { shareMode, inheriting: inheriting.sort(), shadowed: shadowed.sort(), outOfScope, total: descendants.length };
}

// The realm bookkeeping fields that must be stripped off a stored record to recover the app's payload.
const REALM_FIELD_KEYS = new Set([
  'id', 'realm', 'ownerTenantId', 'logicalKey', 'originId', 'originHash', 'contentHash', 'trackMode', 'shareMode',
  'realmProvenance', 'createdAt', 'updatedAt',
]);

/** Recover the plain app payload (T) from a stored realm record by dropping the realm bookkeeping fields. */
export function payloadOf<T extends Payload>(record: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (!REALM_FIELD_KEYS.has(k)) out[k] = v;
  return out as T;
}

/**
 * Promote a tenant's fork to the shared global default — the "productise a good customisation for
 * everyone" step of ProposeToRealm. Publishes the fork's content as the new global original and records
 * a version (so drift keeps working). The tenant's fork itself is untouched; callers may retire it
 * afterwards if they want the tenant to fall back to the (now identical) global.
 */
export async function promoteFork<T extends Payload>(
  store: RealmConfigStore<T>,
  versionLog: RealmVersionLog<T>,
  family: string,
  fork: Record<string, unknown> & { logicalKey: string },
  opts: { publishedBy?: string; note?: string; at?: string } = {},
): Promise<{ contentHash: string }> {
  const payload = payloadOf<T>(fork);
  return publishToRealm(store, versionLog, family, fork.logicalKey, payload, { note: 'promote', ...opts });
}
