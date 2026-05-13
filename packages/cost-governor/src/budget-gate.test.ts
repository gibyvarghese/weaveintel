/**
 * Phase 7 — Budget Gate unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  CostCeilingExceededError,
  type CostLeverContext,
} from './governor.js';
import { weaveBudgetGate, weaveCostLedgerFromBreakdown } from './budget-gate.js';
import type { CostBreakdown, CostLedger } from './types.js';

function stubLedger(total: number): Pick<CostLedger, 'total'> {
  return { total: async () => total };
}
const ctx: CostLeverContext = { runId: 'r-1' };

describe('weaveBudgetGate', () => {
  it('returns no-op when ceiling ≤ 0', () => {
    const g = weaveBudgetGate({
      ledger: stubLedger(100),
      ceilingUsd: 0,
      runIdResolver: (c) => c.runId ?? null,
    });
    expect(g.check(ctx)).toBeUndefined();
  });

  it('returns no-op when ceiling is NaN', () => {
    const g = weaveBudgetGate({
      ledger: stubLedger(100),
      ceilingUsd: Number.NaN,
      runIdResolver: (c) => c.runId ?? null,
    });
    expect(g.check(ctx)).toBeUndefined();
  });

  it('does not throw when total ≤ ceiling', async () => {
    const g = weaveBudgetGate({
      ledger: stubLedger(0.5),
      ceilingUsd: 1.0,
      runIdResolver: (c) => c.runId ?? null,
    });
    await expect(g.check(ctx)).resolves.toBeUndefined();
  });

  it('throws CostCeilingExceededError with correct fields when total > ceiling', async () => {
    const g = weaveBudgetGate({
      ledger: stubLedger(2.5),
      ceilingUsd: 1.0,
      runIdResolver: (c) => c.runId ?? null,
    });
    try {
      await g.check(ctx);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CostCeilingExceededError);
      const e = err as CostCeilingExceededError;
      expect(e.runId).toBe('r-1');
      expect(e.costUsd).toBe(2.5);
      expect(e.ceilingUsd).toBe(1.0);
    }
  });

  it('skips when runIdResolver returns null', async () => {
    const g = weaveBudgetGate({
      ledger: stubLedger(99),
      ceilingUsd: 1,
      runIdResolver: () => null,
    });
    await expect(g.check(ctx)).resolves.toBeUndefined();
  });

  it('swallows ledger errors and returns (graceful, never load-bearing)', async () => {
    const g = weaveBudgetGate({
      ledger: {
        total: async () => {
          throw new Error('boom');
        },
      },
      ceilingUsd: 1,
      runIdResolver: (c) => c.runId ?? null,
    });
    await expect(g.check(ctx)).resolves.toBeUndefined();
  });

  it('fires onExceed BEFORE throwing', async () => {
    const calls: string[] = [];
    const g = weaveBudgetGate({
      ledger: stubLedger(5),
      ceilingUsd: 1,
      runIdResolver: (c) => c.runId ?? null,
      onExceed: ({ runId }) => {
        calls.push(`exceed:${runId}`);
      },
    });
    await expect(g.check(ctx)).rejects.toThrow(CostCeilingExceededError);
    expect(calls).toEqual(['exceed:r-1']);
  });

  it('does not throw when throwOnExceed=false', async () => {
    const g = weaveBudgetGate({
      ledger: stubLedger(5),
      ceilingUsd: 1,
      runIdResolver: (c) => c.runId ?? null,
      throwOnExceed: false,
      log: () => {},
    });
    await expect(g.check(ctx)).resolves.toBeUndefined();
  });

  it('swallows onExceed callback errors and still throws', async () => {
    const g = weaveBudgetGate({
      ledger: stubLedger(5),
      ceilingUsd: 1,
      runIdResolver: (c) => c.runId ?? null,
      onExceed: () => {
        throw new Error('cb-fail');
      },
      log: () => {},
    });
    await expect(g.check(ctx)).rejects.toThrow(CostCeilingExceededError);
  });
});

describe('weaveCostLedgerFromBreakdown adapter', () => {
  const bd: CostBreakdown = {
    runId: 'r-1',
    totalUsd: 1.234,
    entryCount: 0,
    byLever: {} as CostBreakdown['byLever'],
    byModel: {},
    bySubject: {},
    byAgent: {},
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0 },
    entries: [],
  };

  it('total() reads breakdown.totalUsd', async () => {
    const led = weaveCostLedgerFromBreakdown({ readBreakdown: async () => bd });
    expect(await led.total('r-1')).toBe(1.234);
  });

  it('total() returns 0 when readBreakdown throws', async () => {
    const led = weaveCostLedgerFromBreakdown({
      readBreakdown: async () => {
        throw new Error('db down');
      },
    });
    expect(await led.total('r-1')).toBe(0);
  });

  it('record() is a no-op (writer of record is the sink)', async () => {
    const led = weaveCostLedgerFromBreakdown({ readBreakdown: async () => bd });
    await expect(
      led.record({
        id: 'e-1',
        runId: 'r-1',
        source: 'model',
        lever: 'model',
        subject: 'm-1',
        provider: 'openai',
        costUsd: 5,
        observedAt: Date.now(),
      }),
    ).resolves.toBeUndefined();
  });

  it('breakdown() forwards to readBreakdown', async () => {
    const led = weaveCostLedgerFromBreakdown({ readBreakdown: async () => bd });
    expect(await led.breakdown('r-1')).toBe(bd);
  });
});
