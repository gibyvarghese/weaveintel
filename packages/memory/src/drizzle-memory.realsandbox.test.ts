// SPDX-License-Identifier: MIT
/**
 * The ONE Drizzle memory implementation, proven on a REAL Postgres (Testcontainers). Skipped when
 * Docker isn't available.
 *
 *   1. The SHARED contract — the exact battery SQLite passes — now on real Postgres (each test truncates
 *      the table so runs are isolated). Passing both proves the one implementation behaves the same.
 *   2. Stress — 5,000 memories write and filter correctly.
 *   3. Security — hostile content is stored as data.
 *   4. REAL LLM — a model produces facts to remember; they're written and read back by type.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { weaveContext, type MemoryEntry } from '@weaveintel/core';
import { weavePostgresMemoryStore } from './memory-postgres.js';
import { memoryStoreContract } from './memory-store-contract.js';

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
const ctx = weaveContext({ tenantId: 'acme', userId: 'u-1' });
let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;
const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({ id: uid('mem'), type: 'semantic', content: 'x', metadata: {}, createdAt: new Date().toISOString(), tenantId: 'acme', userId: 'u-1', ...over } as MemoryEntry);

describe.skipIf(!HAS_DOCKER)('Drizzle memory store → real Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await pool.query('CREATE TABLE IF NOT EXISTS memory_entries (id TEXT PRIMARY KEY, payload_json JSONB NOT NULL, updated_at TEXT NOT NULL)');
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  // 1) The SAME contract — on real Postgres. Truncate per test (query() is global) for isolation.
  describe('Drizzle → Postgres', () => {
    memoryStoreContract(
      async () => { await pool.query('TRUNCATE memory_entries'); return weavePostgresMemoryStore({ pool }); },
      { describe, it, beforeEach, expect } as never,
    );
  });

  it('STRESS: 5,000 memories write and filter correctly', async () => {
    await pool.query('TRUNCATE memory_entries');
    const store = weavePostgresMemoryStore({ pool });
    const t0 = Date.now();
    for (let i = 0; i < 5000; i += 500) {
      await store.write(ctx, Array.from({ length: 500 }, (_, j) => {
        const n = i + j;
        return entry({ id: `s-${n}`, userId: n % 4 === 0 ? 'vip' : 'reg', type: n % 3 === 0 ? 'episodic' : 'semantic', content: `fact ${n}` });
      }));
    }
    // topK is high so we count ALL matches (query defaults to a small top-N otherwise).
    const vip = await store.query(ctx, { filter: { userId: 'vip' }, topK: 10_000 });
    expect(vip.length).toBe(Math.floor((5000 - 1) / 4) + 1); // n % 4 === 0 → 0,4,8,…
    const semanticVip = await store.query(ctx, { type: 'semantic', filter: { userId: 'vip' }, topK: 10_000 });
    expect(semanticVip.every((r) => r.type === 'semantic' && r.userId === 'vip')).toBe(true);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  it('SECURITY: hostile content is stored as data, not executed', async () => {
    await pool.query('TRUNCATE memory_entries');
    const store = weavePostgresMemoryStore({ pool });
    const evil = `'; DROP TABLE memory_entries; -- "x"`;
    await store.write(ctx, [entry({ id: 'sec-1', content: evil, metadata: { evil } })]);
    const rows = await store.query(ctx, {});
    expect(rows.find((r) => r.id === 'sec-1')?.content).toBe(evil);
    // Table still works.
    await store.write(ctx, [entry({ id: 'sec-2', content: 'ok' })]);
    expect((await store.query(ctx, {})).some((r) => r.id === 'sec-2')).toBe(true);
  }, 60_000);

  it.skipIf(!KEY)('REAL LLM: facts a model chooses to remember are written and read back by type', async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'From "I am vegetarian, allergic to peanuts, and I prefer morning meetings", extract durable facts to remember about the user. Reply as strict JSON: {"facts": string[]}.' }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
    const { facts } = JSON.parse(((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content) as { facts: string[] };
    expect(facts.length).toBeGreaterThanOrEqual(2);

    await pool.query('TRUNCATE memory_entries');
    const store = weavePostgresMemoryStore({ pool });
    await store.write(ctx, facts.map((content, i) => entry({ id: `fact-${i}`, type: 'semantic', content, userId: 'diner' })));

    const remembered = await store.query(ctx, { type: 'semantic', filter: { userId: 'diner' } });
    expect(remembered.length).toBe(facts.length);
    // The model's facts survived the round-trip through Postgres.
    expect(remembered.map((r) => r.content).join(' ').toLowerCase()).toContain('peanut');
  }, 180_000);
});
