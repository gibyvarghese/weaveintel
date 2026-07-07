// SPDX-License-Identifier: MIT
/**
 * THE Phase 5 flagship: move the runtime's durable state from SQLite to a REAL Postgres with zero loss,
 * using the industry-standard playbook — dual-write (expand) → backfill (migrate) → verify (reconcile) →
 * cut over. Uses a throwaway Postgres container (no mocks). Skipped when Docker isn't available.
 *
 *   1. FLAGSHIP — a real SQLite→Postgres cutover, end to end, proven identical before the switch.
 *   2. STRESS — 50,000 keys migrate and reconcile clean.
 *   3. SECURITY — hostile keys/values survive the migration byte-for-byte.
 *   4. NEGATIVE — if the new database drifts, reconcile catches it (you don't cut over blind).
 *   5. REAL LLM — a cost + idempotency ledger built from real completions migrates without losing a record.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync as exec } from 'node:child_process';
import { createHash as hash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { weaveSqlitePersistence } from './runtime-slot.js';
import { weavePostgresPersistence, type SqlClient } from './postgres-slot.js';
import { migrateKv, reconcileKv, weaveDualWriteKv } from './kv-cutover.js';

function hasDocker(): boolean {
  try { exec('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
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

const asSqlClient = (pool: pg.Pool): SqlClient => ({ query: (text, params) => pool.query(text, params as unknown[]) });

describe.skipIf(!HAS_DOCKER)('KV cutover → real Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let tableSeq = 0;
  const pgKv = () => weavePostgresPersistence({ client: asSqlClient(pool), table: `cutover_${++tableSeq}` }).kv;
  const sqliteKv = () => weaveSqlitePersistence({ path: ':memory:' }).kv;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 20 });
    await pool.query('SELECT 1');
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  it('FLAGSHIP: a real SQLite→Postgres cutover, verified identical before the switch', async () => {
    const oldSqlite = sqliteKv();
    const newPostgres = pgKv();

    // History that predates the migration (the DLQ + cost meter you already have on SQLite).
    await oldSqlite.set('dlq:job-1', '{"attempts":3}');
    await oldSqlite.set('cost:tenant-42', '1200');

    // EXPAND: turn on dual-writes. From now on, live traffic lands in BOTH databases.
    const live = weaveDualWriteKv(oldSqlite, newPostgres, { shadowReadRatio: 1 });
    await live.set('cost:tenant-42', '1350'); // an update lands in both
    await live.set('dlq:job-2', '{"attempts":1}');

    // BACKFILL: copy everything that was there before dual-writes started.
    const migrated = await migrateKv(oldSqlite, newPostgres);
    expect(migrated.copied).toBe(3);

    // VERIFY: the two are now identical — the green light to cut over.
    const report = await reconcileKv(oldSqlite, newPostgres);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    expect(report.sourceCount).toBe(3);

    // CUT OVER: reads now come straight from Postgres, with everything intact (incl. the updated value).
    expect(await newPostgres.get('cost:tenant-42')).toBe('1350');
    expect((await newPostgres.list('')).length).toBe(3);

    // ROLLBACK SAFETY: keep writing to the old store for a window (new is primary now).
    const guarded = weaveDualWriteKv(newPostgres, oldSqlite);
    await guarded.set('cost:tenant-42', '1400');
    expect(await oldSqlite.get('cost:tenant-42')).toBe('1400'); // old stays a warm standby
  }, 120_000);

  it('STRESS: 50,000 keys migrate and reconcile clean', async () => {
    const src = sqliteKv();
    const tgt = pgKv();
    const N = 50_000;
    for (let i = 0; i < N; i++) await src.set(`k:${i}`, `v${i}`);
    const t0 = Date.now();
    const result = await migrateKv(src, tgt, { batchSize: 1000 });
    expect(result.copied).toBe(N);
    const report = await reconcileKv(src, tgt);
    expect(report.ok).toBe(true);
    expect(report.targetCount).toBe(N);
    expect(Date.now() - t0).toBeLessThan(90_000);
  }, 180_000);

  it('SECURITY: hostile keys/values survive the migration byte-for-byte', async () => {
    const src = sqliteKv();
    const tgt = pgKv();
    const evilKey = `k'; DROP TABLE cutover_1; -- \n \\ "x"`;
    const evilVal = `'; DELETE FROM cutover_1; -- %s ${'z'.repeat(40)}`;
    await src.set(evilKey, evilVal);
    await src.set('normal', 'value');
    await migrateKv(src, tgt);
    expect(await tgt.get(evilKey)).toBe(evilVal); // stored as data, not executed
    expect((await reconcileKv(src, tgt)).ok).toBe(true);
    await tgt.set('after', 'still-works');
    expect(await tgt.get('after')).toBe('still-works');
  }, 60_000);

  it('NEGATIVE: reconcile catches drift so you never cut over on unequal data', async () => {
    const src = sqliteKv();
    const tgt = pgKv();
    await src.set('a', '1'); await src.set('b', '2'); await src.set('c', '3');
    await migrateKv(src, tgt);
    // Something goes wrong on the new side after the copy…
    await tgt.set('b', 'CORRUPTED');
    await tgt.delete('c');
    await tgt.set('rogue', 'x');
    const report = await reconcileKv(src, tgt);
    expect(report.ok).toBe(false);
    expect(report.valueMismatches).toEqual(['b']);
    expect(report.missingInTarget).toEqual(['c']);
    expect(report.extraInTarget).toEqual(['rogue']);
  }, 60_000);

  it.skipIf(!KEY)('REAL LLM: a cost + idempotency ledger from real completions migrates with zero loss', async () => {
    const ask = async (prompt: string): Promise<{ text: string; tokens: number }> => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
      const j = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage: { total_tokens: number } };
      return { text: j.choices[0]!.message.content, tokens: j.usage.total_tokens };
    };

    // Run a few real completions and record what the runtime would: an idempotency entry (so a retried
    // request returns the cached answer) and a cost entry (so billing is exact) — all on SQLite.
    const oldSqlite = sqliteKv();
    const prompts = ['Say hello in French.', 'Name a primary colour.', 'What is 2+2?'];
    let totalTokens = 0;
    for (let i = 0; i < prompts.length; i++) {
      const { text, tokens } = await ask(prompts[i]!);
      totalTokens += tokens;
      await oldSqlite.set(`idem:req-${i}`, hash('sha256').update(text).digest('hex'));
      await oldSqlite.set(`cost:req-${i}`, String(tokens));
    }
    await oldSqlite.set('cost:total', String(totalTokens));

    // Cut the ledger over to Postgres and prove not a single record was lost or changed.
    const newPostgres = pgKv();
    const migrated = await migrateKv(oldSqlite, newPostgres);
    expect(migrated.copied).toBe(prompts.length * 2 + 1);
    const report = await reconcileKv(oldSqlite, newPostgres);
    expect(report.ok, JSON.stringify(report)).toBe(true);
    // The exact cost total the real calls incurred is intact on the new database.
    expect(await newPostgres.get('cost:total')).toBe(String(totalTokens));
    expect(Number(await newPostgres.get('cost:total'))).toBeGreaterThan(0);
  }, 180_000);
});
