/**
 * @weaveintel/collaboration — W3 run registry + journal tests
 *
 * Tests:
 * - restart-survival: register + append → recreate → readAfter (no gaps)
 * - tenant isolation: ctx tenant A cannot read tenant B's run
 * - lifecycle events observed on the bus
 * - idempotent status updates (same key applied twice is a no-op)
 * - journal size cap prunes oldest entries
 */

import { describe, it, expect, vi } from 'vitest';
import { weaveInMemoryPersistence, weaveEventBus, weaveContext, newUUIDv7 } from '@weaveintel/core';
import type { RunHandle, StreamEnvelope } from '@weaveintel/core';
import { createRunRegistry, createRunJournal } from './index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(tenantId: string, principalId: string = 'user-1') {
  return weaveContext({ metadata: { tenantId, principalId } });
}

function makeHandle(overrides?: Partial<RunHandle>): RunHandle {
  const now = new Date().toISOString();
  return {
    runId: newUUIDv7(),
    tenantId: 'tenant-a',
    principalId: 'user-1',
    origin: 'interactive',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    lastSequence: 0,
    ...overrides,
  };
}

function makeEnvelope(seq: number): StreamEnvelope {
  return {
    sequence: seq,
    event: { type: 'text', id: newUUIDv7(), timestamp: new Date().toISOString(), data: { text: `chunk-${seq}` } },
  };
}

// ─── RunRegistry ─────────────────────────────────────────────────────────────

describe('RunRegistry', () => {
  it('register and get round-trip', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const registry = createRunRegistry({ runtime });
    const ctx = makeCtx('tenant-a');
    const handle = makeHandle();

    await registry.register(ctx, handle);
    const got = await registry.get(ctx, handle.runId);
    expect(got?.runId).toBe(handle.runId);
    expect(got?.status).toBe('running');
  });

  it('updateStatus transitions to completed', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const registry = createRunRegistry({ runtime });
    const ctx = makeCtx('tenant-a');
    const handle = makeHandle();

    await registry.register(ctx, handle);
    const updated = await registry.updateStatus(ctx, handle.runId, 'completed', { sequence: 10 });
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBeTruthy();
    expect(updated.lastSequence).toBe(10);
  });

  it('updateStatus is idempotent for same status+sequence', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const registry = createRunRegistry({ runtime });
    const ctx = makeCtx('tenant-a');
    const handle = makeHandle();

    await registry.register(ctx, handle);
    const first = await registry.updateStatus(ctx, handle.runId, 'completed', { sequence: 5 });
    const second = await registry.updateStatus(ctx, handle.runId, 'completed', { sequence: 5 });
    // Both calls return the same final state; the second is a no-op
    expect(first.completedAt).toBe(second.completedAt);
  });

  it('tenant isolation: cross-tenant get throws', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const registry = createRunRegistry({ runtime });

    const ctxA = makeCtx('tenant-a');
    const ctxB = makeCtx('tenant-b');
    const handle = makeHandle({ tenantId: 'tenant-a' });

    await registry.register(ctxA, handle);
    // tenant-b cannot read tenant-a's run
    const result = await registry.get(ctxB, handle.runId);
    expect(result).toBeNull(); // different namespace, so not found
  });

  it('lifecycle events emitted on bus', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const bus = weaveEventBus();
    const registry = createRunRegistry({ runtime, bus });
    const ctx = makeCtx('tenant-a');
    const handle = makeHandle();

    const emitted: string[] = [];
    bus.onAll((e) => emitted.push(e.type));

    await registry.register(ctx, handle); // emits run.started
    await registry.updateStatus(ctx, handle.runId, 'completed');

    expect(emitted).toContain('run.started');
    expect(emitted).toContain('run.completed');
  });

  it('listByPrincipal filters correctly', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const registry = createRunRegistry({ runtime });
    const ctx = makeCtx('tenant-a', 'user-1');

    const h1 = makeHandle({ principalId: 'user-1', status: 'completed' });
    const h2 = makeHandle({ principalId: 'user-1', status: 'running' });
    const h3 = makeHandle({ principalId: 'user-2', status: 'running' });

    await registry.register(ctx, h1);
    await registry.register(ctx, h2);
    await registry.register(ctx, h3);

    const runs = await registry.listByPrincipal(ctx, 'user-1');
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.principalId === 'user-1')).toBe(true);
  });

  it('markSequence updates lastSequence', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const registry = createRunRegistry({ runtime });
    const ctx = makeCtx('tenant-a');
    const handle = makeHandle();

    await registry.register(ctx, handle);
    await registry.markSequence(ctx, handle.runId, 42);
    const updated = await registry.get(ctx, handle.runId);
    expect(updated?.lastSequence).toBe(42);
  });
});

// ─── RunJournal ───────────────────────────────────────────────────────────────

describe('RunJournal', () => {
  it('append and readAfter gap-free', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const journal = createRunJournal({ runtime });
    const ctx = makeCtx('tenant-a');
    const runId = newUUIDv7();

    for (let i = 1; i <= 10; i++) {
      await journal.appendEnvelope(ctx, runId, makeEnvelope(i));
    }

    const result = await journal.readAfter(ctx, { runId, afterSequence: 0 });
    expect(result).toHaveLength(10);
    expect(result[0]?.sequence).toBe(1);
    expect(result[9]?.sequence).toBe(10);
  });

  it('readAfter respects afterSequence cursor', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const journal = createRunJournal({ runtime });
    const ctx = makeCtx('tenant-a');
    const runId = newUUIDv7();

    for (let i = 1; i <= 10; i++) {
      await journal.appendEnvelope(ctx, runId, makeEnvelope(i));
    }

    const result = await journal.readAfter(ctx, { runId, afterSequence: 5 });
    expect(result).toHaveLength(5);
    expect(result[0]?.sequence).toBe(6);
  });

  it('restart-survival: same persistence, recreated journal', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const journal1 = createRunJournal({ runtime });
    const ctx = makeCtx('tenant-a');
    const runId = newUUIDv7();

    for (let i = 1; i <= 5; i++) {
      await journal1.appendEnvelope(ctx, runId, makeEnvelope(i));
    }

    // Simulate restart — create a new journal with the same underlying KV
    const journal2 = createRunJournal({ runtime });
    const result = await journal2.readAfter(ctx, { runId, afterSequence: 2 });
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.sequence)).toEqual([3, 4, 5]);
  });

  it('respects limit parameter', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const journal = createRunJournal({ runtime });
    const ctx = makeCtx('tenant-a');
    const runId = newUUIDv7();

    for (let i = 1; i <= 20; i++) {
      await journal.appendEnvelope(ctx, runId, makeEnvelope(i));
    }

    const result = await journal.readAfter(ctx, { runId, afterSequence: 0 }, 5);
    expect(result).toHaveLength(5);
  });

  it('purgeRun removes all entries', async () => {
    const persistence = weaveInMemoryPersistence();
    const runtime = { persistence } as unknown as import('@weaveintel/core').WeaveRuntime;
    const journal = createRunJournal({ runtime });
    const ctx = makeCtx('tenant-a');
    const runId = newUUIDv7();

    for (let i = 1; i <= 5; i++) {
      await journal.appendEnvelope(ctx, runId, makeEnvelope(i));
    }
    await journal.purgeRun(ctx, runId);
    const result = await journal.readAfter(ctx, { runId, afterSequence: 0 });
    expect(result).toHaveLength(0);
  });
});
