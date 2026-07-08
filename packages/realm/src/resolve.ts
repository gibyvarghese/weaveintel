// SPDX-License-Identifier: MIT
/**
 * The resolution engine — given all the config rows a tenant is *allowed to see* for some family
 * (e.g. every copy of the prompts), pick the ONE that applies to them, and explain why.
 *
 * The rule is "nearest owner wins": your own copy beats a parent's shared copy, which beats the
 * global default. Every result carries **provenance** — is this the global default, your own edit,
 * or something inherited from a parent — plus, for your own edits, whether they've drifted from the
 * default they were forked from. Pure functions: no database, no clock. The store just hands them the
 * visible rows.
 */
import {
  driftState,
  type DriftState,
  type RealmFields,
  type RealmRecord,
} from './realm-record.js';
import {
  ownerDepth,
  parentTenantId,
  strictGrandAncestorIds,
  type RealmContext,
} from './context.js';

/** Where a resolved record came from, for badges / audit / run traces. */
export type RealmProvenance =
  | { readonly kind: 'global' }
  | { readonly kind: 'native'; readonly ownerTenantId: string }
  | { readonly kind: 'own_override'; readonly ownerTenantId: string; readonly drift: DriftState | 'not_a_fork' }
  | { readonly kind: 'inherited'; readonly fromTenantId: string; readonly distance: number };

/** A resolved config row: the winning record plus how it was reached. */
export type EffectiveRecord<T = Record<string, unknown>> = RealmRecord<T> & {
  readonly realmProvenance: RealmProvenance;
};

/**
 * Can tenant `ctx` see this record?
 *  • every global default, and your own records, always;
 *  • a parent's record only if it's shared to 'children' or 'subtree';
 *  • a higher ancestor's record only if it's shared to the whole 'subtree'.
 * A parent's *private* record stays invisible — you resolve past it to the next-nearest or global.
 */
export function isVisible(record: Pick<RealmRecord, keyof RealmFields>, ctx: RealmContext): boolean {
  if (record.realm === 'global') return true;
  if (ctx.tenantId == null) return false; // global caller sees only global
  if (record.ownerTenantId === ctx.tenantId) return true;
  if (record.ownerTenantId === parentTenantId(ctx)) return record.shareMode === 'children' || record.shareMode === 'subtree';
  if (record.ownerTenantId != null && strictGrandAncestorIds(ctx).includes(record.ownerTenantId)) return record.shareMode === 'subtree';
  return false;
}

/** Explain a winning record for a given context. `remoteHashOf` looks up the origin's CURRENT hash (for drift). */
export function provenanceOf(
  record: RealmRecord,
  ctx: RealmContext,
  remoteHashOf?: (originId: string) => string | null | undefined,
): RealmProvenance {
  if (record.realm === 'global') return { kind: 'global' };
  const owner = record.ownerTenantId!;
  if (owner === ctx.tenantId) {
    if (record.originId == null) return { kind: 'native', ownerTenantId: owner };
    const remote = remoteHashOf?.(record.originId) ?? null;
    return { kind: 'own_override', ownerTenantId: owner, drift: driftState(record.originHash, record.contentHash, remote) };
  }
  const d = ownerDepth(ctx, owner);
  return { kind: 'inherited', fromTenantId: owner, distance: d == null ? Infinity : ctx.depth - d };
}

/** The "closeness" score of a candidate: your own = deepest, ancestors shallower, global last. */
function nearness(record: RealmRecord, ctx: RealmContext): number {
  if (record.realm === 'global') return -Infinity;
  return ownerDepth(ctx, record.ownerTenantId) ?? -Infinity;
}

/**
 * Resolve every logical key in a candidate set to its single effective record. Input can be the whole
 * family (all copies of all keys); the function filters to what `ctx` may see, then keeps the nearest
 * owner per logical key, attaching provenance. `remoteHashOf` (optional) enables drift on own edits;
 * by default it's derived from the candidate set (the global original usually sits right there).
 */
export function resolveEffective<T extends Record<string, unknown> = Record<string, unknown>>(
  records: ReadonlyArray<RealmRecord<T>>,
  ctx: RealmContext,
  remoteHashOf?: (originId: string) => string | null | undefined,
): Array<EffectiveRecord<T>> {
  const hashById = new Map(records.map((r) => [r.id, r.contentHash]));
  const lookupRemote = remoteHashOf ?? ((originId: string) => hashById.get(originId));

  const bestByKey = new Map<string, RealmRecord<T>>();
  for (const r of records) {
    if (!isVisible(r, ctx)) continue;
    const cur = bestByKey.get(r.logicalKey);
    if (cur == null) {
      bestByKey.set(r.logicalKey, r);
      continue;
    }
    const better = nearness(r, ctx) - nearness(cur, ctx);
    // Tie-break deterministically by id so results are stable (ties shouldn't occur under the unique key).
    if (better > 0 || (better === 0 && r.id < cur.id)) bestByKey.set(r.logicalKey, r);
  }

  const out: Array<EffectiveRecord<T>> = [];
  for (const r of bestByKey.values()) {
    out.push({ ...r, realmProvenance: provenanceOf(r, ctx, lookupRemote) });
  }
  out.sort((a, b) => (a.logicalKey < b.logicalKey ? -1 : a.logicalKey > b.logicalKey ? 1 : 0));
  return out;
}

/** Resolve a single logical key, or null if the tenant can see no copy of it. */
export function resolveOne<T extends Record<string, unknown> = Record<string, unknown>>(
  records: ReadonlyArray<RealmRecord<T>>,
  logicalKey: string,
  ctx: RealmContext,
  remoteHashOf?: (originId: string) => string | null | undefined,
): EffectiveRecord<T> | null {
  const forKey = records.filter((r) => r.logicalKey === logicalKey);
  return resolveEffective(forKey, ctx, remoteHashOf)[0] ?? null;
}
