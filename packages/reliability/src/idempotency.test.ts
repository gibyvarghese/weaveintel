import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDurableIdempotencyStore, type DurableIdempotencyEntry, type DurableIdempotencyRepository } from './idempotency.js';

class FakeDurableRepository implements DurableIdempotencyRepository {
  private readonly entries = new Map<string, DurableIdempotencyEntry & { createdAt: number }>();

  async get(key: string): Promise<DurableIdempotencyEntry | null> {
    const entry = this.entries.get(key);
    return entry ? { result: entry.result, expiresAt: entry.expiresAt } : null;
  }

  async set(key: string, entry: DurableIdempotencyEntry): Promise<void> {
    this.entries.set(key, { ...entry, createdAt: Date.now() });
  }

  async deleteExpired(nowMs: number): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) {
        this.entries.delete(key);
      }
    }
  }

  async trimOldest(maxEntries: number): Promise<void> {
    const survivors = [...this.entries.entries()]
      .sort((a, b) => b[1].createdAt - a[1].createdAt)
      .slice(0, maxEntries);
    this.entries.clear();
    for (const [key, entry] of survivors) {
      this.entries.set(key, entry);
    }
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

describe('createDurableIdempotencyStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replays the previously recorded result for duplicate keys', async () => {
    const repo = new FakeDurableRepository();
    const store = createDurableIdempotencyStore({ ttlMs: 60_000, maxEntries: 10 }, repo);

    await store.record('hypotheses:key-1', { id: 'hv-1', status: 'queued' });
    const check = await store.check('hypotheses:key-1');

    expect(check.isDuplicate).toBe(true);
    expect(check.previousResult).toEqual({ id: 'hv-1', status: 'queued' });
  });

  it('expires and trims durable entries using repository callbacks', async () => {
    const repo = new FakeDurableRepository();
    const store = createDurableIdempotencyStore({ ttlMs: 1_000, maxEntries: 1 }, repo);
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValueOnce(1_000);
    await store.record('first', { id: '1' });

    now.mockReturnValueOnce(2_000);
    await store.record('second', { id: '2' });

    now.mockReturnValue(2_000);
    const first = await store.check('first');
    const second = await store.check('second');

    expect(first.isDuplicate).toBe(false);
    expect(second.isDuplicate).toBe(true);
    expect(second.previousResult).toEqual({ id: '2' });
  });
});