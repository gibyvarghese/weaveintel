import { weavePgVectorMemoryStore } from '@weaveintel/memory';
import { Pool } from 'pg';
import type { ExecutionContext } from '@weaveintel/core';

const PG_URL = process.env['PGVECTOR_URL'] ?? 'postgresql://gibyvarghese@localhost:5432/geneweave';
const store = weavePgVectorMemoryStore({ url: PG_URL, dimensions: 1536, tableName: 'geneweave_memory_vec' });
const fakeEmbedding = new Array(1536).fill(0.01) as number[];
const ctx = { executionId: 'direct-test', metadata: {}, tracer: {} } as unknown as ExecutionContext;

console.log('Writing row with 1536-dim embedding...');
await store.write(ctx, [{
  id: 'direct-test-embed-001',
  type: 'semantic' as const,
  content: 'Direct write test with embedding',
  metadata: { memory_type: 'user_fact', source: 'test' },
  embedding: fakeEmbedding,
  createdAt: new Date().toISOString(),
  userId: 'test-user-001',
}]);

const pool = new Pool({ connectionString: PG_URL });
const res = await pool.query(`SELECT id, embedding IS NOT NULL AS has_emb, vector_dims(embedding) AS dims FROM geneweave_memory_vec WHERE id = 'direct-test-embed-001'`);
console.log('Result:', JSON.stringify(res.rows[0]));
await pool.end();
await store.close();
