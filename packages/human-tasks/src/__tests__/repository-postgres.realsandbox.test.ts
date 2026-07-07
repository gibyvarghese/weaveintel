// SPDX-License-Identifier: MIT
/**
 * The Postgres HumanTaskRepository adapter, proven against a REAL Postgres (Testcontainers — a throwaway
 * container, no mocks). Skipped automatically when Docker isn't available.
 *
 *   1. The SHARED contract — the exact battery the in-memory reference passes — on Postgres. Each test
 *      gets its own table (the claim query scans ALL pending rows, so tests must not share a table).
 *   2. Stress + security — the real payoff of a Postgres work queue: 200 workers claiming 200 tasks
 *      concurrently, and NOT ONE task is handed to two workers (FOR UPDATE SKIP LOCKED).
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { HumanTask } from '@weaveintel/core';
import { createPostgresHumanTaskRepository } from '../repository-postgres.js';
import { humanTaskRepositoryContract } from '../repository-contract.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

const task = (over: Partial<HumanTask>): HumanTask => ({
  id: 't', type: 'approval', title: 'Approve', status: 'pending', priority: 'normal',
  createdAt: new Date().toISOString(), ...over,
});

describe.skipIf(!HAS_DOCKER)('Postgres HumanTaskRepository (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let tableSeq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 20 });
    await pool.query('SELECT 1');
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  // 1) The SAME contract the in-memory reference passes — a fresh table per test (claim scans all rows).
  humanTaskRepositoryContract(
    () => createPostgresHumanTaskRepository({ pool, table: `ht_ct_${++tableSeq}` }),
    { describe, it, beforeEach, expect } as never,
  );

  // 2) The whole point of a Postgres queue: no task is ever claimed twice, even under a stampede.
  it('STRESS/SECURITY: 200 workers claim 200 tasks concurrently — every task claimed exactly once', async () => {
    const repo = createPostgresHumanTaskRepository({ pool, table: 'ht_stampede' });
    const N = 200;
    // Seed N pending tasks.
    for (let i = 0; i < N; i += 50) {
      await Promise.all(Array.from({ length: 50 }, (_, j) => {
        const n = i + j;
        return repo.save(task({ id: `job-${n}`, createdAt: new Date(Date.UTC(2026, 0, 1) + n).toISOString() }));
      }));
    }
    // 250 workers race to claim — 50 more workers than tasks.
    const claims = await Promise.all(Array.from({ length: N + 50 }, (_, i) => repo.claimNextPending(`w-${i}`)));
    const claimed = claims.filter((c): c is HumanTask => c !== null);
    const claimedIds = claimed.map((c) => c.id);
    const unique = new Set(claimedIds);

    expect(claimed.length).toBe(N);                 // exactly N tasks got claimed
    expect(unique.size).toBe(N);                    // …and NO task was claimed twice
    expect(claims.filter((c) => c === null).length).toBe(50); // the 50 extra workers got nothing
    // Every task is now assigned; none left pending.
    expect(await repo.list({ status: ['pending'] })).toHaveLength(0);
    expect(await repo.list({ status: ['assigned'] })).toHaveLength(N);
  }, 120_000);

  it('SECURITY: a hostile task id/title is stored as data (parameterised) and survives round-trip', async () => {
    const repo = createPostgresHumanTaskRepository({ pool, table: 'ht_sec' });
    const hostile = `'; DROP TABLE ht_sec; -- "x"`;
    await repo.save(task({ id: 'h1', title: hostile, data: { note: hostile } }));
    const got = await repo.get('h1');
    expect(got?.title).toBe(hostile);
    expect((got?.data as { note: string }).note).toBe(hostile);
    // Table still works.
    await repo.save(task({ id: 'h2', title: 'ok' }));
    expect((await repo.get('h2'))?.title).toBe('ok');
  }, 60_000);
});
