/**
 * SQLite-backed EmbeddingStore for cached tool embeddings (intent-RAG).
 *
 * Persists every embedding into `tool_embeddings` keyed by `tool_key` (PK).
 * Vectors stored as JSON text. Idempotent upsert via ON CONFLICT.
 */
import Database from 'better-sqlite3';
import type { EmbeddingStore, ToolEmbedding } from '../intent-rag.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS tool_embeddings (
  tool_key TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  vector TEXT NOT NULL,
  description_hash TEXT NOT NULL
);
`;

interface EmbeddingRow {
  tool_key: string;
  model_id: string;
  dimension: number;
  vector: string;
  description_hash: string;
}

function rowToEmbedding(r: EmbeddingRow): ToolEmbedding {
  let vector: number[] = [];
  try { vector = JSON.parse(r.vector) as number[]; } catch { vector = []; }
  return {
    toolKey: r.tool_key,
    modelId: r.model_id,
    dimension: r.dimension,
    vector,
    descriptionHash: r.description_hash,
  };
}

export interface WeaveSqliteEmbeddingStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteEmbeddingStore(opts: WeaveSqliteEmbeddingStoreOptions = {}): EmbeddingStore {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const getStmt = db.prepare('SELECT * FROM tool_embeddings WHERE tool_key = ?');
  const allStmt = db.prepare('SELECT * FROM tool_embeddings');
  const upsertStmt = db.prepare(`
    INSERT INTO tool_embeddings (tool_key, model_id, dimension, vector, description_hash)
    VALUES (?,?,?,?,?)
    ON CONFLICT(tool_key) DO UPDATE SET
      model_id = excluded.model_id,
      dimension = excluded.dimension,
      vector = excluded.vector,
      description_hash = excluded.description_hash
  `);

  return {
    async get(toolKey: string): Promise<ToolEmbedding | null> {
      const r = getStmt.get(toolKey) as EmbeddingRow | undefined;
      return r ? rowToEmbedding(r) : null;
    },
    async getAll(): Promise<ReadonlyArray<ToolEmbedding>> {
      const rows = allStmt.all() as EmbeddingRow[];
      return rows.map(rowToEmbedding);
    },
    async upsert(embedding: ToolEmbedding): Promise<void> {
      upsertStmt.run(
        embedding.toolKey,
        embedding.modelId,
        embedding.dimension,
        JSON.stringify(embedding.vector),
        embedding.descriptionHash,
      );
    },
  };
}
