// SPDX-License-Identifier: MIT
/**
 * Postgres-backed WorkflowRunQueue. Phase 4: the query logic is shared with the SQLite adapter via one
 * Drizzle implementation — this file creates the table and wires the Postgres handle. Dequeue is a
 * single atomic delete-and-return, so two workers never pop the same entry.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { WorkflowRunQueue } from './run-queue.js';
import { pgRunQueue } from './drizzle-workflow-schema.js';
import { createDrizzleRunQueue, createPgRunQueueDequeue } from './drizzle-workflow-stores.js';
import { pgExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_run_queue (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  input_json JSONB NOT NULL,
  priority INTEGER NOT NULL,
  queued_at TEXT NOT NULL,
  opts_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_run_queue_wf ON wf_run_queue(workflow_id, priority, queued_at, id);
`;

export interface WeavePostgresRunQueueOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresRunQueue(
  opts: WeavePostgresRunQueueOptions,
): Promise<WorkflowRunQueue> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const db = drizzle(opts.pool);
  return createDrizzleRunQueue({ db, table: pgRunQueue, exec: pgExec, dequeue: createPgRunQueueDequeue(db, pgRunQueue) });
}
