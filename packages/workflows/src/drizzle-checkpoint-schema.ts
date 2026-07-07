// SPDX-License-Identifier: MIT
/**
 * ONE conceptual schema for the workflow checkpoint table, expressed for both SQL dialects.
 *
 * --- Why it's shaped this way ---
 * Drizzle, on purpose, does NOT let a single table object target multiple databases — a Postgres table
 * and a SQLite table are different types with different capabilities. So instead of hand-writing the
 * same SQL twice (the old `postgres-checkpoint-store.ts` + `sqlite-checkpoint-store.ts`, which slowly
 * drift apart: `$1` vs `?`, `jsonb` vs text, `NOW()` vs `CURRENT_TIMESTAMP`), we declare BOTH tables
 * here from the SAME field intent — identical column names and shapes, sitting side by side so they
 * can't drift — and write the QUERY logic ONCE against them (see `drizzle-checkpoint-store.ts`).
 *
 * The only deliberate per-dialect difference is how JSON is stored: Postgres gets native `jsonb`,
 * SQLite gets JSON-in-`text`. Drizzle maps both back to the same JavaScript object, so the query code
 * and the returned rows are identical either way. Timestamps are plain ISO `text` in BOTH dialects
 * (the app supplies the value), which removes the old `TIMESTAMPTZ`-vs-`TEXT` drift entirely.
 */
import { pgTable, text as pgText, jsonb, index as pgIndex } from 'drizzle-orm/pg-core';
import { sqliteTable, text as sqliteText, index as sqliteIndex } from 'drizzle-orm/sqlite-core';
import type { WorkflowState } from '@weaveintel/core';

/** Postgres flavour of `wf_checkpoints` (native `jsonb` payload). */
export const pgCheckpoints = pgTable(
  'wf_checkpoints',
  {
    id: pgText('id').primaryKey(),
    runId: pgText('run_id').notNull(),
    workflowId: pgText('workflow_id'),
    stepId: pgText('step_id').notNull(),
    payloadJson: jsonb('payload_json').$type<WorkflowState>().notNull(),
    createdAt: pgText('created_at').notNull(),
  },
  (t) => [pgIndex('idx_wf_checkpoints_run').on(t.runId, t.createdAt, t.id)],
);

/** SQLite flavour of `wf_checkpoints` (JSON stored in `text`). Same columns, same names. */
export const sqliteCheckpoints = sqliteTable(
  'wf_checkpoints',
  {
    id: sqliteText('id').primaryKey(),
    runId: sqliteText('run_id').notNull(),
    workflowId: sqliteText('workflow_id'),
    stepId: sqliteText('step_id').notNull(),
    payloadJson: sqliteText('payload_json', { mode: 'json' }).$type<WorkflowState>().notNull(),
    createdAt: sqliteText('created_at').notNull(),
  },
  (t) => [sqliteIndex('idx_wf_checkpoints_run').on(t.runId, t.createdAt, t.id)],
);

/** The Postgres table type is the reference the shared query code is written against. */
export type CheckpointTable = typeof pgCheckpoints;
