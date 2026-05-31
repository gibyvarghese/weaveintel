/**
 * Postgres-backed EmbeddingStore for cached tool embeddings (intent-RAG).
 *
 * Vectors stored as JSONB. ON CONFLICT(tool_key) DO UPDATE for idempotent upsert.
 */
import type { Pool, PoolClient } from 'pg';
import type { EmbeddingStore, ToolEmbedding } from '../intent-rag.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS tool_embeddings (
  tool_key TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector JSONB NOT NULL,
  description_hash TEXT NOT NULL
);
`;

interface Row {
  tool_key: string;
  model_id: string;
  dimension: number | string;
  vector: unknown;
  description_hash: string;
}

function rowToEmbedding(r: Row): ToolEmbedding {
  let vector: number[] = [];
  if (Array.isArray(r.vector)) vector = r.vector as number[];
  else if (typeof r.vector === 'string') {
    try { vector = JSON.parse(r.vector) as number[]; } catch { vector = []; }
  }
  return {
    toolKey: r.tool_key,
    modelId: r.model_id,
    dimension: typeof r.dimension === 'string' ? Number(r.dimension) : r.dimension,
    vector,
    descriptionHash: r.description_hash,
  };
}

export interface WeavePostgresEmbeddingStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresEmbeddingStore(opts: WeavePostgresEmbeddingStoreOptions): Promise<EmbeddingStore> {
  const { pool, ensureSchema = true } = opts;
  if (ensureSchema) {
    const c: PoolClient = await pool.connect();
    try { await c.query(MIGRATIONS_SQL); } finally { c.release(); }
  }
  return {
    async get(toolKey: string): Promise<ToolEmbedding | null> {
      const r = await pool.query<Row>('SELECT * FROM tool_embeddings WHERE tool_key = $1', [toolKey]);
      const row = r.rows[0];
      return row ? rowToEmbedding(row) : null;
    },
    async getAll(): Promise<ReadonlyArray<ToolEmbedding>> {
      const r = await pool.query<Row>('SELECT * FROM tool_embeddings');
      return r.rows.map(rowToEmbedding);
    },
    async upsert(embedding: ToolEmbedding): Promise<void> {
      await pool.query(
        `INSERT INTO tool_embeddings (tool_key, model_id, dimension, vector, description_hash)
         VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (tool_key) DO UPDATE SET
           model_id = EXCLUDED.model_id,
           dimension = EXCLUDED.dimension,
           vector = EXCLUDED.vector,
           description_hash = EXCLUDED.description_hash`,
        [
          embedding.toolKey,
          embedding.modelId,
          embedding.dimension,
          JSON.stringify(embedding.vector),
          embedding.descriptionHash,
        ],
      );
    },
  };
}
