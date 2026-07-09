// SPDX-License-Identifier: MIT
/**
 * SQL-backed realm state overlay — one implementation for SQLite and Postgres over the same `SqlClient`
 * seam the rest of the package uses. Upsert via `ON CONFLICT` (supported identically on both engines);
 * no recursive SQL.
 */
import { newUUIDv7 } from '@weaveintel/core';
import type { SqlClient, SqlDialect } from './realm-store-sql.js';
import type { RealmStateOverlay, RealmStateRecord, RealmStateStore } from './realm-state.js';

export interface SqlStateStoreOptions {
  readonly client: SqlClient;
  readonly dialect: SqlDialect;
  readonly table?: string;
  readonly ensureSchema?: boolean;
  readonly idFactory?: () => string;
  readonly clock?: () => string;
}

/** Portable DDL. enabled/pinned_version as INTEGER; NULL = inherit. Unique per (tenant, family, key). */
export function realmTenantStateDdl(table = 'realm_tenant_state'): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      family         TEXT NOT NULL,
      logical_key    TEXT NOT NULL,
      enabled        INTEGER,
      priority       INTEGER,
      pinned_version INTEGER,
      updated_at     TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_tenant_key ON ${table}(tenant_id, family, logical_key)`,
    `CREATE INDEX IF NOT EXISTS ix_${table}_family_key ON ${table}(family, logical_key)`,
  ];
}

const DEFAULT_AT = '1970-01-01T00:00:00.000Z';
const boolToInt = (b: boolean | null | undefined): number | null => (b == null ? null : b ? 1 : 0);
const intToBool = (v: unknown): boolean | null => (v == null ? null : Number(v) !== 0);

export function createSqlStateStore(opts: SqlStateStoreOptions): RealmStateStore {
  const { client, dialect } = opts;
  const table = opts.table ?? 'realm_tenant_state';
  const newId = opts.idFactory ?? newUUIDv7;
  const now = opts.clock ?? (() => DEFAULT_AT);
  const ph = (i: number) => (dialect === 'postgres' ? `$${i}` : '?');
  let ready: Promise<void> | null = null;
  const ensure = () => {
    if (opts.ensureSchema === false) return Promise.resolve();
    if (!ready) ready = (async () => { for (const stmt of realmTenantStateDdl(table)) await client.query(stmt); })();
    return ready;
  };

  const rowToRecord = (r: Record<string, unknown>): RealmStateRecord => ({
    id: String(r['id']), tenantId: String(r['tenant_id']), family: String(r['family']), logicalKey: String(r['logical_key']),
    enabled: intToBool(r['enabled']), priority: r['priority'] == null ? null : Number(r['priority']),
    pinnedVersion: r['pinned_version'] == null ? null : Number(r['pinned_version']), updatedAt: String(r['updated_at']),
  });

  return {
    async setState(family, logicalKey, tenantId, patch) {
      await ensure();
      const existing = await this.getOwn(family, logicalKey, tenantId);
      const merged: RealmStateOverlay = {
        enabled: patch.enabled !== undefined ? patch.enabled : (existing?.enabled ?? null),
        priority: patch.priority !== undefined ? patch.priority : (existing?.priority ?? null),
        pinnedVersion: patch.pinnedVersion !== undefined ? patch.pinnedVersion : (existing?.pinnedVersion ?? null),
      };
      const record: RealmStateRecord = { id: existing?.id ?? newId(), tenantId, family, logicalKey, ...merged, updatedAt: now() };
      // An all-null overlay carries no signal → remove any existing row and return the (empty) record.
      if (merged.enabled == null && merged.priority == null && merged.pinnedVersion == null) {
        await this.clearState(family, logicalKey, tenantId);
        return record;
      }
      // Upsert on the unique (tenant, family, key). ON CONFLICT works the same on SQLite and Postgres.
      await client.query(
        `INSERT INTO ${table} (id, tenant_id, family, logical_key, enabled, priority, pinned_version, updated_at)
         VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)}, ${ph(8)})
         ON CONFLICT (tenant_id, family, logical_key) DO UPDATE SET
           enabled = ${dialect === 'postgres' ? 'EXCLUDED' : 'excluded'}.enabled,
           priority = ${dialect === 'postgres' ? 'EXCLUDED' : 'excluded'}.priority,
           pinned_version = ${dialect === 'postgres' ? 'EXCLUDED' : 'excluded'}.pinned_version,
           updated_at = ${dialect === 'postgres' ? 'EXCLUDED' : 'excluded'}.updated_at`,
        [record.id, tenantId, family, logicalKey, boolToInt(merged.enabled), merged.priority, merged.pinnedVersion, record.updatedAt],
      );
      return record;
    },
    async clearState(family, logicalKey, tenantId) {
      await ensure();
      await client.query(`DELETE FROM ${table} WHERE tenant_id = ${ph(1)} AND family = ${ph(2)} AND logical_key = ${ph(3)}`, [tenantId, family, logicalKey]);
    },
    async getOwn(family, logicalKey, tenantId) {
      await ensure();
      const { rows } = await client.query(`SELECT * FROM ${table} WHERE tenant_id = ${ph(1)} AND family = ${ph(2)} AND logical_key = ${ph(3)}`, [tenantId, family, logicalKey]);
      return rows[0] ? rowToRecord(rows[0]) : null;
    },
    async overlaysForKey(family, logicalKey, tenantIds) {
      await ensure();
      const out = new Map<string, RealmStateOverlay>();
      if (tenantIds.length === 0) return out;
      const inList = tenantIds.map((_, i) => ph(i + 3)).join(', ');
      const { rows } = await client.query(
        `SELECT * FROM ${table} WHERE family = ${ph(1)} AND logical_key = ${ph(2)} AND tenant_id IN (${inList})`,
        [family, logicalKey, ...tenantIds],
      );
      for (const r of rows) { const rec = rowToRecord(r); out.set(rec.tenantId, rec); }
      return out;
    },
    async listForTenant(family, tenantId) {
      await ensure();
      const { rows } = await client.query(`SELECT * FROM ${table} WHERE family = ${ph(1)} AND tenant_id = ${ph(2)} ORDER BY logical_key`, [family, tenantId]);
      return rows.map(rowToRecord);
    },
  };
}
