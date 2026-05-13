import { describe, expect, it } from 'vitest';
import { InMemoryRewriteJobStore, type RewriteJobRecord } from './rewrite-store.js';

function makeJob(overrides: Partial<RewriteJobRecord> = {}): RewriteJobRecord {
  const base: RewriteJobRecord = {
    id: 'job-1',
    tenantId: 't-a',
    tableName: 'messages',
    columnName: 'content',
    fromEpoch: 1,
    toEpoch: 2,
    lastRowId: null,
    rowsRewritten: 0,
    status: 'pending',
    errorMessage: null,
    createdAt: 1000,
    updatedAt: 1000,
    completedAt: null,
  };
  return { ...base, ...overrides };
}

describe('InMemoryRewriteJobStore', () => {
  it('upserts and gets a job', async () => {
    const store = new InMemoryRewriteJobStore();
    const job = makeJob();
    await store.upsert(job);
    const fetched = await store.get('job-1');
    expect(fetched).toEqual(job);
  });

  it('returns null for unknown id', async () => {
    const store = new InMemoryRewriteJobStore();
    expect(await store.get('nope')).toBeNull();
  });

  it('lists by tenantId and status', async () => {
    const store = new InMemoryRewriteJobStore();
    await store.upsert(makeJob({ id: 'a', tenantId: 't-a', status: 'pending', createdAt: 1 }));
    await store.upsert(makeJob({ id: 'b', tenantId: 't-a', status: 'running', createdAt: 2 }));
    await store.upsert(makeJob({ id: 'c', tenantId: 't-b', status: 'pending', createdAt: 3 }));

    const tA = await store.list({ tenantId: 't-a' });
    expect(tA.map((r) => r.id).sort()).toEqual(['a', 'b']);

    const pending = await store.list({ status: 'pending' });
    expect(pending.map((r) => r.id).sort()).toEqual(['a', 'c']);

    const tAPending = await store.list({ tenantId: 't-a', status: 'pending' });
    expect(tAPending.map((r) => r.id)).toEqual(['a']);
  });

  it('orders list by createdAt desc', async () => {
    const store = new InMemoryRewriteJobStore();
    await store.upsert(makeJob({ id: 'a', createdAt: 100 }));
    await store.upsert(makeJob({ id: 'b', createdAt: 300 }));
    await store.upsert(makeJob({ id: 'c', createdAt: 200 }));
    const rows = await store.list();
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('recordProgress flips pending → running and updates fields', async () => {
    const store = new InMemoryRewriteJobStore();
    await store.upsert(makeJob());
    await store.recordProgress('job-1', { lastRowId: 'row-50', rowsRewritten: 50 }, 5000);
    const j = await store.get('job-1');
    expect(j?.status).toBe('running');
    expect(j?.lastRowId).toBe('row-50');
    expect(j?.rowsRewritten).toBe(50);
    expect(j?.updatedAt).toBe(5000);
  });

  it('recordProgress is no-op for unknown job', async () => {
    const store = new InMemoryRewriteJobStore();
    await store.recordProgress('nope', { lastRowId: 'x', rowsRewritten: 1 }, 1);
    expect(await store.get('nope')).toBeNull();
  });

  it('markComplete sets status, completedAt, and total rows', async () => {
    const store = new InMemoryRewriteJobStore();
    await store.upsert(makeJob({ rowsRewritten: 90 }));
    await store.markComplete('job-1', 100, 9000);
    const j = await store.get('job-1');
    expect(j?.status).toBe('complete');
    expect(j?.completedAt).toBe(9000);
    expect(j?.rowsRewritten).toBe(100);
    expect(j?.updatedAt).toBe(9000);
  });

  it('markFailed sets status and errorMessage', async () => {
    const store = new InMemoryRewriteJobStore();
    await store.upsert(makeJob());
    await store.markFailed('job-1', 'spec missing', 7000);
    const j = await store.get('job-1');
    expect(j?.status).toBe('failed');
    expect(j?.errorMessage).toBe('spec missing');
    expect(j?.updatedAt).toBe(7000);
  });

  it('list honours limit and offset', async () => {
    const store = new InMemoryRewriteJobStore();
    for (let i = 0; i < 5; i++) {
      await store.upsert(makeJob({ id: `j-${i}`, createdAt: i }));
    }
    const page = await store.list({ limit: 2, offset: 1 });
    expect(page.length).toBe(2);
    // sorted desc by createdAt: 4,3,2,1,0 → offset 1, limit 2 → [3, 2]
    expect(page.map((r) => r.id)).toEqual(['j-3', 'j-2']);
  });
});
