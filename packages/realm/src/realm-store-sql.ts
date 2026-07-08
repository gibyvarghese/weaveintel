// SPDX-License-Identifier: MIT
/**
 * SQL-backed realm config store — one implementation for SQLite and Postgres. The visibility rule
 * from `resolve.ts` is pushed down into a single WHERE clause (the "one query per family" read):
 * a tenant sees every global default, its own rows, a parent's rows shared to it, and higher
 * ancestors' rows shared to the whole subtree. Everything else is plain parameterised SQL — no
 * recursive CTEs — so both engines behave identically.
 */
import { newUUIDv7 } from '@weaveintel/core';
import {
  computeContentHash,
  globalOriginalFields,
  type RealmRecord,
  type ShareMode,
  type TrackMode,
} from './realm-record.js';
import { parentTenantId, strictGrandAncestorIds, type RealmContext } from './context.js';
import { resolveOne } from './resolve.js';
import {
  NothingToCustomizeError,
  RealmRecordNotFoundError,
  type Payload,
  type RealmConfigStore,
} from './realm-store.js';

export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}
export type SqlDialect = 'sqlite' | 'postgres';

export interface SqlRealmStoreOptions {
  readonly client: SqlClient;
  readonly dialect: SqlDialect;
  readonly table?: string;
  readonly ensureSchema?: boolean;
  readonly idFactory?: () => string;
  readonly clock?: () => string;
}

export function realmConfigDdl(table = 'realm_config'): string[] {
  assertTable(table);
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
       id               TEXT PRIMARY KEY,
       logical_key      TEXT NOT NULL,
       realm            TEXT NOT NULL DEFAULT 'global',
       owner_tenant_id  TEXT,
       origin_id        TEXT,
       origin_hash      TEXT,
       content_hash     TEXT NOT NULL,
       track_mode       TEXT NOT NULL DEFAULT 'pin',
       share_mode       TEXT NOT NULL DEFAULT 'private',
       payload          TEXT NOT NULL DEFAULT '{}',
       created_at       TEXT NOT NULL,
       updated_at       TEXT NOT NULL
     )`,
    // One copy per (logical_key, owner). COALESCE folds the global NULL owner to '' so it's unique too.
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_key_owner ON ${table}(logical_key, COALESCE(owner_tenant_id, ''))`,
    `CREATE INDEX IF NOT EXISTS ix_${table}_owner ON ${table}(owner_tenant_id)`,
  ];
}

function assertTable(t: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error(`Unsafe table name ${JSON.stringify(t)}.`);
}
function monotonicClock(): () => string {
  let last = 0;
  return () => {
    const v = Math.max(Date.now(), last + 1);
    last = v;
    return new Date(v).toISOString();
  };
}
interface RawSql {
  readonly __raw: string;
}
const raw = (s: string): RawSql => ({ __raw: s });
const isRaw = (v: unknown): v is RawSql => typeof v === 'object' && v !== null && '__raw' in v;

