// SPDX-License-Identifier: MIT
/**
 * The `memory_entries` table, declared for both SQL dialects from one field intent (Phase 4).
 *
 * One row per memory, with the whole entry kept as JSON (native `jsonb` on Postgres, JSON-in-`text` on
 * SQLite — Drizzle maps both back to the same JavaScript object). `updated_at` is plain ISO text on both
 * (removing the old `TIMESTAMPTZ`-vs-`TEXT` drift) and only orders rows; it isn't returned to callers.
 * The on-disk shape matches the old hand-written tables, so existing databases keep working.
 */
import { pgTable, text as pgText, jsonb } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText } from 'drizzle-orm/sqlite-core';
import type { MemoryEntry } from '@weaveintel/core';

export const pgMemoryEntries = pgTable('memory_entries', {
  id: pgText('id').primaryKey(),
  payloadJson: jsonb('payload_json').$type<MemoryEntry>().notNull(),
  updatedAt: pgText('updated_at').notNull(),
});

export const sqliteMemoryEntries = sqliteTable('memory_entries', {
  id: sqliteText('id').primaryKey(),
  payloadJson: sqliteText('payload_json', { mode: 'json' }).$type<MemoryEntry>().notNull(),
  updatedAt: sqliteText('updated_at').notNull(),
});

/** The Postgres table is the reference type the shared query code is written against. */
export type PgMemoryEntries = typeof pgMemoryEntries;
