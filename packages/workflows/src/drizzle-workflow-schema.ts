// SPDX-License-Identifier: MIT
/**
 * ONE place that declares every workflow storage table for both SQL dialects (Phase 4).
 *
 * Drizzle deliberately can't share a single table object across databases, so each table is declared
 * twice — a Postgres flavour and a SQLite flavour — from the SAME field intent, sitting side by side so
 * they cannot drift. The only per-dialect differences are the natural ones Drizzle maps to the same JS
 * value: native `jsonb` vs JSON-in-`text`, `bigint` vs `integer` for millisecond timestamps, and
 * `double precision` vs `real` for the rate-limiter's fractional tokens. Text timestamps are plain ISO
 * strings on both, which removes the old `TIMESTAMPTZ`-vs-`TEXT` drift. The shared query logic lives in
 * `drizzle-workflow-stores.ts`.
 */
import { pgTable, text as pgText, jsonb, integer as pgInteger, bigint, doublePrecision, primaryKey as pgPrimaryKey, index as pgIndex } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText, integer as sqliteInteger, real, primaryKey as sqlitePrimaryKey, index as sqliteIndex } from 'drizzle-orm/sqlite-core';

// ─── Step idempotency: key → cached step output ─────────────────────────────────
export const pgIdempotency = pgTable('wf_idempotency', {
  key: pgText('key').primaryKey(),
  outputJson: jsonb('output_json').$type<unknown>().notNull(),
  createdAt: pgText('created_at').notNull(),
});
export const sqliteIdempotency = sqliteTable('wf_idempotency', {
  key: sqliteText('key').primaryKey(),
  outputJson: sqliteText('output_json', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: sqliteText('created_at').notNull(),
});

// ─── Payload store: large step inputs/outputs, keyed `${runId}:${stepId}` ────────
export const pgPayloads = pgTable('wf_payloads', {
  key: pgText('key').primaryKey(),
  runId: pgText('run_id').notNull(),
  dataJson: jsonb('data_json').$type<unknown>().notNull(),
  createdAt: pgText('created_at').notNull(),
}, (t) => [pgIndex('idx_wf_payloads_run').on(t.runId)]);
export const sqlitePayloads = sqliteTable('wf_payloads', {
  key: sqliteText('key').primaryKey(),
  runId: sqliteText('run_id').notNull(),
  dataJson: sqliteText('data_json', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: sqliteText('created_at').notNull(),
}, (t) => [sqliteIndex('idx_wf_payloads_run').on(t.runId)]);

// ─── Step lock: at-most-once step execution (locked → done), keyed (run, step) ───
export const pgStepLocks = pgTable('wf_step_locks', {
  runId: pgText('run_id').notNull(),
  stepId: pgText('step_id').notNull(),
  state: pgText('state').notNull(), // 'locked' | 'done'
  lockedAt: pgText('locked_at').notNull(),
  doneAt: pgText('done_at'),
  outputJson: jsonb('output_json').$type<unknown>(),
}, (t) => [pgPrimaryKey({ columns: [t.runId, t.stepId] }), pgIndex('idx_wf_step_locks_run').on(t.runId)]);
export const sqliteStepLocks = sqliteTable('wf_step_locks', {
  runId: sqliteText('run_id').notNull(),
  stepId: sqliteText('step_id').notNull(),
  state: sqliteText('state').notNull(),
  lockedAt: sqliteText('locked_at').notNull(),
  doneAt: sqliteText('done_at'),
  outputJson: sqliteText('output_json', { mode: 'json' }).$type<unknown>(),
}, (t) => [sqlitePrimaryKey({ columns: [t.runId, t.stepId] }), sqliteIndex('idx_wf_step_locks_run').on(t.runId)]);

// ─── Workflow definitions: full definition in JSON + name/timestamps for lookup ──
export const pgDefinitions = pgTable('wf_definitions', {
  id: pgText('id').primaryKey(),
  name: pgText('name').notNull(),
  payloadJson: jsonb('payload_json').$type<unknown>().notNull(),
  createdAt: pgText('created_at').notNull(),
  updatedAt: pgText('updated_at').notNull(),
}, (t) => [pgIndex('idx_wf_definitions_name').on(t.name)]);
export const sqliteDefinitions = sqliteTable('wf_definitions', {
  id: sqliteText('id').primaryKey(),
  name: sqliteText('name').notNull(),
  payloadJson: sqliteText('payload_json', { mode: 'json' }).$type<unknown>().notNull(),
  createdAt: sqliteText('created_at').notNull(),
  updatedAt: sqliteText('updated_at').notNull(),
}, (t) => [sqliteIndex('idx_wf_definitions_name').on(t.name)]);

// ─── Workflow runs: full run in JSON + scalar columns for filtering ──────────────
export const pgRuns = pgTable('wf_runs', {
  id: pgText('id').primaryKey(),
  workflowId: pgText('workflow_id').notNull(),
  parentRunId: pgText('parent_run_id'),
  status: pgText('status').notNull(),
  tenantId: pgText('tenant_id'),
  startedAt: pgText('started_at').notNull(),
  payloadJson: jsonb('payload_json').$type<unknown>().notNull(),
}, (t) => [
  pgIndex('idx_wf_runs_wf').on(t.workflowId, t.startedAt),
  pgIndex('idx_wf_runs_parent').on(t.parentRunId),
  pgIndex('idx_wf_runs_status').on(t.status),
  pgIndex('idx_wf_runs_tenant').on(t.tenantId),
]);
export const sqliteRuns = sqliteTable('wf_runs', {
  id: sqliteText('id').primaryKey(),
  workflowId: sqliteText('workflow_id').notNull(),
  parentRunId: sqliteText('parent_run_id'),
  status: sqliteText('status').notNull(),
  tenantId: sqliteText('tenant_id'),
  startedAt: sqliteText('started_at').notNull(),
  payloadJson: sqliteText('payload_json', { mode: 'json' }).$type<unknown>().notNull(),
}, (t) => [
  sqliteIndex('idx_wf_runs_wf').on(t.workflowId, t.startedAt),
  sqliteIndex('idx_wf_runs_parent').on(t.parentRunId),
  sqliteIndex('idx_wf_runs_status').on(t.status),
  sqliteIndex('idx_wf_runs_tenant').on(t.tenantId),
]);

// ─── Durable sleeps: a run wakes at a millisecond timestamp ──────────────────────
export const pgSleeps = pgTable('wf_sleeps', {
  runId: pgText('run_id').primaryKey(),
  wakeAt: bigint('wake_at', { mode: 'number' }).notNull(),
  createdAt: pgText('created_at').notNull(),
}, (t) => [pgIndex('idx_wf_sleeps_wake').on(t.wakeAt)]);
export const sqliteSleeps = sqliteTable('wf_sleeps', {
  runId: sqliteText('run_id').primaryKey(),
  wakeAt: sqliteInteger('wake_at').notNull(),
  createdAt: sqliteText('created_at').notNull(),
}, (t) => [sqliteIndex('idx_wf_sleeps_wake').on(t.wakeAt)]);

// ─── Run queue: priority + FIFO queue of pending runs per workflow ───────────────
export const pgRunQueue = pgTable('wf_run_queue', {
  id: pgText('id').primaryKey(),
  runId: pgText('run_id').notNull(),
  workflowId: pgText('workflow_id').notNull(),
  inputJson: jsonb('input_json').$type<Record<string, unknown>>().notNull(),
  priority: pgInteger('priority').notNull(),
  queuedAt: pgText('queued_at').notNull(),
  optsJson: jsonb('opts_json').$type<Record<string, unknown>>().notNull(),
}, (t) => [pgIndex('idx_wf_run_queue_wf').on(t.workflowId, t.priority, t.queuedAt, t.id)]);
export const sqliteRunQueue = sqliteTable('wf_run_queue', {
  id: sqliteText('id').primaryKey(),
  runId: sqliteText('run_id').notNull(),
  workflowId: sqliteText('workflow_id').notNull(),
  inputJson: sqliteText('input_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  priority: sqliteInteger('priority').notNull(),
  queuedAt: sqliteText('queued_at').notNull(),
  optsJson: sqliteText('opts_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
}, (t) => [sqliteIndex('idx_wf_run_queue_wf').on(t.workflowId, t.priority, t.queuedAt, t.id)]);

// ─── Audit log: append-only workflow events ──────────────────────────────────────
export const pgAudit = pgTable('wf_audit_events', {
  id: pgText('id').primaryKey(),
  runId: pgText('run_id').notNull(),
  workflowId: pgText('workflow_id').notNull(),
  type: pgText('type').notNull(),
  timestamp: pgText('timestamp').notNull(),
  payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().notNull(),
}, (t) => [
  pgIndex('idx_wf_audit_run').on(t.runId, t.timestamp, t.id),
  pgIndex('idx_wf_audit_wf').on(t.workflowId, t.timestamp, t.id),
]);
export const sqliteAudit = sqliteTable('wf_audit_events', {
  id: sqliteText('id').primaryKey(),
  runId: sqliteText('run_id').notNull(),
  workflowId: sqliteText('workflow_id').notNull(),
  type: sqliteText('type').notNull(),
  timestamp: sqliteText('timestamp').notNull(),
  payloadJson: sqliteText('payload_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
}, (t) => [
  sqliteIndex('idx_wf_audit_run').on(t.runId, t.timestamp, t.id),
  sqliteIndex('idx_wf_audit_wf').on(t.workflowId, t.timestamp, t.id),
]);

// ─── Rate limiter: one token-bucket row per workflow ─────────────────────────────
export const pgRateLimits = pgTable('wf_rate_limits', {
  workflowId: pgText('workflow_id').primaryKey(),
  tokens: doublePrecision('tokens').notNull(),
  lastRefillMs: bigint('last_refill_ms', { mode: 'number' }).notNull(),
});
export const sqliteRateLimits = sqliteTable('wf_rate_limits', {
  workflowId: sqliteText('workflow_id').primaryKey(),
  tokens: real('tokens').notNull(),
  lastRefillMs: sqliteInteger('last_refill_ms').notNull(),
});

/** The Postgres tables are the reference types the shared query code is written against. */
export type PgIdempotency = typeof pgIdempotency;
export type PgPayloads = typeof pgPayloads;
export type PgStepLocks = typeof pgStepLocks;
export type PgDefinitions = typeof pgDefinitions;
export type PgRuns = typeof pgRuns;
export type PgSleeps = typeof pgSleeps;
export type PgRunQueue = typeof pgRunQueue;
export type PgAudit = typeof pgAudit;
export type PgRateLimits = typeof pgRateLimits;