export function createSqlRealmStore<T extends Payload = Payload>(opts: SqlRealmStoreOptions): RealmConfigStore<T> {
  const { client, dialect } = opts;
  const table = opts.table ?? 'realm_config';
  assertTable(table);
  const T = raw(table);
  const newId = opts.idFactory ?? newUUIDv7;
  const now = opts.clock ?? monotonicClock();

  let ready: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    if (opts.ensureSchema === false) return Promise.resolve();
    return (ready ??= (async () => {
      for (const stmt of realmConfigDdl(table)) await client.query(stmt);
    })());
  };
  const q = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<Record<string, unknown>>> => {
    await ensure();
    let text = '';
    const params: unknown[] = [];
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) {
        const v = values[i];
        if (isRaw(v)) text += v.__raw;
        else {
          params.push(v);
          text += dialect === 'postgres' ? `$${params.length}` : '?';
        }
      }
    }
    const { rows } = await client.query(text, params);
    return rows;
  };

  const toRecord = (r: Record<string, unknown>): RealmRecord<T> => {
    const payload = parseJson(r['payload']);
    return {
      ...(payload as T),
      id: String(r['id']),
      logicalKey: String(r['logical_key']),
      realm: String(r['realm']) as 'global' | 'tenant',
      ownerTenantId: r['owner_tenant_id'] == null ? null : String(r['owner_tenant_id']),
      originId: r['origin_id'] == null ? null : String(r['origin_id']),
      originHash: r['origin_hash'] == null ? null : String(r['origin_hash']),
      contentHash: String(r['content_hash']),
      trackMode: String(r['track_mode']) as TrackMode,
      shareMode: String(r['share_mode']) as ShareMode,
    } as RealmRecord<T>;
  };

  const getRow = async (id: string): Promise<RealmRecord<T> | null> => {
    const rows = await q`SELECT * FROM ${T} WHERE id = ${id}`;
    return rows[0] ? toRecord(rows[0]) : null;
  };
  const byOwnerKey = async (ownerTenantId: string | null, logicalKey: string): Promise<RealmRecord<T> | null> => {
    const rows = ownerTenantId == null
      ? await q`SELECT * FROM ${T} WHERE logical_key = ${logicalKey} AND owner_tenant_id IS NULL`
      : await q`SELECT * FROM ${T} WHERE logical_key = ${logicalKey} AND owner_tenant_id = ${ownerTenantId}`;
    return rows[0] ? toRecord(rows[0]) : null;
  };

  const insert = async (rec: RealmRecord<T>, payload: T): Promise<void> => {
    const ts = now();
    await q`INSERT INTO ${T} (id, logical_key, realm, owner_tenant_id, origin_id, origin_hash, content_hash, track_mode, share_mode, payload, created_at, updated_at)
            VALUES (${rec.id}, ${rec.logicalKey}, ${rec.realm}, ${rec.ownerTenantId}, ${rec.originId}, ${rec.originHash}, ${rec.contentHash}, ${rec.trackMode}, ${rec.shareMode}, ${JSON.stringify(payload)}, ${ts}, ${ts})`;
  };
  const updatePayload = async (id: string, payload: T, contentHash: string): Promise<void> => {
    await q`UPDATE ${T} SET payload = ${JSON.stringify(payload)}, content_hash = ${contentHash}, updated_at = ${now()} WHERE id = ${id}`;
  };

  const store: RealmConfigStore<T> = {
    async publishGlobal(logicalKey, payload, o) {
      const contentHash = computeContentHash(payload);
      const existing = await byOwnerKey(null, logicalKey);
      if (existing) {
        await updatePayload(existing.id, payload, contentHash);
        if (o?.trackModeDefault) await q`UPDATE ${T} SET track_mode = ${o.trackModeDefault} WHERE id = ${existing.id}`;
        return (await getRow(existing.id))!;
      }
      const rec = { ...payload, id: newId(), ...globalOriginalFields(logicalKey, contentHash) } as RealmRecord<T>;
      if (o?.trackModeDefault) (rec as { trackMode: TrackMode }).trackMode = o.trackModeDefault;
      await insert(rec, payload);
      return (await getRow(rec.id))!;
    },
    async customize(logicalKey, ctx, payload) {
      if (ctx.tenantId == null) throw new NothingToCustomizeError(logicalKey);
      const visible = await store.listVisible(ctx, [logicalKey]);
      const base = resolveOne(visible, logicalKey, ctx);
      if (!base) throw new NothingToCustomizeError(logicalKey);
      const contentHash = computeContentHash(payload);
      const own = await byOwnerKey(ctx.tenantId, logicalKey);
      if (own && own.realm === 'tenant') {
        await updatePayload(own.id, payload, contentHash);
        return (await getRow(own.id))!;
      }
      const rec = {
        ...payload,
        id: newId(),
        realm: 'tenant' as const,
        ownerTenantId: ctx.tenantId,
        logicalKey,
        originId: base.id,
        originHash: base.contentHash,
        contentHash,
        trackMode: 'pin' as const,
        shareMode: 'private' as const,
      } as RealmRecord<T>;
      await insert(rec, payload);
      return (await getRow(rec.id))!;
    },
    async putNative(logicalKey, ownerTenantId, payload) {
      const contentHash = computeContentHash(payload);
      const own = await byOwnerKey(ownerTenantId, logicalKey);
      if (own) {
        await updatePayload(own.id, payload, contentHash);
        return (await getRow(own.id))!;
      }
      const rec = {
        ...payload,
        id: newId(),
        realm: 'tenant' as const,
        ownerTenantId,
        logicalKey,
        originId: null,
        originHash: null,
        contentHash,
        trackMode: 'pin' as const,
        shareMode: 'private' as const,
      } as RealmRecord<T>;
      await insert(rec, payload);
      return (await getRow(rec.id))!;
    },
    async setShareMode(id, shareMode) {
      if (!(await getRow(id))) throw new RealmRecordNotFoundError(id);
      await q`UPDATE ${T} SET share_mode = ${shareMode}, updated_at = ${now()} WHERE id = ${id}`;
      return (await getRow(id))!;
    },
    async delete(id) {
      if (!(await getRow(id))) throw new RealmRecordNotFoundError(id);
      await q`DELETE FROM ${T} WHERE id = ${id}`;
    },
    async get(id) {
      return getRow(id);
    },
    async listAll(logicalKeys) {
      await ensure(); // create the schema before the first read too (reconcile reads an empty store first)
      const rows = logicalKeys && logicalKeys.length > 0
        ? await client.query(
            `SELECT * FROM ${table} WHERE logical_key IN (${logicalKeys.map((_, i) => (dialect === 'postgres' ? `$${i + 1}` : '?')).join(', ')})`,
            logicalKeys,
          ).then((r) => r.rows)
        : (await q`SELECT * FROM ${T}`);
      return (rows as Array<Record<string, unknown>>).map(toRecord);
    },
    async listVisible(ctx, logicalKeys) {
      await ensure();
      const params: unknown[] = [];
      const ph = (v: unknown): string => {
        params.push(v);
        return dialect === 'postgres' ? `$${params.length}` : '?';
      };
      const where: string[] = [];
      if (logicalKeys && logicalKeys.length > 0) {
        where.push(`logical_key IN (${logicalKeys.map((k) => ph(k)).join(', ')})`);
      }
      // The visibility rule.
      const vis: string[] = [`realm = 'global'`];
      if (ctx.tenantId != null) {
        vis.push(`owner_tenant_id = ${ph(ctx.tenantId)}`);
        const parent = parentTenantId(ctx);
        if (parent != null) vis.push(`(owner_tenant_id = ${ph(parent)} AND share_mode IN ('children','subtree'))`);
        const grand = strictGrandAncestorIds(ctx);
        if (grand.length > 0) {
          vis.push(`(owner_tenant_id IN (${grand.map((g) => ph(g)).join(', ')}) AND share_mode = 'subtree')`);
        }
      }
      where.push(`(${vis.join(' OR ')})`);
      const { rows } = await client.query(`SELECT * FROM ${table} WHERE ${where.join(' AND ')}`, params);
      return rows.map(toRecord);
    },
    async count() {
      const rows = await q`SELECT count(*) AS c FROM ${T}`;
      return Number(rows[0]?.['c'] ?? 0);
    },
  };
  return store;
}

function parseJson(v: unknown): Record<string, unknown> {
  if (v == null) return {};
  if (typeof v === 'object') return v as Record<string, unknown>;
  try {
    const p = JSON.parse(String(v));
    return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
