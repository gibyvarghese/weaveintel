/**
 * Shared conformance ("contract") tests for the run-substrate ports.
 *
 * The mid-2026 ports-&-adapters research recommends writing the invariants ONCE
 * as an exported factory that every adapter runs against itself. That is exactly
 * what licenses the in-memory KV adapter as a fast test double AND guarantees the
 * host application's SQL adapter behaves identically — both must pass this same suite.
 *
 * To keep `@weaveintel/core` free of a `vitest` import in non-test source, the
 * factory takes the test primitives ({@link ContractTestApi}) as an argument;
 * each adapter's test file passes vitest's `describe`/`it`/`expect`/`beforeEach`.
 *
 * --- For someone new to this ---
 * A "contract test" is a checklist of behaviours that any implementation of an
 * interface must satisfy (e.g. "append then read returns what you appended").
 * Writing it once and running it against every implementation is how you prove
 * two different storage backends (a key-value store and a SQL database) are
 * truly interchangeable.
 */
import type { RunRegistry } from './run-registry.js';
import type { RunJournal } from './run-journal.js';
import type { RunEventEnvelope } from './run-events.js';
import type { RunHandle } from './runs.js';
import type { ExecutionContext } from './context.js';

/** The slice of a test runner (e.g. vitest) the contract needs. */
export interface ContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  // Loosely typed to avoid coupling core to a matcher library's types.
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    toBeNull(): void;
    toBeGreaterThan(v: number): void;
    rejects: { toThrow(matcher?: unknown): Promise<void> };
    [k: string]: unknown;
  };
}

/** Build a minimal ExecutionContext carrying a tenant id (for the contract). */
function ctxFor(tenantId: string): ExecutionContext {
  return { metadata: { tenantId } } as unknown as ExecutionContext;
}

function handle(runId: string, tenantId: string, principalId: string, over: Partial<RunHandle> = {}): RunHandle {
  const now = new Date().toISOString();
  return {
    runId, tenantId, principalId,
    origin: 'interactive',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    lastSequence: 0,
    ...over,
  } as RunHandle;
}

function envelope(runId: string, sequence: number, kind = 'text.delta'): RunEventEnvelope {
  return { runId, sequence, kind, payload: { i: sequence } } as RunEventEnvelope;
}

/**
 * Conformance suite for any {@link RunRegistry} adapter.
 * @param make returns a fresh, empty registry per test.
 */
export function runRegistryContract(make: () => RunRegistry | Promise<RunRegistry>, t: ContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('RunRegistry contract', () => {
    let reg: RunRegistry;
    beforeEach(async () => { reg = await make(); });

    it('register then get returns the handle (tenant-scoped)', async () => {
      const ctx = ctxFor('tA');
      await reg.register(ctx, handle('r1', 'tA', 'u1'));
      const got = await reg.get(ctx, 'r1');
      expect(got?.runId).toBe('r1');
      expect(got?.status).toBe('running');
    });

    it('get returns null for an unknown run', async () => {
      expect(await reg.get(ctxFor('tA'), 'nope')).toBeNull();
    });

    it('a run registered under tenant A is invisible to tenant B', async () => {
      await reg.register(ctxFor('tA'), handle('r1', 'tA', 'u1'));
      expect(await reg.get(ctxFor('tB'), 'r1')).toBeNull();
    });

    it('register rejects a handle whose tenant differs from the caller', async () => {
      await expect(reg.register(ctxFor('tA'), handle('r1', 'tB', 'u1'))).rejects.toThrow();
    });

    it('updateStatus advances status + sets completedAt on terminal', async () => {
      const ctx = ctxFor('tA');
      await reg.register(ctx, handle('r1', 'tA', 'u1'));
      const done = await reg.updateStatus(ctx, 'r1', 'completed', { sequence: 5 });
      expect(done.status).toBe('completed');
      expect(typeof done.completedAt).toBe('string');
      expect(done.lastSequence).toBe(5);
    });

    it('updateStatus is idempotent for the same (status, sequence)', async () => {
      const ctx = ctxFor('tA');
      await reg.register(ctx, handle('r1', 'tA', 'u1'));
      await reg.updateStatus(ctx, 'r1', 'running', { sequence: 3, progress: 0.5 });
      const again = await reg.updateStatus(ctx, 'r1', 'running', { sequence: 3, progress: 0.9 });
      expect(again.progress).toBe(0.5); // second apply is a no-op
    });

    it('updateStatus on an unknown run rejects', async () => {
      await expect(reg.updateStatus(ctxFor('tA'), 'ghost', 'completed')).rejects.toThrow();
    });

    it('listByPrincipal returns only that principal\'s runs, newest first', async () => {
      const ctx = ctxFor('tA');
      await reg.register(ctx, handle('r1', 'tA', 'u1', { createdAt: '2026-01-01T00:00:00Z' }));
      await reg.register(ctx, handle('r2', 'tA', 'u1', { createdAt: '2026-02-01T00:00:00Z' }));
      await reg.register(ctx, handle('r3', 'tA', 'u2'));
      const list = await reg.listByPrincipal(ctx, 'u1');
      expect(list.length).toBe(2);
      expect(list[0]!.runId).toBe('r2'); // newest first
    });

    it('markSequence advances lastSequence but never regresses it', async () => {
      const ctx = ctxFor('tA');
      await reg.register(ctx, handle('r1', 'tA', 'u1'));
      await reg.markSequence(ctx, 'r1', 10);
      await reg.markSequence(ctx, 'r1', 4); // lower — ignored
      expect((await reg.get(ctx, 'r1'))?.lastSequence).toBe(10);
    });
  });
}

/**
 * Conformance suite for any {@link RunJournal} adapter.
 * @param make returns a fresh, empty journal per test.
 */
export function runJournalContract(make: () => RunJournal | Promise<RunJournal>, t: ContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('RunJournal contract', () => {
    let jr: RunJournal;
    beforeEach(async () => { jr = await make(); });

    it('append then readAfter(-1) returns events in order', async () => {
      for (let i = 0; i < 3; i++) await jr.append(envelope('r1', i));
      const events = await jr.readAfter({ runId: 'r1', afterSequence: -1 });
      expect(events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    });

    it('readAfter is EXCLUSIVE of the cursor', async () => {
      for (let i = 0; i < 4; i++) await jr.append(envelope('r1', i));
      const events = await jr.readAfter({ runId: 'r1', afterSequence: 1 });
      expect(events.map((e) => e.sequence)).toEqual([2, 3]);
    });

    it('readAfter honours the limit', async () => {
      for (let i = 0; i < 5; i++) await jr.append(envelope('r1', i));
      const events = await jr.readAfter({ runId: 'r1', afterSequence: -1 }, { limit: 2 });
      expect(events.length).toBe(2);
    });

    it('journals are isolated by runId', async () => {
      await jr.append(envelope('rA', 0));
      await jr.append(envelope('rB', 0));
      expect((await jr.readAfter({ runId: 'rA', afterSequence: -1 })).length).toBe(1);
    });

    it('purgeRun removes a run\'s events', async () => {
      await jr.append(envelope('r1', 0));
      await jr.purgeRun('r1');
      expect((await jr.readAfter({ runId: 'r1', afterSequence: -1 })).length).toBe(0);
    });

    it('readAfter on an empty/unknown run returns []', async () => {
      expect((await jr.readAfter({ runId: 'ghost', afterSequence: -1 })).length).toBe(0);
    });
  });
}
