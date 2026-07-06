/**
 * PostgreSQL + pgvector backed durable memory store.
 *
 * Uses Reciprocal Rank Fusion (RRF) to blend vector similarity, full-text
 * search, and optional graph-retrieval signals into a single ranked result.
 *
 * Prerequisites
 * -------------
 * PostgreSQL 12+ with the pgvector extension:
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *
 * The `pg` package is already a dependency of `@weaveintel/memory`.
 */

import type { MemoryEntry, MemoryType, MemoryQuery, ExecutionContext } from '@weaveintel/core';
import type { GraphRetriever } from './index.js';
import { Pool } from 'pg';
import {
  type DurableMemoryStore,
  type MemoryPgConnection,
  computeImportance,
  resolveMemoryPool,
} from './memory-internal.js';

export interface PgVectorMemoryStoreOptions extends MemoryPgConnection {
  /** Embedding vector dimensions. Must match your model. Defaults to 1536. */
  dimensions?: number;
  /** Table name. Defaults to 'memory_vec'. */
  tableName?: string;
  /** ANN index type. Defaults to 'hnsw'. */
  indexType?: 'hnsw' | 'ivfflat' | 'none';
  /** IVFFlat list count (only when indexType is 'ivfflat'). Defaults to 100. */
  ivfLists?: number;
  /** Distance metric. Defaults to 'cosine'. */
  distanceMetric?: 'cosine' | 'l2' | 'inner';
  /** Optional graph retriever for a third hybrid-search signal. */
  graphRetriever?: GraphRetriever;
}

function pgVectorMetricConfig(metric: 'cosine' | 'l2' | 'inner'): {
  operator: string;
  indexOps: string;
  toScore: (distanceExpr: string) => string;
} {
  switch (metric) {
    case 'cosine':
      return { operator: '<=>', indexOps: 'vector_cosine_ops', toScore: (d) => `(1.0 - ${d})` };
    case 'l2':
      return { operator: '<->', indexOps: 'vector_l2_ops', toScore: (d) => `(1.0 / (1.0 + ${d}))` };
    case 'inner':
      return { operator: '<#>', indexOps: 'vector_ip_ops', toScore: (d) => `(-(${d}))` };
  }
}

function toVectorLiteral(embedding: readonly number[]): string {
  return `[${Array.from(embedding).join(',')}]`;
}

function fromVectorLiteral(s: string): readonly number[] {
  return JSON.parse(s) as number[];
}

function buildFilterSQL(
  query: MemoryQuery,
  startIdx: number,
): { sql: string; params: unknown[] } {
  const conditions: string[] = ['(expires_at IS NULL OR expires_at > NOW())'];
  const params: unknown[] = [];
  let idx = startIdx;

  if (query.type) {
    conditions.push(`type = $${idx++}`);
    params.push(query.type);
  }
  const f = query.filter;
  if (f?.tenantId) { conditions.push(`tenant_id = $${idx++}`); params.push(f.tenantId); }
  if (f?.userId)   { conditions.push(`user_id = $${idx++}`);   params.push(f.userId); }
  if (f?.sessionId){ conditions.push(`session_id = $${idx++}`); params.push(f.sessionId); }
  if (f?.types && f.types.length > 0) {
    conditions.push(`type = ANY($${idx++}::text[])`);
    params.push(f.types);
  }
  if (f?.after)  { conditions.push(`created_at > $${idx++}`); params.push(f.after); }
  if (f?.before) { conditions.push(`created_at < $${idx++}`); params.push(f.before); }

  if (query.asOf) {
    conditions.push(`(valid_at IS NULL OR valid_at <= $${idx++})`);
    params.push(query.asOf);
    conditions.push(`(invalid_at IS NULL OR invalid_at > $${idx++})`);
    params.push(query.asOf);
  } else {
    conditions.push('invalid_at IS NULL');
  }

  return { sql: conditions.join(' AND '), params };
}

function pgRowToMemoryEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row['id'] as string,
    type: row['type'] as MemoryType,
    content: row['content'] as string,
    metadata: row['metadata'] as Record<string, unknown>,
    embedding: row['embedding'] != null ? fromVectorLiteral(row['embedding'] as string) : undefined,
    createdAt: (row['created_at'] instanceof Date
      ? (row['created_at'] as Date).toISOString()
      : String(row['created_at'])),
    expiresAt: row['expires_at'] != null
      ? (row['expires_at'] instanceof Date
        ? (row['expires_at'] as Date).toISOString()
        : String(row['expires_at']))
      : undefined,
    tenantId:  row['tenant_id']  as string | undefined,
    userId:    row['user_id']    as string | undefined,
    sessionId: row['session_id'] as string | undefined,
    score:     row['_score']     as number | undefined,
    importance: row['importance'] != null ? Number(row['importance']) : undefined,
    validAt:   row['valid_at'] != null
      ? (row['valid_at'] instanceof Date
        ? (row['valid_at'] as Date).toISOString()
        : String(row['valid_at']))
      : undefined,
    invalidAt: row['invalid_at'] != null
      ? (row['invalid_at'] instanceof Date
        ? (row['invalid_at'] as Date).toISOString()
        : String(row['invalid_at']))
      : undefined,
  };
}

