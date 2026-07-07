// SPDX-License-Identifier: MIT
/**
 * The trigger tables, declared for both SQL dialects from one field intent (Phase 4).
 *
 * Two tables: `triggers` (one row per trigger, with JSON columns for source/target/filter/inputMap/
 * metadata) and `trigger_invocations` (an append-only audit ledger). Drizzle can't share a single table
 * object across databases, so each is declared twice — Postgres and SQLite — side by side so they can't
 * drift. The only per-dialect differences are the natural ones Drizzle maps to the same JS value:
 * native `jsonb` vs JSON-in-`text`, a real `boolean` vs an integer-boolean, and `bigint` vs `integer`
 * for the millisecond `fired_at`. The on-disk shape matches the old hand-written tables exactly, so
 * existing databases keep working.
 */
import { pgTable, text as pgText, jsonb, integer as pgInteger, bigint, boolean, index as pgIndex } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText, integer as sqliteInteger, index as sqliteIndex } from 'drizzle-orm/sqlite-core';

export const pgTriggers = pgTable('triggers', {
  id: pgText('id').primaryKey(),
  key: pgText('key').notNull().unique(),
  enabled: boolean('enabled').notNull(),
  sourceKind: pgText('source_kind').notNull(),
  sourceConfig: jsonb('source_config').$type<Record<string, unknown>>().notNull(),
  filterExpr: jsonb('filter_expr').$type<{ expression?: unknown }>(),
  targetKind: pgText('target_kind').notNull(),
  targetConfig: jsonb('target_config').$type<Record<string, unknown>>().notNull(),
  inputMap: jsonb('input_map').$type<Record<string, string>>(),
  rateLimitPerMinute: pgInteger('rate_limit_per_minute'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
});
export const sqliteTriggers = sqliteTable('triggers', {
  id: sqliteText('id').primaryKey(),
  key: sqliteText('key').notNull().unique(),
  enabled: sqliteInteger('enabled', { mode: 'boolean' }).notNull(),
  sourceKind: sqliteText('source_kind').notNull(),
  sourceConfig: sqliteText('source_config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  filterExpr: sqliteText('filter_expr', { mode: 'json' }).$type<{ expression?: unknown }>(),
  targetKind: sqliteText('target_kind').notNull(),
  targetConfig: sqliteText('target_config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  inputMap: sqliteText('input_map', { mode: 'json' }).$type<Record<string, string>>(),
  rateLimitPerMinute: sqliteInteger('rate_limit_per_minute'),
  metadata: sqliteText('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
});

export const pgInvocations = pgTable('trigger_invocations', {
  id: pgText('id').primaryKey(),
  triggerId: pgText('trigger_id').notNull(),
  firedAt: bigint('fired_at', { mode: 'number' }).notNull(),
  sourceKind: pgText('source_kind').notNull(),
  status: pgText('status').notNull(),
  targetRef: pgText('target_ref'),
  errorMessage: pgText('error_message'),
  sourceEvent: jsonb('source_event').$type<Record<string, unknown>>(),
}, (t) => [
  pgIndex('idx_trigger_invocations_trigger').on(t.triggerId, t.firedAt, t.id),
  pgIndex('idx_trigger_invocations_status').on(t.status, t.firedAt, t.id),
]);
export const sqliteInvocations = sqliteTable('trigger_invocations', {
  id: sqliteText('id').primaryKey(),
  triggerId: sqliteText('trigger_id').notNull(),
  firedAt: sqliteInteger('fired_at').notNull(),
  sourceKind: sqliteText('source_kind').notNull(),
  status: sqliteText('status').notNull(),
  targetRef: sqliteText('target_ref'),
  errorMessage: sqliteText('error_message'),
  sourceEvent: sqliteText('source_event', { mode: 'json' }).$type<Record<string, unknown>>(),
}, (t) => [
  sqliteIndex('idx_trigger_invocations_trigger').on(t.triggerId, t.firedAt, t.id),
  sqliteIndex('idx_trigger_invocations_status').on(t.status, t.firedAt, t.id),
]);

/** The Postgres tables are the reference types the shared query code is written against. */
export type PgTriggers = typeof pgTriggers;
export type PgInvocations = typeof pgInvocations;
