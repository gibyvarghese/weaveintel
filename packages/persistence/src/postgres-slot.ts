// SPDX-License-Identifier: MIT
/**
 * Postgres-backed `RuntimePersistenceSlot` — the durable key/value slot the runtime uses for things
 * like the dead-letter queue, cost meter, and step-idempotency, now on Postgres (parity with the
 * SQLite slot in `runtime-slot.ts`).
 *
 * This is deliberately driver-agnostic: instead of hard-depending on `pg`, it takes a tiny injected
 * `SqlClient` (a `query(text, params)` method — which `pg.Pool` / `pg.Client` satisfy directly). So
 * this package stays light, and you can point it at a plain Pool, a pooled/proxied client, a
 * serverless driver (Neon), or a test container without any code change here.
 *
 * Everything is parameterised (`$1`, `$2`, …) — keys and values are never concatenated into SQL, so a
 * key or value containing quotes, semicolons, or `DROP TABLE` is stored as data, never executed. The
 * table name is the only interpolated identifier and is validated against a strict allow-list.
 */

import type { RuntimePersistenceSlot, RuntimeKvStore } from '@weaveintel/core';

/** The minimal Postgres surface the slot needs. `pg.Pool` and `pg.Client` both satisfy this. */
export interface SqlClient {
  query(text: string, params?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PostgresRuntimePersistenceOptions {
  /** A Postgres client — e.g. `new pg.Pool({ connectionString })`. */
  readonly client: SqlClient;
  /** Table to store the key/value rows in. Validated as a plain identifier. Default `weave_runtime_kv`. */
  readonly table?: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse the `expires_at` column (Postgres returns BIGINT as a string) into a number or null. */
function toExpiry(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
const alive = (expiresAt: number | null): boolean => expiresAt === null || expiresAt > Date.now();

/**
 * A Postgres-backed `RuntimePersistenceSlot`. TTL is enforced lazily on read/list (a row past its
 * `expires_at` is treated as absent and cleaned up), matching the in-memory and SQLite slots.
 *
 * @example
 * ```ts
 * import pg from 'pg';
 * import { weavePostgresPersistence } from '@weaveintel/persistence';
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const slot = weavePostgresPersistence({ client: pool });
 * await slot.kv.set('cost:tenant-42', '1200', { ttlMs: 86_400_000 });
 * await slot.kv.get('cost:tenant-42'); // → '1200'
 * ```
 */
export function weavePostgresPersistence(opts: PostgresRuntimePersistenceOptions): RuntimePersistenceSlot {
  const table = opts.table ?? 'weave_runtime_kv';
  if (!IDENTIFIER.test(table)) {
    throw new Error(`weavePostgresPersistence: invalid table name "${table}" (letters, numbers and underscores only)`);
  }
  const client = opts.client;

  // Create the table once, lazily, and share the promise across concurrent first calls.
  let ready: Promise<void> | undefined;
  const ensureTable = (): Promise<void> =>
    (ready ??= client
      .query(`CREATE TABLE IF NOT EXISTS ${table} (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at BIGINT)`)
      .then(() => undefined));

  const kv: RuntimeKvStore = {
    async get(key) {
      await ensureTable();
      const { rows } = await client.query(`SELECT v, expires_at FROM ${table} WHERE k = $1`, [key]);
      if (!rows.length) return undefined;
      const row = rows[0]!;
      if (!alive(toExpiry(row['expires_at']))) {
        await client.query(`DELETE FROM ${table} WHERE k = $1`, [key]);
        return undefined;
      }
      return String(row['v']);
    },

    async set(key, value, options) {
      await ensureTable();
      const expiresAt = options?.ttlMs && options.ttlMs > 0 ? Date.now() + options.ttlMs : null;
      await client.query(
        `INSERT INTO ${table} (k, v, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, expires_at = EXCLUDED.expires_at`,
        [key, value, expiresAt],
      );
    },

    async delete(key) {
      await ensureTable();
      const { rows } = await client.query(`DELETE FROM ${table} WHERE k = $1 RETURNING k`, [key]);
      return rows.length > 0;
    },

    async list(prefix) {
      await ensureTable();
      // Postgres TEXT comparison is COLLATION-aware (locale-ordered), unlike SQLite's byte order — so
      // we match the prefix with `starts_with` (a byte-prefix check, not collation-sensitive) and sort
      // with `COLLATE "C"` (byte order). This makes list() byte-for-byte identical to the SQLite slot.
      const { rows } = await client.query(
        `SELECT k, v, expires_at FROM ${table} WHERE starts_with(k, $1) ORDER BY k COLLATE "C" ASC`,
        [prefix],
      );
      const out: { key: string; value: string }[] = [];
      const expired: string[] = [];
      for (const r of rows) {
        if (!alive(toExpiry(r['expires_at']))) { expired.push(String(r['k'])); continue; }
        out.push({ key: String(r['k']), value: String(r['v']) });
      }
      // Best-effort lazy cleanup of anything we found expired (never blocks the read).
      if (expired.length) {
        void client.query(`DELETE FROM ${table} WHERE k = ANY($1)`, [expired]).catch(() => {});
      }
      return out;
    },
  };

  return { kind: 'postgres', kv };
}
