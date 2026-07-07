// SPDX-License-Identifier: MIT
/** SQLite-backed durable memory store. Phase 4: the query logic is shared with the Postgres adapter via
 *  one Drizzle implementation — this file just creates the table and wires in the SQLite handle. */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { DurableMemoryStore } from './memory-internal.js';
import { sqliteMemoryEntries, type PgMemoryEntries } from './drizzle-memory-schema.js';
import { createDrizzleMemoryStore } from './drizzle-memory-store.js';
import { sqliteExec } from './drizzle-support.js';

const MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

export function weaveSqliteMemoryStore(opts: { path: string }): DurableMemoryStore {
  const sqlite = new Database(opts.path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleMemoryStore({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteMemoryEntries as unknown as PgMemoryEntries,
    exec: sqliteExec,
    ensureSchema: () => Promise.resolve(), // created synchronously above
    close: () => { sqlite.close(); return Promise.resolve(); },
  });
}
