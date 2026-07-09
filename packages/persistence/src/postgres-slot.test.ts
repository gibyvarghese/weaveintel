// SPDX-License-Identifier: MIT
/**
 * REAL Postgres tests via Testcontainers (a throwaway Postgres+pgvector container — no mocks, no
 * external DB needed). Skipped automatically when Docker isn't available.
 *
 *   1. The full conformance contract against the Postgres slot → proves it's a drop-in for SQLite.
 *   2. SQLite ↔ Postgres parity → the same operations give the same answers on both backends.
 *   3. FLAGSHIP (real LLM): the "unified data layer" thesis — real OpenAI embeddings stored in the SAME
 *      Postgres via pgvector, semantically searched with a `<=>` query. No separate vector database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { weavePostgresPersistence, type SqlClient } from './postgres-slot.js';
import { weaveSqlitePersistence } from './runtime-slot.js';
import { runPersistenceContract } from './persistence-contract.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../.env', '../../.env', '../.env']) {
    try { const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m); if (m) return m[1]!.trim().replace(/^["']|["']$/g, ''); } catch { /* */ }
  }
  return undefined;
}
const KEY = loadKey();

// pg.Pool satisfies SqlClient (query(text, params) → { rows }); wrap to keep the types tidy.
const asSqlClient = (pool: pg.Pool): SqlClient => ({ query: (text, params) => pool.query(text, params as unknown[]) });

describe.skipIf(!HAS_DOCKER)('Postgres runtime persistence slot (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    // pgvector image so the same container serves the KV contract AND the vector e2e.
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  it('passes the full conformance contract → drop-in parity with SQLite', async () => {
    const results = await runPersistenceContract({
      makeStore: () => weavePostgresPersistence({ client: asSqlClient(pool), table: 'weave_ct_kv' }).kv,
      cleanup: async () => { await pool.query('DROP TABLE IF EXISTS weave_ct_kv'); },
      stressSize: 3000,
    });
    const failed = results.filter((r) => !r.ok).map((r) => `${r.tier}/${r.name}: ${r.detail}`);
    expect(failed, failed.join('\n')).toHaveLength(0);
  }, 120_000);

  it('SQLite and Postgres give identical answers for the same operations (parity)', async () => {
    const pgSlot = weavePostgresPersistence({ client: asSqlClient(pool), table: 'weave_parity' }).kv;
    const sqSlot = weaveSqlitePersistence({ path: join(tmpdir(), `parity-${Date.now()}.db`) }).kv;
    const ops = async (kv: typeof pgSlot) => {
      await kv.set('t:1', 'alpha');
      await kv.set('t:2', 'beta');
      await kv.set('u:1', 'gamma');
      await kv.set('t:1', 'ALPHA'); // overwrite
      const del = await kv.delete('t:2');
      const missing = await kv.delete('nope');
      const list = await kv.list('t:');
      return { get1: await kv.get('t:1'), del, missing, list, other: await kv.list('u:') };
    };
    const [a, b] = await Promise.all([ops(pgSlot), ops(sqSlot)]);
    expect(a).toEqual(b); // byte-for-byte identical behaviour across the two backends
    await pool.query('DROP TABLE IF EXISTS weave_parity');
  }, 60_000);

  it('SECURITY: a hostile key/value cannot drop the table (parameterised)', async () => {
    const kv = weavePostgresPersistence({ client: asSqlClient(pool), table: 'weave_sec' }).kv;
    await kv.set(`x'; DROP TABLE weave_sec; --`, `'; DROP TABLE weave_sec; --`);
    // If the injection had executed, the next call would fail because the table is gone.
    await kv.set('after', 'still-here');
    expect(await kv.get('after')).toBe('still-here');
    await pool.query('DROP TABLE IF EXISTS weave_sec');
  }, 60_000);

  it.skipIf(!KEY)('FLAGSHIP: unified data layer — real OpenAI embeddings in the same Postgres via pgvector', async () => {
    const embed = async (texts: string[]): Promise<number[][]> => {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
      return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map((d) => d.embedding);
    };
    const toVec = (v: number[]) => `[${v.join(',')}]`;

    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query('CREATE TABLE docs (id TEXT PRIMARY KEY, body TEXT, embedding vector(1536))');

    const docs = [
      { id: 'd1', body: 'The invoice total for Acme was $4,200 due net-30.' },
      { id: 'd2', body: 'Our hiking trip to the Alps is planned for July.' },
      { id: 'd3', body: 'Refund policy: customers may return items within 14 days.' },
      { id: 'd4', body: 'The quarterly sales report shows revenue up 18%.' },
    ];
    const vecs = await embed(docs.map((d) => d.body));
    for (let i = 0; i < docs.length; i++) {
      await pool.query('INSERT INTO docs (id, body, embedding) VALUES ($1, $2, $3::vector)', [docs[i]!.id, docs[i]!.body, toVec(vecs[i]!)]);
    }

    // A plainly-worded query that matches d1 by MEANING (shares no keywords with "invoice/net-30").
    const [q] = await embed(['how much does the customer owe us and when']);
    const { rows } = await pool.query('SELECT id, body FROM docs ORDER BY embedding <=> $1::vector LIMIT 2', [toVec(q!)]);
    expect(rows[0]!.id).toBe('d1'); // semantic match, in the same Postgres as the relational data

    await pool.query('DROP TABLE docs');
  }, 120_000);
});
