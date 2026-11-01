/**
 * The budget gate fails closed on ledger errors (platform-architecture §7.4 item 4;
 * GAPS G-WI-11).
 *
 * Before this fix a throwing `ledger.total` was logged and the check returned, so a
 * ledger outage switched the budget off; the DB-backed adapter also turned a read
 * failure into a $0 total.
 */
import { describe, expect, it } from 'vitest';
import type { CostLeverContext } from './governor.js';
import { CostLedgerUnavailableError, weaveBudgetGate, weaveCostLedgerFromBreakdown } from './budget-gate.js';

const ctx: CostLeverContext = { runId: 'r-1' };
const broken = {
  total: async (): Promise<number> => {
    throw new Error('ledger down');
  },
};

describe('weaveBudgetGate on ledger errors', () => {
  it('denies by default when the ledger throws', async () => {
    const g = weaveBudgetGate({ ledger: broken, ceilingUsd: 1, runIdResolver: (c) => c.runId ?? null, log: () => {} });
    await expect(g.check(ctx)).rejects.toBeInstanceOf(CostLedgerUnavailableError);
  });

  it('denies when the ledger returns a non-finite total', async () => {
    const g = weaveBudgetGate({
      ledger: { total: async () => Number.NaN },
      ceilingUsd: 1,
      runIdResolver: (c) => c.runId ?? null,
      log: () => {},
    });
    await expect(g.check(ctx)).rejects.toBeInstanceOf(CostLedgerUnavailableError);
  });

  it('tells the host so it can alert, then denies', async () => {
    const alerts: string[] = [];
    const g = weaveBudgetGate({
      ledger: broken,
      ceilingUsd: 1,
      runIdResolver: (c) => c.runId ?? null,
      onLedgerFailure: ({ runId }) => {
        alerts.push(runId);
      },
      log: () => {},
    });
    await expect(g.check(ctx)).rejects.toThrow(CostLedgerUnavailableError);
    expect(alerts).toEqual(['r-1']);
  });

  it("only lets the call through when the operator chose onLedgerError: 'allow'", async () => {
    const g = weaveBudgetGate({
      ledger: broken,
      ceilingUsd: 1,
      runIdResolver: (c) => c.runId ?? null,
      onLedgerError: 'allow',
      log: () => {},
    });
    await expect(g.check(ctx)).resolves.toBeUndefined();
  });

  it('the DB-backed adapter surfaces a read failure instead of reporting $0', async () => {
    const led = weaveCostLedgerFromBreakdown({
      readBreakdown: async () => {
        throw new Error('db down');
      },
    });
    await expect(led.total('r-1')).rejects.toThrow('db down');
    const g = weaveBudgetGate({ ledger: led, ceilingUsd: 1, runIdResolver: (c) => c.runId ?? null, log: () => {} });
    await expect(g.check(ctx)).rejects.toBeInstanceOf(CostLedgerUnavailableError);
  });
});
