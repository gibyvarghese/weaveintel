import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { createDurableDeadLetterQueue } from './dead-letter.js';

/**
 * Phase 4 §12.3: "a DLQ entry persists across process restart."
 *
 * Construct runtime A on a SQLite-backed slot, enqueue a record. Discard
 * the runtime entirely. Construct runtime B on the same path. The record
 * must be readable from runtime B with no migration / replay code.
 */
describe('durable DLQ — restart survival', () => {
  it('records survive a fresh runtime backed by the same sqlite path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wv-dlq-'));
    const dbPath = join(dir, 'wv.db');

    try {
      // --- "process A" ---
      const rtA = weaveRuntime({
        installDefaultTracer: false,
        persistence: weaveSqlitePersistence({ path: dbPath }),
      });
      const dlqA = createDurableDeadLetterQueue({ runtime: rtA, namespace: 'test-dlq' });
      const rec = await dlqA.enqueue({
        type: 'webhook.delivery',
        payload: { url: 'https://example.test/hook', body: { id: 42 } },
        error: 'connect ECONNREFUSED',
        retryCount: 3,
      });
      expect(rec.resolved).toBe(false);

      // --- "process B" — same backend path, different runtime instance ---
      const rtB = weaveRuntime({
        installDefaultTracer: false,
        persistence: weaveSqlitePersistence({ path: dbPath }),
      });
      const dlqB = createDurableDeadLetterQueue({ runtime: rtB, namespace: 'test-dlq' });

      const all = await dlqB.list();
      expect(all).toHaveLength(1);
      expect(all[0]?.id).toBe(rec.id);
      expect(all[0]?.type).toBe('webhook.delivery');
      expect(all[0]?.retryCount).toBe(3);
      expect(all[0]?.resolved).toBe(false);

      // resolution from B should also persist
      expect(await dlqB.dequeue(rec.id)).toBe(true);

      const rtC = weaveRuntime({
        installDefaultTracer: false,
        persistence: weaveSqlitePersistence({ path: dbPath }),
      });
      const dlqC = createDurableDeadLetterQueue({ runtime: rtC, namespace: 'test-dlq' });
      const after = await dlqC.list();
      expect(after[0]?.resolved).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to in-memory KV when no runtime is supplied (zero-config DX)', async () => {
    const dlq = createDurableDeadLetterQueue();
    const rec = await dlq.enqueue({
      type: 't',
      payload: { x: 1 },
      error: 'boom',
      retryCount: 0,
    });
    const all = await dlq.list();
    expect(all.map((r) => r.id)).toContain(rec.id);
  });
});
