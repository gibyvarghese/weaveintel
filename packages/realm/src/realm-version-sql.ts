// SPDX-License-Identifier: MIT
/**
 * SQL-backed realm version log — one implementation for SQLite and Postgres over the same `SqlClient`
 * seam the config store uses. Append-only; content-addressed (a repeat publish of identical content is
 * a no-op). No recursive SQL, so both engines behave identically.
 */
import { newUUIDv7 } from '@weaveintel/core';
import { computeContentHash } from './realm-record.js';
import type { Payload } from './realm-store.js';
import type { SqlClient, SqlDialect } from './realm-store-sql.js';
import type { PublishInput, RealmVersion, RealmVersionLog } from './realm-version.js';

export interface SqlVersionLogOptions {
  readonly client: SqlClient;
  readonly dialect: SqlDialect;
  readonly table?: string;
  readonly ensureSchema?: boolean;
  readonly idFactory?: () => string;
}

/** Portable DDL for the version log. All TEXT/INTEGER; timestamps set in code, not by DB defaults. */
export function realmVersionsDdl(table = 'realm_versions'): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
      id            TEXT PRIMARY KEY,
      family        TEXT NOT NULL,
      logical_key   TEXT NOT NULL,
      version       INTEGER NOT NULL,
      content_hash  TEXT NOT NULL,
      payload       TEXT NOT NULL,
      published_by  TEXT,
      note          TEXT,
      published_at  TEXT NOT NULL
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_${table}_key_version ON ${table}(family, logical_key, version)`,
    `CREATE INDEX IF NOT EXISTS ix_${table}_family_key ON ${table}(family, logical_key)`,
  ];
}

const DEFAULT_AT = '1970-01-01T00:00:00.000Z';

export function createSqlVersionLog<T extends Payload = Payload>(opts: SqlVersionLogOptions): RealmVersionLog<T> {
  const { client, dialect } = opts;
  const table = opts.table ?? 'realm_versions';
  const newId = opts.idFactory ?? newUUIDv7;
  const ph = (i: number) => (dialect === 'postgres' ? `$${i}` : '?');
  let ready: Promise<void> | null = null;
  const ensure = () => {
    if (opts.ensureSchema === false) return Promise.resolve();
    if (!ready) ready = (async () => { for (const stmt of realmVersionsDdl(table)) await client.query(stmt); })();
    return ready;
  };

  const rowToVersion = (r: Record<string, unknown>): RealmVersion<T> => ({
    id: String(r['id']),
    family: String(r['family']),
    logicalKey: String(r['logical_key']),
    version: Number(r['version']),
    contentHash: String(r['content_hash']),
    payload: JSON.parse(String(r['payload'])) as T,
    publishedAt: String(r['published_at']),
    ...(r['published_by'] != null ? { publishedBy: String(r['published_by']) } : {}),
    ...(r['note'] != null ? { note: String(r['note']) } : {}),
  });

  return {
    async append(input: PublishInput<T>) {
      await ensure();
      const contentHash = computeContentHash(input.payload);
      const latest = await this.latest(input.family, input.logicalKey);
      if (latest && latest.contentHash === contentHash) return latest; // content-addressed no-op
      const version = (latest?.version ?? 0) + 1;
      const id = newId();
      await client.query(
        `INSERT INTO ${table} (id, family, logical_key, version, content_hash, payload, published_by, note, published_at)
         VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)}, ${ph(8)}, ${ph(9)})`,
        [id, input.family, input.logicalKey, version, contentHash, JSON.stringify(input.payload),
          input.publishedBy ?? null, input.note ?? null, input.at ?? DEFAULT_AT],
      );
      return {
        id, family: input.family, logicalKey: input.logicalKey, version, contentHash,
        payload: input.payload, publishedAt: input.at ?? DEFAULT_AT,
        ...(input.publishedBy !== undefined ? { publishedBy: input.publishedBy } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      };
    },
    async latest(family, logicalKey) {
      await ensure();
      const { rows } = await client.query(
        `SELECT * FROM ${table} WHERE family = ${ph(1)} AND logical_key = ${ph(2)} ORDER BY version DESC LIMIT 1`,
        [family, logicalKey],
      );
      return rows[0] ? rowToVersion(rows[0]) : null;
    },
    async history(family, logicalKey) {
      await ensure();
      const { rows } = await client.query(
        `SELECT * FROM ${table} WHERE family = ${ph(1)} AND logical_key = ${ph(2)} ORDER BY version DESC`,
        [family, logicalKey],
      );
      return rows.map(rowToVersion);
    },
    async at(family, logicalKey, version) {
      await ensure();
      const { rows } = await client.query(
        `SELECT * FROM ${table} WHERE family = ${ph(1)} AND logical_key = ${ph(2)} AND version = ${ph(3)}`,
        [family, logicalKey, version],
      );
      return rows[0] ? rowToVersion(rows[0]) : null;
    },
    async latestAll(family) {
      await ensure();
      const { rows } = await client.query(
        `SELECT * FROM ${table} WHERE family = ${ph(1)} ORDER BY logical_key, version DESC`,
        [family],
      );
      const out = new Map<string, RealmVersion<T>>();
      for (const r of rows) { const v = rowToVersion(r); if (!out.has(v.logicalKey)) out.set(v.logicalKey, v); }
      return out;
    },
  };
}