export function weavePgVectorMemoryStore(opts: PgVectorMemoryStoreOptions): DurableMemoryStore {
  const { pool, ownsPool } = resolveMemoryPool(opts, (url) => new Pool({ connectionString: url }));
  const dims   = opts.dimensions     ?? 1536;
  const table  = opts.tableName      ?? 'memory_vec';

  // CR-4: Validate table name and dims to prevent SQL injection via DDL interpolation.
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
    throw new Error(
      `[pgvector] Invalid tableName "${table}". ` +
      `Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ (no schema prefix, no quoted identifiers).`,
    );
  }
  if (!Number.isInteger(dims) || dims < 1 || dims > 65535) {
    throw new Error(
      `[pgvector] Invalid dimensions ${dims}. Must be a positive integer between 1 and 65535.`,
    );
  }

  const metric = opts.distanceMetric ?? 'cosine';
  const idxType = opts.indexType     ?? 'hnsw';
  const graphRetriever = opts.graphRetriever;
  const { operator, indexOps, toScore } = pgVectorMetricConfig(metric);

  let schemaReady = false;

  async function ensureSchema(): Promise<void> {
    if (schemaReady) return;
    const client = await pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          content     TEXT NOT NULL,
          metadata    JSONB NOT NULL DEFAULT '{}',
          embedding   vector(${dims}),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at  TIMESTAMPTZ,
          tenant_id   TEXT,
          user_id     TEXT,
          session_id  TEXT,
          importance  REAL,
          valid_at    TIMESTAMPTZ,
          invalid_at  TIMESTAMPTZ
        )
      `);

      // Idempotent column migrations
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS importance  REAL`);
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS valid_at    TIMESTAMPTZ`);
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS invalid_at  TIMESTAMPTZ`);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${table}_content_idx
          ON ${table} USING gin(to_tsvector('english', content))
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${table}_invalid_at_idx
          ON ${table} (invalid_at)
          WHERE invalid_at IS NULL
      `);

      if (idxType === 'hnsw') {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${table}_embedding_hnsw_idx
            ON ${table}
            USING hnsw (embedding ${indexOps})
        `);
      } else if (idxType === 'ivfflat') {
        const lists = opts.ivfLists ?? 100;
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${table}_embedding_ivfflat_idx
            ON ${table}
            USING ivfflat (embedding ${indexOps})
            WITH (lists = ${lists})
        `);
      }

      schemaReady = true;
    } finally {
      client.release();
    }
  }

  return {
    async write(_ctx, entries): Promise<void> {
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const entry of entries) {
          const embLiteral = entry.embedding ? toVectorLiteral(entry.embedding) : null;
          const importance = computeImportance(entry);
          await client.query(
            `INSERT INTO ${table}
               (id, type, content, metadata, embedding,
                created_at, expires_at, tenant_id, user_id, session_id,
                importance, valid_at, invalid_at)
             VALUES ($1, $2, $3, $4::jsonb,
                     $5::vector,
                     $6, $7, $8, $9, $10,
                     $11, $12, $13)
             ON CONFLICT (id) DO UPDATE SET
               type       = EXCLUDED.type,
               content    = EXCLUDED.content,
               metadata   = EXCLUDED.metadata,
               embedding  = EXCLUDED.embedding,
               expires_at = EXCLUDED.expires_at,
               tenant_id  = EXCLUDED.tenant_id,
               user_id    = EXCLUDED.user_id,
               session_id = EXCLUDED.session_id,
               importance = EXCLUDED.importance,
               valid_at   = EXCLUDED.valid_at,
               invalid_at = EXCLUDED.invalid_at`,
            [
              entry.id,
              entry.type,
              entry.content,
              JSON.stringify(entry.metadata ?? {}),
              embLiteral,
              entry.createdAt,
              entry.expiresAt  ?? null,
              entry.tenantId   ?? null,
              entry.userId     ?? null,
              entry.sessionId  ?? null,
              importance,
              entry.validAt    ?? null,
              entry.invalidAt  ?? null,
            ],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async query(_ctx, options): Promise<MemoryEntry[]> {
      await ensureSchema();
      const topK = options.topK ?? 10;
      const candidate = topK * 3;
      const client = await pool.connect();

      try {
        const hasVector = options.embedding && options.embedding.length > 0;
        const hasText   = !!options.query;

        if (!hasVector && !hasText) {
          const { sql: filterSQL, params: filterParams } = buildFilterSQL(options, 2);
          const result = await client.query(
            `SELECT * FROM ${table}
             WHERE ${filterSQL}
             ORDER BY created_at DESC LIMIT $1`,
            [topK, ...filterParams],
          );
          return result.rows.map(pgRowToMemoryEntry);
        }

        const RRF_K = 60;
        const vectorIds: string[] = [];
        const ftsIds:    string[] = [];

        if (hasVector) {
          const qVec = toVectorLiteral(options.embedding!);
          const { sql: filterSQL, params: filterParams } = buildFilterSQL(options, 3);
          const scoreExpr = toScore(`(embedding ${operator} $1::vector)`);
          let sql = `
            SELECT id, ${scoreExpr} AS _score
            FROM ${table}
            WHERE embedding IS NOT NULL
              AND ${filterSQL}
          `;
          const params: unknown[] = [qVec, candidate, ...filterParams];
          const defaultMinSim = (() => {
            const raw = Number.parseFloat(process.env['SEMANTIC_MEMORY_MIN_SIM'] ?? '');
            return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.20;
          })();
          const effectiveMinScore = options.minScore !== undefined
            ? options.minScore
            : defaultMinSim;
          if (effectiveMinScore > 0) {
            sql += ` AND ${scoreExpr} >= ${effectiveMinScore}`;
          }
          sql += ` ORDER BY embedding ${operator} $1::vector LIMIT $2`;
          const vRes = await client.query<{ id: string }>(sql, params);
          for (const row of vRes.rows) vectorIds.push(row.id);
        }

        if (hasText) {
          const queryText = options.query!;
          const { sql: filterSQL, params: filterParams } = buildFilterSQL(options, 3);
          const ftsSQL = `
            SELECT id
            FROM ${table}
            WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)
              AND ${filterSQL}
            ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $1)) DESC
            LIMIT $2
          `;
          try {
            const fRes = await client.query<{ id: string }>(
              ftsSQL,
              [queryText, candidate, ...filterParams],
            );
            for (const row of fRes.rows) ftsIds.push(row.id);
          } catch {
            const { sql: f2SQL, params: f2Params } = buildFilterSQL(options, 3);
            const ilikeRes = await client.query<{ id: string }>(
              `SELECT id FROM ${table}
               WHERE LOWER(content) LIKE LOWER($1) AND ${f2SQL}
               ORDER BY created_at DESC LIMIT $2`,
              [`%${queryText}%`, candidate, ...f2Params],
            );
            for (const row of ilikeRes.rows) ftsIds.push(row.id);
          }
        }

        const graphIds: string[] = [];
        if (graphRetriever && hasText) {
          try {
            const graphResults = graphRetriever.retrieve(options.query!, candidate);
            for (const gr of graphResults) {
              const { sql: gFilterSQL, params: gFilterParams } = buildFilterSQL(options, 3);
              const gRes = await client.query<{ id: string }>(
                `SELECT id FROM ${table}
                 WHERE LOWER(content) LIKE LOWER($1) AND ${gFilterSQL}
                 ORDER BY created_at DESC LIMIT $2`,
                [`%${gr.node.name}%`, 5, ...gFilterParams],
              );
              for (const row of gRes.rows) graphIds.push(row.id);
            }
          } catch {
            // Graph retrieval is best-effort
          }
        }

        const rrfScores = new Map<string, number>();
        for (const [rank, id] of vectorIds.entries()) {
          rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
        }
        for (const [rank, id] of ftsIds.entries()) {
          rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
        }
        for (const [rank, id] of graphIds.entries()) {
          rrfScores.set(id, (rrfScores.get(id) ?? 0) + 0.5 / (RRF_K + rank + 1));
        }

        const ranked = [...rrfScores.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, topK)
          .map(([id]) => id);

        if (ranked.length === 0) return [];

        const placeholders = ranked.map((_, i) => `$${i + 1}`).join(', ');
        const fullRows = await client.query(
          `SELECT * FROM ${table} WHERE id = ANY(ARRAY[${placeholders}])`,
          ranked,
        );

        const byId = new Map(fullRows.rows.map((r: Record<string, unknown>) => [r['id'] as string, r]));
        const ranked_entries: MemoryEntry[] = [];
        for (const id of ranked) {
          const row = byId.get(id);
          if (!row) continue;
          ranked_entries.push({ ...pgRowToMemoryEntry(row), score: rrfScores.get(id) ?? 0 });
        }
        return ranked_entries;
      } finally {
        client.release();
      }
    },

    async delete(_ctx, ids): Promise<void> {
      if (ids.length === 0) return;
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query(`DELETE FROM ${table} WHERE id = ANY($1)`, [ids]);
      } finally {
        client.release();
      }
    },

    async clear(_ctx, filter): Promise<void> {
      await ensureSchema();
      const client = await pool.connect();
      try {
        if (!filter) {
          await client.query(`DELETE FROM ${table}`);
          return;
        }
        const conditions: string[] = [];
        const params: unknown[] = [];
        let idx = 1;
        if (filter.tenantId)  { conditions.push(`tenant_id = $${idx++}`);  params.push(filter.tenantId); }
        if (filter.userId)    { conditions.push(`user_id = $${idx++}`);    params.push(filter.userId); }
        if (filter.sessionId) { conditions.push(`session_id = $${idx++}`); params.push(filter.sessionId); }
        if (filter.types && filter.types.length > 0) {
          conditions.push(`type = ANY($${idx++}::text[])`);
          params.push(filter.types);
        }
        if (filter.after)  { conditions.push(`created_at > $${idx++}`); params.push(filter.after); }
        if (filter.before) { conditions.push(`created_at < $${idx++}`); params.push(filter.before); }
        if (conditions.length === 0) {
          await client.query(`DELETE FROM ${table}`);
        } else {
          await client.query(`DELETE FROM ${table} WHERE ${conditions.join(' AND ')}`, params);
        }
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
