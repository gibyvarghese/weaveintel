// SPDX-License-Identifier: MIT
/** Postgres-backed durable memory store. Phase 4: the query logic is shared with the SQLite adapter via
 *  one Drizzle implementation — this file just creates the table and wires in the Postgres handle. */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { type DurableMemoryStore, type MemoryPgConnection, resolveMemoryPool } from './memory-internal.js';
import { pgMemoryEntries } from './drizzle-memory-schema.js';
import { createDrizzleMemoryStore } from './drizzle-memory-store.js';
import { pgExec } from './drizzle-support.js';

/** Connection options for the plain Postgres memory store: a `url` OR a shared `pool` (Phase 2). */
export type PostgresMemoryStoreOptions = MemoryPgConnection;

const MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    payload_json JSONB NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

export function weavePostgresMemoryStore(opts: PostgresMemoryStoreOptions): DurableMemoryStore {
  const { pool, ownsPool } = resolveMemoryPool(opts, (url) => new Pool({ connectionString: url }));
  // Create the schema once, lazily (the factory is synchronous, matching the previous behaviour).
  let ready: Promise<void> | undefined;
  const ensureSchema = () => (ready ??= pool.query(MIGRATIONS_SQL).then(() => undefined));
  return createDrizzleMemoryStore({
    db: drizzle(pool),
    table: pgMemoryEntries,
    exec: pgExec,
    ensureSchema,
    // Only close the pool if this store opened it (from a `url`); a shared/injected pool is left open.
    close: () => (ownsPool ? pool.end() : Promise.resolve()),
  });
}
