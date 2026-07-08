// SPDX-License-Identifier: MIT
/**
 * The realm config store — where realm-enabled configuration lives, plus the write actions that keep
 * the global→tenant story honest:
 *
 *   • publishGlobal — the product ships / an admin publishes a global default (this is what "seeding"
 *     becomes: a global record with a recorded content hash).
 *   • customize     — a tenant forks the copy it currently sees (copy-on-write), recording where it
 *     came from so drift is detectable later.
 *   • putNative     — a tenant authors its own record from scratch (no global equivalent).
 *
 * Reads go through the resolver (`RealmResolver`), which returns the single EFFECTIVE record per
 * logical key for a tenant, with provenance. Implemented in-memory (here) and over SQL
 * (`realm-store-sql`), both held to the same conformance contract.
 */
import { newUUIDv7 } from '@weaveintel/core';
import {
  archetypeOf,
  computeContentHash,
  globalOriginalFields,
  type RealmRecord,
  type ShareMode,
  type TrackMode,
} from './realm-record.js';
import { GLOBAL_CONTEXT, type RealmContext } from './context.js';
import { isVisible, resolveEffective, resolveOne, type EffectiveRecord } from './resolve.js';

/** A config payload is any JSON-ish object (the "substance" — a prompt template, a guardrail rule…). */
export type Payload = Record<string, unknown>;

export class RealmRecordNotFoundError extends Error {
  constructor(id: string) {
    super(`Realm record ${JSON.stringify(id)} not found.`);
    this.name = 'RealmRecordNotFoundError';
  }
}
export class NothingToCustomizeError extends Error {
  constructor(logicalKey: string) {
    super(`Cannot customize ${JSON.stringify(logicalKey)}: the tenant can see no record to fork.`);
    this.name = 'NothingToCustomizeError';
  }
}

/** Storage-agnostic contract for one realm-enabled config family (e.g. "prompts"). */
export interface RealmConfigStore<T extends Payload = Payload> {
  /** Publish or update a GLOBAL default for a logical key. Idempotent by logical key. */
  publishGlobal(logicalKey: string, payload: T, opts?: { trackModeDefault?: TrackMode }): Promise<RealmRecord<T>>;
  /** A tenant forks the copy it currently sees (copy-on-write), recording origin + base hash. */
  customize(logicalKey: string, ctx: RealmContext, payload: T): Promise<RealmRecord<T>>;
  /** A tenant authors a from-scratch record (no origin). */
  putNative(logicalKey: string, ownerTenantId: string, payload: T): Promise<RealmRecord<T>>;
  /** Flip how far a tenant's own record is shared down the tree. */
  setShareMode(id: string, shareMode: ShareMode): Promise<RealmRecord<T>>;
  /** Retire a record (e.g. revert an override so resolution falls through). */
  delete(id: string): Promise<void>;
  /** Fetch one row by id. */
  get(id: string): Promise<RealmRecord<T> | null>;
  /** Every copy of a set of logical keys (or all, if omitted). For in-memory resolution. */
  listAll(logicalKeys?: readonly string[]): Promise<Array<RealmRecord<T>>>;
  /** Only the rows a tenant may SEE (visibility predicate applied). */
  listVisible(ctx: RealmContext, logicalKeys?: readonly string[]): Promise<Array<RealmRecord<T>>>;
  /** Total row count (all copies). */
  count(): Promise<number>;
}

function monotonicClock(): () => string {
  let last = 0;
  return () => {
    const t = Math.max(Date.now(), last + 1);
    last = t;
    return new Date(t).toISOString();
  };
}

