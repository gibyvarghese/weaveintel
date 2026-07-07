// SPDX-License-Identifier: MIT
/**
 * The `la_entities` table, declared for both SQL dialects from one field intent (Phase 4).
 *
 * The live-agents state store keeps every entity (mesh, agent, contract, heartbeat tick, …) as a JSON
 * snapshot in ONE table keyed by `(entity_type, id)`. Postgres uses native `jsonb`, SQLite uses
 * JSON-in-`text`; Drizzle maps both back to the same JavaScript object. `updated_at` is plain ISO text
 * on both (removing the old `TIMESTAMPTZ`-vs-`TEXT` drift) and only orders rows during hydration. The
 * on-disk shape matches the old hand-written table, so existing databases keep working.
 */
import { pgTable, text as pgText, jsonb, primaryKey as pgPrimaryKey, index as pgIndex } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText, primaryKey as sqlitePrimaryKey, index as sqliteIndex } from 'drizzle-orm/sqlite-core';

export const pgLaEntities = pgTable('la_entities', {
  entityType: pgText('entity_type').notNull(),
  id: pgText('id').notNull(),
  payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().notNull(),
  updatedAt: pgText('updated_at').notNull(),
}, (t) => [
  pgPrimaryKey({ columns: [t.entityType, t.id] }),
  pgIndex('idx_la_entities_type_updated').on(t.entityType, t.updatedAt),
]);

export const sqliteLaEntities = sqliteTable('la_entities', {
  entityType: sqliteText('entity_type').notNull(),
  id: sqliteText('id').notNull(),
  payloadJson: sqliteText('payload_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  updatedAt: sqliteText('updated_at').notNull(),
}, (t) => [
  sqlitePrimaryKey({ columns: [t.entityType, t.id] }),
  sqliteIndex('idx_la_entities_type_updated').on(t.entityType, t.updatedAt),
]);

/** The Postgres table is the reference type the shared query code is written against. */
export type PgLaEntities = typeof pgLaEntities;
