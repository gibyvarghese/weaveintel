/**
 * Example 125 — Phase 4: Durability everywhere via `runtime.persistence`.
 *
 * Demonstrates the wired durable-by-default-switchable path:
 *   1. Construct a runtime with a SQLite-backed persistence slot.
 *   2. Enqueue a DLQ record via `createDurableDeadLetterQueue({ runtime })`.
 *   3. Record cost via `createDurableCostMeter({ runtime })`.
 *   4. Dispose runtime → construct a *fresh* runtime on the same path →
 *      assert both records survived (no migration / replay).
 *
 * No DB beyond a tmp SQLite file. No LLM. No external service.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { createDurableDeadLetterQueue } from '@weaveintel/resilience';
import { createDurableCostMeter } from '@weaveintel/workflows';

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wv-ex125-'));
  const dbPath = join(dir, 'wv.db');
  console.log(`[ex125] using ${dbPath}`);

  // --- "process A" ---
  const rtA = weaveRuntime({
    installDefaultTracer: false,
    persistence: weaveSqlitePersistence({ path: dbPath }),
  });

  const dlqA = createDurableDeadLetterQueue({ runtime: rtA });
  const meterA = createDurableCostMeter({ runtime: rtA });

  const rec = await dlqA.enqueue({
    type: 'webhook.delivery',
    payload: { url: 'https://example.test/hook', body: { id: 7 } },
    error: 'connect ECONNREFUSED',
    retryCount: 2,
  });
  await meterA.record('run-001', { costUsd: 0.12, source: 'openai:gpt-4o' });
  await meterA.record('run-001', { costUsd: 0.05, source: 'tool:web_search' });

  console.log(`[ex125] enqueued DLQ record ${rec.id}; total cost so far: $${(await meterA.total('run-001')).toFixed(4)}`);

  // --- "process B" — same path, fresh runtime ---
  const rtB = weaveRuntime({
    installDefaultTracer: false,
    persistence: weaveSqlitePersistence({ path: dbPath }),
  });

  const dlqB = createDurableDeadLetterQueue({ runtime: rtB });
  const meterB = createDurableCostMeter({ runtime: rtB });

  const survivors = await dlqB.list();
  const total = await meterB.total('run-001');

  assert.equal(survivors.length, 1, 'DLQ record must survive restart');
  assert.equal(survivors[0]?.id, rec.id, 'DLQ id must match');
  assert.equal(survivors[0]?.retryCount, 2);
  assert.equal(Math.round(total * 100), 17, 'cost total must survive restart');

  console.log(`[ex125] after restart: ${survivors.length} DLQ entry, total $${total.toFixed(4)} ✔`);

  rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
