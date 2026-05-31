/**
 * SQLite-backed WorkflowRunQueue (priority queue).
 * Single table `wf_run_queue` keyed by entry id; sorted by (priority DESC, queued_at ASC).
 */
import Database from 'better-sqlite3';
import { newUUIDv7 } from '@weaveintel/core';
import type { RunQueueEntry, WorkflowRunQueue } from './run-queue.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_run_queue (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  priority INTEGER NOT NULL,
  queued_at TEXT NOT NULL,
  opts_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_run_queue_wf ON wf_run_queue(workflow_id, priority DESC, queued_at ASC, id ASC);
`;

export interface WeaveSqliteRunQueueOptions {
  database?: Database.Database;
  databasePath?: string;
}

interface Row {
  id: string;
  run_id: string;
  workflow_id: string;
  input_json: string;
  priority: number;
  queued_at: string;
  opts_json: string;
}

function toEntry(r: Row): RunQueueEntry {
  return {
    id: r.id,
    runId: r.run_id,
    workflowId: r.workflow_id,
    input: JSON.parse(r.input_json) as Record<string, unknown>,
    priority: r.priority,
    queuedAt: r.queued_at,
    opts: JSON.parse(r.opts_json) as RunQueueEntry['opts'],
  };
}

export function weaveSqliteRunQueue(opts: WeaveSqliteRunQueueOptions = {}): WorkflowRunQueue {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const insert = db.prepare(
    'INSERT INTO wf_run_queue (id, run_id, workflow_id, input_json, priority, queued_at, opts_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const selectNext = db.prepare(
    'SELECT * FROM wf_run_queue WHERE workflow_id = ? ORDER BY priority DESC, queued_at ASC, id ASC LIMIT 1',
  );
  const deleteById = db.prepare('DELETE FROM wf_run_queue WHERE id = ?');
  const countAll = db.prepare('SELECT COUNT(*) AS n FROM wf_run_queue');
  const countFor = db.prepare('SELECT COUNT(*) AS n FROM wf_run_queue WHERE workflow_id = ?');
  const listFor = db.prepare(
    'SELECT * FROM wf_run_queue WHERE workflow_id = ? ORDER BY priority DESC, queued_at ASC, id ASC',
  );
  const listAll = db.prepare(
    'SELECT * FROM wf_run_queue ORDER BY priority DESC, queued_at ASC, id ASC',
  );

  return {
    async enqueue(entry) {
      const full: RunQueueEntry = {
        id: newUUIDv7(),
        queuedAt: new Date().toISOString(),
        ...entry,
      };
      insert.run(
        full.id,
        full.runId,
        full.workflowId,
        JSON.stringify(full.input),
        full.priority,
        full.queuedAt,
        JSON.stringify(full.opts),
      );
      return full;
    },
    async dequeue(workflowId) {
      const row = selectNext.get(workflowId) as Row | undefined;
      if (!row) return null;
      deleteById.run(row.id);
      return toEntry(row);
    },
    async remove(entryId) {
      deleteById.run(entryId);
    },
    async size() {
      return (countAll.get() as { n: number }).n;
    },
    async sizeFor(workflowId) {
      return (countFor.get(workflowId) as { n: number }).n;
    },
    async listFor(workflowId) {
      return (listFor.all(workflowId) as Row[]).map(toEntry);
    },
    async listAll() {
      return (listAll.all() as Row[]).map(toEntry);
    },
  };
}
