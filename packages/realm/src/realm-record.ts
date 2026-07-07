// SPDX-License-Identifier: MIT
/**
 * Realm records — the small set of columns a *configuration* row carries so it can live in a
 * global→tenant hierarchy.
 *
 * Think of any piece of shipped configuration — a prompt template, a skill, a guardrail. In a single
 * product there's one copy. In a multi-tenant product you want three things at once:
 *   1. a **global** default everyone gets,
 *   2. the ability for a tenant to **customize** its own copy (without touching anyone else's), and
 *   3. a way to tell, later, whether that customized copy has drifted from the default it was forked
 *      from — so a product update doesn't silently clobber a customer's edits (or leave them stale).
 *
 * These fields make that possible, and the drift check is the exact same three-way (Base / Local /
 * Remote) comparison git uses for a merge — just applied to configuration instead of source files.
 */
import { createHash } from 'node:crypto';

/** Is this a shared global default, or a tenant's own copy? */
export type RealmClass = 'global' | 'tenant';

/** How far down the tree a tenant's own record is offered to its descendants. */
export type ShareMode = 'private' | 'children' | 'subtree';

/** Whether a forked copy stays pinned to the version it forked, or auto-follows the source. */
export type TrackMode = 'pin' | 'track_latest';

/** The realm columns every realm-enabled config row gains. */
export interface RealmFields {
  /** 'global' = a shared default; 'tenant' = a specific tenant's copy. */
  realm: RealmClass;
  /** The owning tenant's id. NULL exactly when realm='global'. */
  ownerTenantId: string | null;
  /** The stable identity of the config across copies (e.g. a prompt's key). References use this. */
  logicalKey: string;
  /** The row this was forked from (a global default, or a parent's shared copy). NULL for originals/natives. */
  originId: string | null;
  /** The origin's content hash AT FORK TIME — the "Base" in a three-way drift check. */
  originHash: string | null;
  /** Hash of this row's own semantic content — the "Local". */
  contentHash: string;
  /** Pinned to the fork point, or auto-following the source. */
  trackMode: TrackMode;
  /** Sharing reach down the tenant tree. */
  shareMode: ShareMode;
}

/** A config row = the app's own payload columns plus the realm fields plus an id. */
export type RealmRecord<T = Record<string, unknown>> = T & RealmFields & { id: string };

/** The three shapes a realm row can take, distinguished by (realm, originId). */
export type RealmArchetype = 'global_original' | 'tenant_override' | 'tenant_native';

/** Classify a row: a shared default, a fork of one, or a tenant's from-scratch record. */
export function archetypeOf(f: Pick<RealmFields, 'realm' | 'originId'>): RealmArchetype {
  if (f.realm === 'global') return 'global_original';
  return f.originId == null ? 'tenant_native' : 'tenant_override';
}

/**
 * Deterministic content hash over just the *semantic* fields (the substance — a prompt's template &
 * variables, NOT its id, timestamps, enabled flag or realm columns). Stable across key order and
 * environments, so two rows with the same meaning hash the same on any machine or database.
 */
export function computeContentHash(semantic: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(canonicalize(semantic), 'utf8').digest('hex')}`;
}

/** Canonical JSON: object keys sorted recursively so hashing is order-independent. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortDeep((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** The four drift states of a tenant's forked copy versus the default it came from. */
export type DriftState =
  | 'in_sync' // unchanged locally, source unchanged → identical
  | 'customized' // edited locally, source unchanged → your change is what differs
  | 'stale' // untouched locally, source moved on → safe to refresh
  | 'diverged'; // edited locally AND source moved on → needs a real merge

/**
 * The three-way drift check — Base = the hash at fork time, Local = this copy's current hash, Remote =
 * the source's current hash. Exactly git's merge logic, for config.
 */
export function driftState(base: string | null, local: string, remote: string | null): DriftState | 'not_a_fork' {
  if (base == null || remote == null) return 'not_a_fork'; // an original/native has nothing to drift from
  const localChanged = local !== base;
  const remoteChanged = remote !== base;
  if (!localChanged && !remoteChanged) return 'in_sync';
  if (localChanged && !remoteChanged) return 'customized';
  if (!localChanged && remoteChanged) return 'stale';
  return 'diverged';
}

/** Default realm fields for a brand-new GLOBAL original (what a package seed publishes). */
export function globalOriginalFields(logicalKey: string, contentHash: string): RealmFields {
  return {
    realm: 'global',
    ownerTenantId: null,
    logicalKey,
    originId: null,
    originHash: null,
    contentHash,
    trackMode: 'pin',
    shareMode: 'private',
  };
}
