/** Postgres-backed durable memory store. */

import type { MemoryFilter } from '@weaveintel/core';
import { Pool } from 'pg';
import {
  type DurableMemoryStore,
  type MemoryPgConnection,
  applyMemoryQuery,
  parseStoredMemoryRow,
  resolveMemoryPool,
} from './memory-internal.js';

/** Connection options for the plain Postgres memory store: a `url` OR a shared `pool`. */
export type PostgresMemoryStoreOptions = MemoryPgConnection;

export function weavePostgresMemoryStore(opts: PostgresMemoryStoreOptions): DurableMemoryStore {
  const { pool, ownsPool } = resolveMemoryPool(opts, (url) => new Pool({ connectionString: url }));

  // M-22: Gate to ensure the schema is created exactly once per process
  // lifetime, not on every query or write call.
  let schemaReady = false;

  async function ensureSchema(client: import('pg').PoolClient): Promise<void> {
    if (schemaReady) return;
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        payload_json JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    schemaReady = true;
  }

  return {
    async write(_ctx, entries): Promise<void> {
      const client = await pool.connect();
      try {
        await ensureSchema(client);
        await client.query('BEGIN');
        for (const entry of entries) {
          await client.query(
            `
            INSERT INTO memory_entries (id, payload_json, updated_at)
            VALUES ($1, $2::jsonb, NOW())
            ON CONFLICT (id)
            DO UPDATE SET payload_json = EXCLUDED.payload_json, updated_at = NOW()
            `,
            [entry.id, JSON.stringify(entry)],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async query(_ctx, options): Promise<import('@weaveintel/core').MemoryEntry[]> {
      const client = await pool.connect();
      try {
        await ensureSchema(client);
        const result = await client.query<{ payload_json: string }>(
          'SELECT payload_json::text AS payload_json FROM memory_entries ORDER BY updated_at ASC',
        );
        return applyMemoryQuery(result.rows.map((row) => parseStoredMemoryRow(row.payload_json)), options);
      } finally {
        client.release();
      }
    },
    async delete(_ctx, ids): Promise<void> {
      if (ids.length === 0) return;
      const client = await pool.connect();
      try {
        await client.query('DELETE FROM memory_entries WHERE id = ANY($1)', [ids]);
      } finally {
        client.release();
      }
    },
    async clear(_ctx, filter): Promise<void> {
      // L-25: server-side filtered DELETE using Postgres JSON operators.
      const conditions: string[] = [];
      const params: unknown[] = [];
      let p = 1;

      if (filter?.tenantId) { conditions.push(`payload_json->>'tenantId' = $${p++}`); params.push(filter.tenantId); }
      if (filter?.userId)   { conditions.push(`payload_json->>'userId' = $${p++}`);   params.push(filter.userId); }
      if (filter?.sessionId){ conditions.push(`payload_json->>'sessionId' = $${p++}`); params.push(filter.sessionId); }
      if (filter?.types?.length) {
        conditions.push(`payload_json->>'type' = ANY($${p++})`);
        params.push(filter.types);
      }
      if (filter?.after)  { conditions.push(`payload_json->>'createdAt' > $${p++}`); params.push(filter.after); }
      if (filter?.before) { conditions.push(`payload_json->>'createdAt' < $${p++}`); params.push(filter.before); }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const client = await pool.connect();
      try {
        await client.query(`DELETE FROM memory_entries ${where}`, params);
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      // Only close the pool if this store opened it (from a `url`). An injected/shared
      // pool is owned by the caller (e.g. weaveSharedPostgres) and left untouched.
      if (ownsPool) await pool.end();
    },
  };
}
