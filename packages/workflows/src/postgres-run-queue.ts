/**
 * Postgres-backed WorkflowRunQueue.
 */
import type { Pool } from 'pg';
import { newUUIDv7 } from '@weaveintel/core';
import type { RunQueueEntry, WorkflowRunQueue } from './run-queue.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_run_queue (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  input_json JSONB NOT NULL,
  priority INTEGER NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL,
  opts_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_run_queue_wf ON wf_run_queue(workflow_id, priority DESC, queued_at ASC, id ASC);
`;

export interface WeavePostgresRunQueueOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

interface Row {
  id: string;
  run_id: string;
  workflow_id: string;
  input_json: Record<string, unknown>;
  priority: number;
  queued_at: Date | string;
  opts_json: RunQueueEntry['opts'];
}

function toEntry(r: Row): RunQueueEntry {
  return {
    id: r.id,
    runId: r.run_id,
    workflowId: r.workflow_id,
    input: r.input_json,
    priority: r.priority,
    queuedAt: typeof r.queued_at === 'string' ? r.queued_at : r.queued_at.toISOString(),
    opts: r.opts_json,
  };
}

export async function weavePostgresRunQueue(
  opts: WeavePostgresRunQueueOptions,
): Promise<WorkflowRunQueue> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;
  return {
    async enqueue(entry) {
      const full: RunQueueEntry = { id: newUUIDv7(), queuedAt: new Date().toISOString(), ...entry };
      await pool.query(
        'INSERT INTO wf_run_queue (id, run_id, workflow_id, input_json, priority, queued_at, opts_json) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [full.id, full.runId, full.workflowId, JSON.stringify(full.input), full.priority, full.queuedAt, JSON.stringify(full.opts)],
      );
      return full;
    },
    async dequeue(workflowId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query<Row>(
          'SELECT * FROM wf_run_queue WHERE workflow_id = $1 ORDER BY priority DESC, queued_at ASC, id ASC LIMIT 1 FOR UPDATE SKIP LOCKED',
          [workflowId],
        );
        const row = r.rows[0];
        if (!row) {
          await client.query('COMMIT');
          return null;
        }
        await client.query('DELETE FROM wf_run_queue WHERE id = $1', [row.id]);
        await client.query('COMMIT');
        return toEntry(row);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async remove(entryId) {
      await pool.query('DELETE FROM wf_run_queue WHERE id = $1', [entryId]);
    },
    async size() {
      const r = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM wf_run_queue');
      return Number(r.rows[0]?.n ?? 0);
    },
    async sizeFor(workflowId) {
      const r = await pool.query<{ n: string }>(
        'SELECT COUNT(*) AS n FROM wf_run_queue WHERE workflow_id = $1',
        [workflowId],
      );
      return Number(r.rows[0]?.n ?? 0);
    },
    async listFor(workflowId) {
      const r = await pool.query<Row>(
        'SELECT * FROM wf_run_queue WHERE workflow_id = $1 ORDER BY priority DESC, queued_at ASC, id ASC',
        [workflowId],
      );
      return r.rows.map(toEntry);
    },
    async listAll() {
      const r = await pool.query<Row>(
        'SELECT * FROM wf_run_queue ORDER BY priority DESC, queued_at ASC, id ASC',
      );
      return r.rows.map(toEntry);
    },
  };
}
