// SPDX-License-Identifier: MIT
/**
 * The durable memory store, implemented ONCE against Drizzle and reused for both Postgres and SQLite
 * (Phase 4). No raw SQL, so the classic per-dialect drift (`$1` vs `?`, `jsonb` vs text, hand-rolled
 * JSON parsing, `json_extract` vs `->>`) can't happen. The thin `weavePostgresMemoryStore` /
 * `weaveSqliteMemoryStore` factories wrap this with the right Drizzle handle + exec adapter.
 *
 * Reading and filtering keeps the existing design: load the rows and rank/filter them in JS with the
 * shared `applyMemoryQuery` (the same code the other backends use). `clear(filter)` uses the same
 * matcher, so what gets deleted is identical on both databases.
 */
import { asc, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MemoryEntry, MemoryFilter } from '@weaveintel/core';
import { type DurableMemoryStore, applyMemoryQuery } from './memory-internal.js';
import type { DrizzleExec } from './drizzle-support.js';
import { monotonicIso } from './drizzle-support.js';
import type { PgMemoryEntries } from './drizzle-memory-schema.js';

/** The same filter the SQL `clear()` used to apply server-side — now applied in one place, both DBs. */
function matchesFilter(e: MemoryEntry, f: MemoryFilter): boolean {
  if (f.tenantId && e.tenantId !== f.tenantId) return false;
  if (f.userId && e.userId !== f.userId) return false;
  if (f.sessionId && e.sessionId !== f.sessionId) return false;
  if (f.types?.length && !f.types.includes(e.type)) return false;
  if (f.after && !(e.createdAt > f.after)) return false;
  if (f.before && !(e.createdAt < f.before)) return false;
  return true;
}

export interface DrizzleMemoryStoreDeps {
  db: NodePgDatabase;
  table: PgMemoryEntries;
  exec: DrizzleExec;
  /** Create the table on first use (memoised). No-op for SQLite (created synchronously at construction). */
  ensureSchema: () => Promise<void>;
  /** Close the underlying handle — end the pool (if owned) or close the SQLite database. */
  close: () => Promise<void>;
  now?: () => string;
}

export function createDrizzleMemoryStore(deps: DrizzleMemoryStoreDeps): DurableMemoryStore {
  const { db, table, exec, ensureSchema } = deps;
  const now = deps.now ?? monotonicIso();

  return {
    async write(_ctx, entries) {
      if (entries.length === 0) return;
      await ensureSchema();
      // De-dupe within a batch (last wins) so a single ON CONFLICT statement can't hit a row twice.
      const byId = new Map<string, MemoryEntry>();
      for (const e of entries) byId.set(e.id, e);
      const rows = [...byId.values()].map((e) => ({ id: e.id, payloadJson: e, updatedAt: now() }));
      await exec.run(
        db.insert(table).values(rows).onConflictDoUpdate({
          target: table.id,
          set: { payloadJson: sql`excluded.payload_json`, updatedAt: sql`excluded.updated_at` },
        }),
      );
    },

    async query(_ctx, options) {
      await ensureSchema();
      const rows = await exec.all<{ payloadJson: MemoryEntry }>(
        db.select({ payloadJson: table.payloadJson }).from(table).orderBy(asc(table.updatedAt)),
      );
      return applyMemoryQuery(rows.map((r) => r.payloadJson), options);
    },

    async delete(_ctx, ids) {
      if (ids.length === 0) return;
      await ensureSchema();
      await exec.run(db.delete(table).where(inArray(table.id, ids)));
    },

    async clear(_ctx, filter) {
      await ensureSchema();
      if (!filter || Object.keys(filter).length === 0) {
        await exec.run(db.delete(table)); // clear everything
        return;
      }
      const rows = await exec.all<{ payloadJson: MemoryEntry }>(db.select({ payloadJson: table.payloadJson }).from(table));
      const ids = rows.map((r) => r.payloadJson).filter((e) => matchesFilter(e, filter)).map((e) => e.id);
      if (ids.length) await exec.run(db.delete(table).where(inArray(table.id, ids)));
    },

    async close() {
      await deps.close();
    },
  };
}
