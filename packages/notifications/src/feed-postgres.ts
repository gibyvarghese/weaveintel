// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notifications — the Postgres adapter for the {@link NotificationFeedStore} port.
 *
 * --- For someone new to this ---
 * This is the durable 🔔 inbox, backed by Postgres. The package already defines the port (the one
 * doorway to the feed) and an in-memory version for tests; this file is the real, persistent one. Both
 * go through the identical port and both pass the shared contract ({@link notificationFeedStoreContract}),
 * so a consuming app can move its notification inbox onto this adapter and trust the behaviour is the
 * same. That's Phase 3 of the persistence review: the SQL lives here, behind the port.
 *
 * "Fan-out on write" means we store ONE row per recipient up front, so showing the inbox is a cheap
 * read and the unread badge is one `COUNT`. "Dedupe" means a stable key stops the same event creating
 * two rows if the delivery pipeline runs twice (it's at-least-once by design) — enforced by a partial
 * unique index on `(principal_id, dedupe_key)`. Every value is a bound parameter, so hostile content is
 * stored as data. Tables are created on first use — no migration step to run first.
 *
 * You hand in a `pg.Pool` (or pool-shaped client) — e.g. the shared pool from `weaveSharedPostgres` —
 * so your whole runtime shares one connection.
 */

import type { Pool } from 'pg';
import type { NotificationFeedStore, FeedNotification, FeedListOptions } from './feed.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PostgresFeedStoreOptions {
  /** A `pg.Pool` (or pool-shaped client). Share one across your app — e.g. from `weaveSharedPostgres`. */
  readonly pool: Pool;
  /** Table to store feed rows in. Validated as a plain identifier. Default `notification_feed`. */
  readonly table?: string;
  /** Clock for read timestamps (ms epoch). Injectable for deterministic tests. Default `Date.now`. */
  readonly now?: () => number;
  /** Skip `CREATE TABLE IF NOT EXISTS` on first use (e.g. when you manage the schema yourself). */
  readonly ensureSchema?: boolean;
}

function mapRow(r: Record<string, unknown>): FeedNotification {
  const out: FeedNotification = {
    id: String(r['id']),
    tenantId: String(r['tenant_id']),
    principalId: String(r['principal_id']),
    category: String(r['category']),
    title: String(r['title']),
    priority: r['priority'] as FeedNotification['priority'],
    createdAt: Number(r['created_at']),
    readAt: r['read_at'] === null || r['read_at'] === undefined ? null : Number(r['read_at']),
  };
  if (r['body'] != null) out.body = String(r['body']);
  if (r['deep_link'] != null) out.deepLink = String(r['deep_link']);
  if (r['dedupe_key'] != null) out.dedupeKey = String(r['dedupe_key']);
  return out;
}

/**
 * Build a Postgres-backed {@link NotificationFeedStore}. Pass a `pg.Pool` (share one across your app).
 *
 * @example
 * ```ts
 * import pg from 'pg';
 * const feed = createPostgresNotificationFeedStore({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
 * await feed.append({ id: 'n1', tenantId: 't1', principalId: 'alice', category: 'run', title: 'Run finished', priority: 'normal', createdAt: Date.now(), readAt: null });
 * await feed.unreadCount('t1', 'alice'); // → 1
 * ```
 */
export function createPostgresNotificationFeedStore(opts: PostgresFeedStoreOptions): NotificationFeedStore {
  const pool = opts.pool;
  const table = opts.table ?? 'notification_feed';
  if (!IDENTIFIER.test(table)) {
    throw new Error(`createPostgresNotificationFeedStore: invalid table name "${table}" (letters, numbers and underscores only).`);
  }
  const now = opts.now ?? (() => Date.now());

  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (opts.ensureSchema === false) return Promise.resolve();
    return (ready ??= pool
      .query(
        `CREATE TABLE IF NOT EXISTS ${table} (
           id TEXT PRIMARY KEY,
           tenant_id TEXT NOT NULL,
           principal_id TEXT NOT NULL,
           category TEXT NOT NULL,
           title TEXT NOT NULL,
           body TEXT,
           deep_link TEXT,
           priority TEXT NOT NULL,
           created_at BIGINT NOT NULL,
           read_at BIGINT,
           dedupe_key TEXT
         );
         CREATE INDEX IF NOT EXISTS ${table}_owner_idx ON ${table} (tenant_id, principal_id, created_at DESC);
         CREATE UNIQUE INDEX IF NOT EXISTS ${table}_dedupe_idx ON ${table} (principal_id, dedupe_key) WHERE dedupe_key IS NOT NULL;`,
      )
      .then(() => undefined));
  };

  const insertCols = `(id, tenant_id, principal_id, category, title, body, deep_link, priority, created_at, read_at, dedupe_key)`;
  const insertVals = (n: FeedNotification): unknown[] => [
    n.id, n.tenantId, n.principalId, n.category, n.title, n.body ?? null, n.deepLink ?? null,
    n.priority, n.createdAt, n.readAt ?? null, n.dedupeKey ?? null,
  ];

  return {
    async append(n) {
      await ensureSchema();
      if (n.dedupeKey) {
        // Idempotent on (principal_id, dedupe_key): a second append with the same key returns the
        // EXISTING row instead of inserting a duplicate (the at-least-once safeguard).
        const { rows } = await pool.query(
          `INSERT INTO ${table} ${insertCols} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (principal_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING *`,
          insertVals(n),
        );
        if (rows.length) return n; // freshly inserted
        const existing = await pool.query(
          `SELECT * FROM ${table} WHERE principal_id = $1 AND dedupe_key = $2`, [n.principalId, n.dedupeKey],
        );
        return existing.rows.length ? mapRow(existing.rows[0]!) : n;
      }
      await pool.query(
        `INSERT INTO ${table} ${insertCols} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        insertVals(n),
      );
      return n;
    },

    async list(tenantId, principalId, listOpts?: FeedListOptions) {
      await ensureSchema();
      const params: unknown[] = [tenantId, principalId];
      let sql = `SELECT * FROM ${table} WHERE tenant_id = $1 AND principal_id = $2`;
      if (listOpts?.unreadOnly) sql += ` AND read_at IS NULL`;
      sql += ` ORDER BY created_at DESC`;
      if (typeof listOpts?.limit === 'number') { params.push(listOpts.limit); sql += ` LIMIT $${params.length}`; }
      const { rows } = await pool.query(sql, params);
      return rows.map(mapRow);
    },

    async unreadCount(tenantId, principalId) {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS c FROM ${table} WHERE tenant_id = $1 AND principal_id = $2 AND read_at IS NULL`,
        [tenantId, principalId],
      );
      return Number(rows[0]!['c']);
    },

    async markRead(tenantId, principalId, id) {
      await ensureSchema();
      const { rowCount } = await pool.query(
        `UPDATE ${table} SET read_at = $4 WHERE tenant_id = $1 AND principal_id = $2 AND id = $3 AND read_at IS NULL`,
        [tenantId, principalId, id, now()],
      );
      return (rowCount ?? 0) > 0;
    },

    async markAllRead(tenantId, principalId) {
      await ensureSchema();
      const { rowCount } = await pool.query(
        `UPDATE ${table} SET read_at = $3 WHERE tenant_id = $1 AND principal_id = $2 AND read_at IS NULL`,
        [tenantId, principalId, now()],
      );
      return rowCount ?? 0;
    },
  };
}
