/**
 * Postgres-backed WorkflowDefinitionStore.
 */
import type { Pool } from 'pg';
import type { WorkflowDefinition } from '@weaveintel/core';
import type { WorkflowDefinitionStore } from './definition-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_definitions_name ON wf_definitions(name);
`;

export interface WeavePostgresDefinitionStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

interface Row { payload_json: WorkflowDefinition }

export async function weavePostgresWorkflowDefinitionStore(
  opts: WeavePostgresDefinitionStoreOptions,
): Promise<WorkflowDefinitionStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;

  return {
    async list() {
      const r = await pool.query<Row>('SELECT payload_json FROM wf_definitions ORDER BY updated_at DESC');
      return r.rows.map((x) => x.payload_json);
    },
    async get(idOrKey) {
      const byId = await pool.query<Row>('SELECT payload_json FROM wf_definitions WHERE id = $1', [idOrKey]);
      if (byId.rows[0]) return byId.rows[0].payload_json;
      const byName = await pool.query<Row>(
        'SELECT payload_json FROM wf_definitions WHERE name = $1 LIMIT 1', [idOrKey],
      );
      return byName.rows[0]?.payload_json ?? null;
    },
    async save(def) {
      const now = new Date().toISOString();
      const saved: WorkflowDefinition = {
        ...def,
        updatedAt: now,
        createdAt: def.createdAt ?? now,
      };
      await pool.query(
        `INSERT INTO wf_definitions (id, name, payload_json, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           payload_json = EXCLUDED.payload_json,
           updated_at = EXCLUDED.updated_at`,
        [saved.id, saved.name, JSON.stringify(saved), saved.createdAt, saved.updatedAt],
      );
      return saved;
    },
    async delete(id) {
      await pool.query('DELETE FROM wf_definitions WHERE id = $1', [id]);
    },
  };
}
