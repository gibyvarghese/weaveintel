// SPDX-License-Identifier: MIT
/**
 * The Postgres notification-feed adapter, proven against a REAL Postgres (Testcontainers — a throwaway
 * container, no mocks). Skipped automatically when Docker isn't available.
 *
 *   1. The SHARED contract — the exact battery the in-memory reference passes — on Postgres. Each test
 *      gets its own table (the contract reuses ids like 'a'/'b' across tests), proving identical
 *      behaviour behind the one port.
 *   2. Stress — a real "fan-out on write": one event to 5,000 recipients, each inbox correct.
 *   3. Security — hostile content is stored as data; concurrent duplicate deliveries collapse to one row.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createPostgresNotificationFeedStore } from './feed-postgres.js';
import { notificationFeedStoreContract } from './feed-contract.js';
import type { FeedNotification } from './feed.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

const feedRow = (over: Partial<FeedNotification>): FeedNotification => ({
  id: 'x', tenantId: 'tA', principalId: 'alice', category: 'run', title: 'Run finished',
  priority: 'normal', createdAt: Date.now(), readAt: null, ...over,
});

describe.skipIf(!HAS_DOCKER)('Postgres NotificationFeedStore (real Postgres via Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let tableSeq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await pool.query('SELECT 1');
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  // 1) The SAME contract the in-memory reference passes — a fresh table per test (ids repeat across tests).
  notificationFeedStoreContract(
    () => createPostgresNotificationFeedStore({ pool, table: `feed_ct_${++tableSeq}` }),
    { describe, it, beforeEach, expect } as never,
  );

  // 2) Stress: fan-out on write — one event to 5,000 recipients, each inbox correct + fast.
  it('STRESS: fan-out to 5,000 recipients, each sees exactly one unread', async () => {
    const store = createPostgresNotificationFeedStore({ pool, table: 'feed_fanout' });
    const t0 = Date.now();
    for (let i = 0; i < 5000; i += 250) {
      await Promise.all(Array.from({ length: 250 }, (_, j) => {
        const n = i + j;
        return store.append(feedRow({ id: `evt-${n}`, principalId: `user-${n}`, createdAt: 1000 + n }));
      }));
    }
    // Probe a handful of recipients — each has exactly their one row, unread.
    for (const n of [0, 1234, 4999]) {
      expect(await store.unreadCount('tA', `user-${n}`)).toBe(1);
      const inbox = await store.list('tA', `user-${n}`);
      expect(inbox.map((r) => r.id)).toEqual([`evt-${n}`]);
    }
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  // 3) Security: hostile content is data; concurrent duplicate delivery collapses to one row.
  it('SECURITY: hostile content stored as data + concurrent dedupe collapses to one row', async () => {
    const store = createPostgresNotificationFeedStore({ pool, table: 'feed_sec' });
    const hostile = `'; DROP TABLE feed_sec; -- "x"`;
    await store.append(feedRow({ id: 'h1', principalId: 'carol', title: hostile, body: hostile }));
    const listed = await store.list('tA', 'carol');
    expect(listed[0]?.title).toBe(hostile); // stored verbatim, injection did not execute

    // A redelivered event (same principal + dedupeKey) fired 50x concurrently → exactly ONE row.
    await Promise.all(Array.from({ length: 50 }, (_, i) =>
      store.append(feedRow({ id: `dup-${i}`, principalId: 'dave', dedupeKey: 'run-9:terminal', createdAt: 5000 + i })),
    ));
    expect((await store.list('tA', 'dave')).length).toBe(1);
    expect(await store.unreadCount('tA', 'dave')).toBe(1);
  }, 60_000);
});