/** In-memory reference store — the behavioural source of truth. */
export function createInMemoryRealmStore<T extends Payload = Payload>(): RealmConfigStore<T> {
  const rows = new Map<string, RealmRecord<T>>();
  const now = monotonicClock();

  const globalOf = (logicalKey: string): RealmRecord<T> | undefined =>
    [...rows.values()].find((r) => r.realm === 'global' && r.logicalKey === logicalKey);
  const ownedOf = (logicalKey: string, ownerTenantId: string): RealmRecord<T> | undefined =>
    [...rows.values()].find((r) => r.logicalKey === logicalKey && r.ownerTenantId === ownerTenantId);

  return {
    async publishGlobal(logicalKey, payload, opts) {
      const existing = globalOf(logicalKey);
      const contentHash = computeContentHash(payload);
      if (existing) {
        const updated: RealmRecord<T> = { ...existing, ...payload, contentHash, trackMode: opts?.trackModeDefault ?? existing.trackMode };
        rows.set(existing.id, updated);
        return updated;
      }
      const id = newUUIDv7();
      const rec: RealmRecord<T> = {
        ...payload,
        id,
        ...globalOriginalFields(logicalKey, contentHash),
        ...(opts?.trackModeDefault ? { trackMode: opts.trackModeDefault } : {}),
      } as RealmRecord<T>;
      rows.set(id, rec);
      return rec;
    },
    async customize(logicalKey, ctx, payload) {
      if (ctx.tenantId == null) throw new NothingToCustomizeError(logicalKey);
      // Fork what you SEE: resolve the effective record for this tenant first.
      const visible = [...rows.values()].filter((r) => isVisible(r, ctx) && r.logicalKey === logicalKey);
      const base = resolveOne(visible, logicalKey, ctx);
      if (!base) throw new NothingToCustomizeError(logicalKey);
      const existingOwn = ownedOf(logicalKey, ctx.tenantId);
      const contentHash = computeContentHash(payload);
      if (existingOwn) {
        const updated: RealmRecord<T> = { ...existingOwn, ...payload, contentHash, updatedAt: now() } as RealmRecord<T>;
        rows.set(existingOwn.id, updated);
        return updated;
      }
      const id = newUUIDv7();
      const rec: RealmRecord<T> = {
        ...payload,
        id,
        realm: 'tenant',
        ownerTenantId: ctx.tenantId,
        logicalKey,
        originId: base.id,
        originHash: base.contentHash, // Base
        contentHash, // Local
        trackMode: 'pin',
        shareMode: 'private',
      } as RealmRecord<T>;
      rows.set(id, rec);
      return rec;
    },
    async putNative(logicalKey, ownerTenantId, payload) {
      const existing = ownedOf(logicalKey, ownerTenantId);
      const contentHash = computeContentHash(payload);
      if (existing) {
        const updated: RealmRecord<T> = { ...existing, ...payload, contentHash } as RealmRecord<T>;
        rows.set(existing.id, updated);
        return updated;
      }
      const id = newUUIDv7();
      const rec: RealmRecord<T> = {
        ...payload,
        id,
        realm: 'tenant',
        ownerTenantId,
        logicalKey,
        originId: null,
        originHash: null,
        contentHash,
        trackMode: 'pin',
        shareMode: 'private',
      } as RealmRecord<T>;
      rows.set(id, rec);
      return rec;
    },
    async setShareMode(id, shareMode) {
      const r = rows.get(id);
      if (!r) throw new RealmRecordNotFoundError(id);
      const updated = { ...r, shareMode };
      rows.set(id, updated);
      return updated;
    },
    async delete(id) {
      if (!rows.has(id)) throw new RealmRecordNotFoundError(id);
      rows.delete(id);
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
    async listAll(logicalKeys) {
      const all = [...rows.values()];
      return logicalKeys ? all.filter((r) => logicalKeys.includes(r.logicalKey)) : all;
    },
    async listVisible(ctx, logicalKeys) {
      return (await this.listAll(logicalKeys)).filter((r) => isVisible(r, ctx));
    },
    async count() {
      return rows.size;
    },
  };
}

export interface RealmResolverOptions<T extends Payload> {
  readonly store: RealmConfigStore<T>;
}

/**
 * The read path the app pipeline uses: for a tenant, hand back the single EFFECTIVE record per logical
 * key (nearest owner wins), each stamped with provenance. This is what a choke point like
 * "render the system prompt by key" calls instead of listing raw config.
 */
export interface RealmResolver<T extends Payload = Payload> {
  /** The one record that applies to this tenant for a logical key, or null. */
  resolve(logicalKey: string, ctx: RealmContext): Promise<EffectiveRecord<T> | null>;
  /** One effective record per logical key the tenant can see. */
  listEffective(ctx: RealmContext, logicalKeys?: readonly string[]): Promise<Array<EffectiveRecord<T>>>;
}

export function createRealmResolver<T extends Payload = Payload>(opts: RealmResolverOptions<T>): RealmResolver<T> {
  const { store } = opts;
  return {
    async resolve(logicalKey, ctx) {
      // Pull every visible copy of this key (tenant + shared ancestors + global) in one go, plus the
      // global original for drift, then resolve nearest-owner-wins in memory.
      const candidates = await store.listVisible(ctx, [logicalKey]);
      const globalOriginals = await store.listAll([logicalKey]).then((all) => all.filter((r) => r.realm === 'global'));
      const remoteHashOf = buildRemoteHash([...candidates, ...globalOriginals]);
      return resolveOne(candidates, logicalKey, ctx, remoteHashOf);
    },
    async listEffective(ctx, logicalKeys) {
      const candidates = await store.listVisible(ctx, logicalKeys);
      const globalOriginals = (await store.listAll(logicalKeys)).filter((r) => r.realm === 'global');
      const remoteHashOf = buildRemoteHash([...candidates, ...globalOriginals]);
      return resolveEffective(candidates, ctx, remoteHashOf);
    },
  };
}

function buildRemoteHash(records: ReadonlyArray<RealmRecord>): (originId: string) => string | null | undefined {
  const map = new Map(records.map((r) => [r.id, r.contentHash]));
  return (originId) => map.get(originId);
}

export { GLOBAL_CONTEXT };
