// SPDX-License-Identifier: MIT
/**
 * Postgres-backed StateStore. Phase 4: the whole persist/hydrate machine is shared with the SQLite
 * adapter via one Drizzle implementation — this file just creates the `la_entities` table and wires in
 * the Postgres handle.
 *
 * Connection: give `url` (a connection string; the store opens/closes its own pool) OR `pool` (a shared
 * pool, e.g. from `weaveSharedPostgres`, that the store leaves open — you own its lifecycle).
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PostgresStateStore } from './types.js';
import { pgLaEntities } from './drizzle-state-schema.js';
import { createDrizzleStateStore } from './drizzle-state-store.js';
import { pgExec } from './drizzle-support.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS la_entities (
  entity_type TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, id)
);
CREATE INDEX IF NOT EXISTS idx_la_entities_type_updated ON la_entities(entity_type, updated_at);
`;

export interface WeavePostgresStateStoreOptions {
  /** A Postgres connection string, e.g. `postgresql://user:pass@host:5432/db`. */
  url?: string;
  /** An existing `pg.Pool` to share. When given, the store will NOT close it on `close()`. */
  pool?: Pool;
}

export async function weavePostgresStateStore(
  opts: WeavePostgresStateStoreOptions,
): Promise<PostgresStateStore> {
  if (!opts.pool && !opts.url) {
    throw new Error('weavePostgresStateStore: provide either { url } (a connection string) or a shared { pool }.');
  }
  const ownsPool = !opts.pool;
  const pool = opts.pool ?? new Pool({ connectionString: opts.url });
  await pool.query(MIGRATIONS_SQL);
  const store = createDrizzleStateStore<PostgresStateStore>({
    kind: 'postgres',
    db: drizzle(pool),
    table: pgLaEntities,
    exec: pgExec,
    // Only close the pool if this store opened it (from a `url`); a shared/injected pool is left open.
    close: async () => { if (ownsPool) await pool.end(); },
  });
  await store.initialize();
  return store;
}
