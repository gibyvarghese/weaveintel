import { describe, it, expect } from 'vitest';
import { aggregate, computeUsd, createInMemoryCostLedger, weaveCostLedger } from './index.js';
import type { CostLedgerEntry, CostLedgerSink } from './index.js';

const E = (over: Partial<CostLedgerEntry> = {}): CostLedgerEntry => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  runId: 'run-1',
  source: 'model',
  lever: 'model',
  subject: 'gpt-4o-mini',
  costUsd: 0.001,
  observedAt: Date.now(),
  ...over,
});

describe('computeUsd', () => {
  it('returns 0 for missing rate', () => {
    expect(computeUsd({ modelId: 'x', inputTokens: 1000, outputTokens: 1000 }, null)).toBe(0);
  });
  it('computes input+output cost', () => {
    const rate = { inputPerMillion: 1, outputPerMillion: 2 };
    expect(computeUsd({ modelId: 'x', inputTokens: 1_000_000, outputTokens: 500_000 }, rate)).toBe(2);
  });
});

describe('createInMemoryCostLedger', () => {
  it('records and totals', async () => {
    const l = createInMemoryCostLedger();
    await l.record(E({ costUsd: 0.5 }));
    await l.record(E({ costUsd: 0.25, lever: 'tool', source: 'tool', subject: 'pricing_lookup' }));
    expect(await l.total('run-1')).toBe(0.75);
    const b = await l.breakdown('run-1');
    expect(b.entryCount).toBe(2);
    expect(b.byLever.model).toBe(0.5);
    expect(b.byLever.tool).toBe(0.25);
    expect(b.byModel['gpt-4o-mini']).toBe(0.5);
  });
  it('separates runs', async () => {
    const l = createInMemoryCostLedger();
    await l.record(E({ runId: 'a', costUsd: 1 }));
    await l.record(E({ runId: 'b', costUsd: 2 }));
    expect(await l.total('a')).toBe(1);
    expect(await l.total('b')).toBe(2);
  });
});

describe('aggregate', () => {
  it('rolls up tokens', () => {
    const b = aggregate('r', [
      E({ inputTokens: 100, outputTokens: 50, reasoningTokens: 10 }),
      E({ inputTokens: 200, outputTokens: 100, cachedTokens: 30 }),
    ]);
    expect(b.tokens.input).toBe(300);
    expect(b.tokens.output).toBe(150);
    expect(b.tokens.cached).toBe(30);
    expect(b.tokens.reasoning).toBe(10);
  });
  it('attributes by agentRole when no agentId', () => {
    const b = aggregate('r', [
      E({ agentRole: 'strategist', costUsd: 0.5 }),
      E({ agentRole: 'validator',  costUsd: 0.25 }),
    ]);
    expect(b.byAgent['strategist']).toBe(0.5);
    expect(b.byAgent['validator']).toBe(0.25);
  });
});

describe('weaveCostLedger', () => {
  it('forwards every entry to the sink', async () => {
    const seen: CostLedgerEntry[] = [];
    const sink: CostLedgerSink = { async append(e) { seen.push(e); } };
    const l = weaveCostLedger({ sink });
    await l.record(E({ costUsd: 1 }));
    await l.record(E({ costUsd: 2 }));
    expect(seen).toHaveLength(2);
    expect(await l.total('run-1')).toBe(3);
  });
  it('does not throw if sink throws', async () => {
    const sink: CostLedgerSink = { async append() { throw new Error('boom'); } };
    const l = weaveCostLedger({ sink });
    await expect(l.record(E())).resolves.toBeUndefined();
  });
});
