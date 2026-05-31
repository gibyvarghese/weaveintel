/**
 * SQLite-backed WorkflowDefinitionStore.
 *
 * Definitions stored as JSON payload in `wf_definitions`. Lookup by id (PK) or
 * by `name` (secondary index) — matching the in-memory adapter's "id-or-key"
 * resolution.
 */
import Database from 'better-sqlite3';
import type { WorkflowDefinition } from '@weaveintel/core';
import type { WorkflowDefinitionStore } from './definition-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_definitions_name ON wf_definitions(name);
`;

export interface WeaveSqliteDefinitionStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

interface Row {
  id: string;
  name: string;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

export function weaveSqliteWorkflowDefinitionStore(
  opts: WeaveSqliteDefinitionStoreOptions = {},
): WorkflowDefinitionStore {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const upsertStmt = db.prepare(`
    INSERT INTO wf_definitions (id, name, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `);
  const listStmt = db.prepare('SELECT payload_json FROM wf_definitions ORDER BY updated_at DESC');
  const getByIdStmt = db.prepare('SELECT payload_json FROM wf_definitions WHERE id = ?');
  const getByNameStmt = db.prepare('SELECT payload_json FROM wf_definitions WHERE name = ? LIMIT 1');
  const deleteStmt = db.prepare('DELETE FROM wf_definitions WHERE id = ?');

  return {
    async list() {
      const rows = listStmt.all() as Pick<Row, 'payload_json'>[];
      return rows.map((r) => JSON.parse(r.payload_json) as WorkflowDefinition);
    },
    async get(idOrKey) {
      const byId = getByIdStmt.get(idOrKey) as Pick<Row, 'payload_json'> | undefined;
      if (byId) return JSON.parse(byId.payload_json) as WorkflowDefinition;
      const byName = getByNameStmt.get(idOrKey) as Pick<Row, 'payload_json'> | undefined;
      return byName ? (JSON.parse(byName.payload_json) as WorkflowDefinition) : null;
    },
    async save(def) {
      const now = new Date().toISOString();
      const saved: WorkflowDefinition = {
        ...def,
        updatedAt: now,
        createdAt: def.createdAt ?? now,
      };
      upsertStmt.run(saved.id, saved.name, JSON.stringify(saved), saved.createdAt, saved.updatedAt);
      return saved;
    },
    async delete(id) {
      deleteStmt.run(id);
    },
  };
}
