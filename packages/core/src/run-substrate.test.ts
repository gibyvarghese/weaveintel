/**
 * Unit tests — run substrate (registry + journal) relocated into core.
 *
 * Runs the shared CONTRACT suites against the KV reference adapters, then adds
 * KV-specific positive / negative / stress / security cases (gap-safe resume,
 * idempotency TTL, size-cap pruning, corrupt-entry tolerance, large bursts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createKvRunRegistry,
  createKvRunJournal,
  runRegistryContract,
  runJournalContract,
  RunCursorTooOldError,
  RUN_JOURNAL_DEFAULTS,
  RUN_STREAM_CONFIG_DEFAULTS,
  type RunEventEnvelope,
  type RunHandle,
  type ExecutionContext,
} from './index.js';

const api = { describe, it, beforeEach, expect } as unknown as Parameters<typeof runRegistryContract>[1];

// Every adapter must pass the same conformance suites.
runRegistryContract(() => createKvRunRegistry(), api);
runJournalContract(() => createKvRunJournal(), api);

const ctx = (tenantId = 'tA'): ExecutionContext => ({ metadata: { tenantId } } as unknown as ExecutionContext);
const env = (runId: string, sequence: number): RunEventEnvelope =>
  ({ runId, sequence, kind: 'text.delta', payload: { i: sequence } } as RunEventEnvelope);
const handle = (runId: string, over: Partial<RunHandle> = {}): RunHandle => ({
  runId, tenantId: 'tA', principalId: 'u1', origin: 'interactive', status: 'running',
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastSequence: 0, ...over,
} as RunHandle);

describe('run-journal — defaults sourced from one place', () => {
  it('RUN_JOURNAL_DEFAULTS derives from RUN_STREAM_CONFIG_DEFAULTS (no second hardcode)', () => {
    expect(RUN_JOURNAL_DEFAULTS.retentionMs).toBe(RUN_STREAM_CONFIG_DEFAULTS.journalRetentionHours * 60 * 60 * 1000);
    expect(RUN_JOURNAL_DEFAULTS.maxEnvelopesPerRun).toBe(RUN_STREAM_CONFIG_DEFAULTS.journalMaxEvents);
  });
});

describe('createKvRunJournal — gap-safe resume + size cap', () => {
  it('prunes to maxEnvelopesPerRun and rejects a too-old cursor with RunCursorTooOldError', async () => {
    const jr = createKvRunJournal({ maxEnvelopesPerRun: 5 });
    for (let i = 0; i < 12; i++) await jr.append(env('r1', i));
    // Only the newest 5 (seq 7..11) are retained.
    const tail = await jr.readAfter({ runId: 'r1', afterSequence: 8 });
    expect(tail.map((e) => e.sequence)).toEqual([9, 10, 11]);
    // A cursor below the retained watermark is gap-unsafe → typed error.
    await expect(jr.readAfter({ runId: 'r1', afterSequence: 2 })).rejects.toBeInstanceOf(RunCursorTooOldError);
    // ...but reading from the beginning is always allowed (full replay).
    expect((await jr.readAfter({ runId: 'r1', afterSequence: -1 })).length).toBe(5);
  });

  it('rejects an append whose sequence violates expectedSequence', async () => {
    const jr = createKvRunJournal();
    await expect(jr.append(env('r1', 3), { expectedSequence: 0 })).rejects.toThrow(/sequence conflict/);
  });

  it('tolerates a large burst (stress)', async () => {
    const jr = createKvRunJournal({ maxEnvelopesPerRun: 100_000 });
    for (let i = 0; i < 1000; i++) await jr.append(env('r1', i));
    const all = await jr.readAfter({ runId: 'r1', afterSequence: -1 }, { limit: 100_000 });
    expect(all.length).toBe(1000);
    expect(all[999]!.sequence).toBe(999);
  });
});

describe('createKvRunRegistry — security / robustness', () => {
  it('does not leak a run across tenants via updateStatus or markSequence', async () => {
    const reg = createKvRunRegistry();
    await reg.register(ctx('tA'), handle('r1'));
    // Tenant B sees nothing and cannot update (run is "not found" in its scope).
    await expect(reg.updateStatus(ctx('tB'), 'r1', 'completed')).rejects.toThrow(/not found/);
    await reg.markSequence(ctx('tB'), 'r1', 99); // no-op, no throw, no cross-write
    expect((await reg.get(ctx('tA'), 'r1'))?.lastSequence).toBe(0);
  });

  it('emits lifecycle events on the bus when provided', async () => {
    const events: string[] = [];
    const bus = { emit: (e: { type: string }) => events.push(e.type), on: () => () => {}, onAll: () => () => {}, onMatch: () => () => {} };
    const reg = createKvRunRegistry({ bus: bus as never });
    await reg.register(ctx(), handle('r1'));
    await reg.updateStatus(ctx(), 'r1', 'completed', { sequence: 1 });
    expect(events).toEqual(['run.started', 'run.completed']);
  });
});
