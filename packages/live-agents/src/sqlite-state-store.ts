// SPDX-License-Identifier: MIT
/**
 * SQLite-backed StateStore. Phase 4: the whole persist/hydrate machine is shared with the Postgres
 * adapter via one Drizzle implementation — this file just creates the `la_entities` table and wires in
 * the SQLite handle. SQLite is the local durable mode (WAL for smoother single-node crash recovery).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SqliteStateStore } from './types.js';
import { sqliteLaEntities, type PgLaEntities } from './drizzle-state-schema.js';
import { createDrizzleStateStore } from './drizzle-state-store.js';
import { sqliteExec } from './drizzle-support.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS la_entities (
  entity_type TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_type, id)
);
CREATE INDEX IF NOT EXISTS idx_la_entities_type_updated ON la_entities(entity_type, updated_at);
`;

export async function weaveSqliteStateStore(opts: { path: string }): Promise<SqliteStateStore> {
  const sqlite = new Database(opts.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(MIGRATIONS_SQL);
  const store = createDrizzleStateStore<SqliteStateStore>({
    kind: 'sqlite',
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteLaEntities as unknown as PgLaEntities,
    exec: sqliteExec,
    close: async () => { sqlite.close(); },
  });
  await store.initialize();
  return store;
}
