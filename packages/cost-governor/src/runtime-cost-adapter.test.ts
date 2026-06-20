// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach } from 'vitest';
import { createRuntimeCostAdapter } from './runtime-cost-adapter.js';
import { createInMemoryCostLedger } from './in-memory-ledger.js';
import type { CostLedger } from './types.js';

function makeLedger(): CostLedger {
  return createInMemoryCostLedger();
}

async function seedSpend(ledger: CostLedger, entityId: string, costUsd: number): Promise<void> {
  await ledger.record({
    id: 'seed-1',
    runId: entityId,
    source: 'model',
    lever: 'model',
    subject: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 50,
    costUsd,
    observedAt: Date.now(),
  });
}

describe('createRuntimeCostAdapter — structural shape', () => {
  it('returns gate, record, and getBudgetStatus', () => {
    const adapter = createRuntimeCostAdapter({ ledger: makeLedger(), globalLimitUsd: null });
    expect(typeof adapter.gate).toBe('function');
    expect(typeof adapter.record).toBe('function');
    expect(typeof adapter.getBudgetStatus).toBe('function');
  });
});

describe('gate()', () => {
  it('allows when globalLimitUsd is null (no limit configured)', async () => {
    const adapter = createRuntimeCostAdapter({ ledger: makeLedger(), globalLimitUsd: null });
    const result = await adapter.gate({ userId: 'u1', tenantId: null });
    expect(result.allowed).toBe(true);
  });

  it('allows when spend is under limit', async () => {
    const ledger = makeLedger();
    await seedSpend(ledger, 'u1', 0.05);
    const adapter = createRuntimeCostAdapter({ ledger, globalLimitUsd: 1.0 });
    const result = await adapter.gate({ userId: 'u1', tenantId: null });
    expect(result.allowed).toBe(true);
  });

  it('denies when spend equals limit', async () => {
    const ledger = makeLedger();
    await seedSpend(ledger, 'u1', 1.0);
    const adapter = createRuntimeCostAdapter({ ledger, globalLimitUsd: 1.0 });
    const result = await adapter.gate({ userId: 'u1', tenantId: null });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Spending limit');
  });

  it('denies when spend exceeds limit', async () => {
    const ledger = makeLedger();
    await seedSpend(ledger, 'u1', 2.5);
    const adapter = createRuntimeCostAdapter({ ledger, globalLimitUsd: 1.0 });
    const result = await adapter.gate({ userId: 'u1', tenantId: null });
    expect(result.allowed).toBe(false);
  });

  it('uses tenantId as entity key when present (tenant budget pooling)', async () => {
    const ledger = makeLedger();
    // Seed spend under the TENANT key (not userId)
    await seedSpend(ledger, 'tenant-abc', 0.9);
    const adapter = createRuntimeCostAdapter({ ledger, globalLimitUsd: 1.0 });
    // Different user, same tenant — should see the pooled spend
    const result = await adapter.gate({ userId: 'u2', tenantId: 'tenant-abc' });
    expect(result.allowed).toBe(true); // 0.9 < 1.0
    // Seed another 0.2 to push over
    await seedSpend(ledger, 'tenant-abc', 0.2);
    const over = await adapter.gate({ userId: 'u3', tenantId: 'tenant-abc' });
    expect(over.allowed).toBe(false);
  });

  it('isolates tenantId=null users by userId', async () => {
    const ledger = makeLedger();
    await seedSpend(ledger, 'u1', 1.5);
    const adapter = createRuntimeCostAdapter({ ledger, globalLimitUsd: 1.0 });
    const u1 = await adapter.gate({ userId: 'u1', tenantId: null });
    const u2 = await adapter.gate({ userId: 'u2', tenantId: null });
    expect(u1.allowed).toBe(false);
    expect(u2.allowed).toBe(true); // u2 has no spend
  });

  it('fails open when ledger throws', async () => {
    const brokenLedger: CostLedger = {
      async record() { throw new Error('KV unavailable'); },
      async total() { throw new Error('KV unavailable'); },
      async breakdown() { throw new Error('KV unavailable'); },
    };
    const adapter = createRuntimeCostAdapter({ ledger: brokenLedger, globalLimitUsd: 0.01 });
    const result = await adapter.gate({ userId: 'u1', tenantId: null });
    expect(result.allowed).toBe(true); // fail-open
  });
});

describe('record()', () => {
  it('increments getBudgetStatus().used after a record call', async () => {
    const ledger = makeLedger();
    const adapter = createRuntimeCostAdapter({ ledger, globalLimitUsd: 10.0 });
    await adapter.record({ userId: 'u1', tenantId: null, model: 'gpt-4o', provider: 'openai', promptTokens: 100, completionTokens: 50, costUsd: 0.25 });
    const status = await adapter.getBudgetStatus('u1');
    expect(status.used).toBeCloseTo(0.25);
  });

  it('accumulates multiple calls', async () => {
    const ledger = makeLedger();
    const adapter = createRuntimeCostAdapter({ ledger, globalLimitUsd: 10.0 });
    await adapter.record({ userId: 'u1', tenantId: null, model: 'gpt-4o', provider: 'openai', promptTokens: 100, completionTokens: 50, costUsd: 0.10 });
    await adapter.record({ userId: 'u1', tenantId: null, model: 'gpt-4o', provider: 'openai', promptTokens: 200, completionTokens: 100, costUsd: 0.20 });
    const status = await adapter.getBudgetStatus('u1');
    expect(status.used).toBeCloseTo(0.30);
  });

  it('silently swallows ledger errors without throwing', async () => {
    const brokenLedger: CostLedger = {
      async record() { throw new Error('write failed'); },
      async total() { return 0; },
      async breakdown() { return { runId: '', totalUsd: 0, entryCount: 0, byLever: {} as any, byModel: {}, bySubject: {}, byAgent: {}, tokens: { input: 0, output: 0, cached: 0, reasoning: 0 }, entries: [] }; },
    };
    const adapter = createRuntimeCostAdapter({ ledger: brokenLedger, globalLimitUsd: 10.0 });
    await expect(
      adapter.record({ userId: 'u1', tenantId: null, model: 'gpt-4o', provider: 'openai', promptTokens: 100, completionTokens: 50, costUsd: 0.10 }),
    ).resolves.toBeUndefined(); // must not throw
  });
});

describe('getBudgetStatus()', () => {
  it('returns used=0 when nothing has been recorded', async () => {
    const adapter = createRuntimeCostAdapter({ ledger: makeLedger(), globalLimitUsd: 5.0 });
    const status = await adapter.getBudgetStatus('u1');
    expect(status.used).toBe(0);
    expect(status.limit).toBe(5.0);
    expect(status.period).toBe('lifetime');
  });

  it('returns limit=null when no global limit is configured', async () => {
    const adapter = createRuntimeCostAdapter({ ledger: makeLedger(), globalLimitUsd: null });
    const status = await adapter.getBudgetStatus('u1');
    expect(status.limit).toBeNull();
  });

  it('returns used=0 and does not throw when ledger errors', async () => {
    const brokenLedger: CostLedger = {
      async record() {},
      async total() { throw new Error('read failed'); },
      async breakdown() { throw new Error(); },
    };
    const adapter = createRuntimeCostAdapter({ ledger: brokenLedger, globalLimitUsd: 1.0 });
    const status = await adapter.getBudgetStatus('u1');
    expect(status.used).toBe(0);
  });
});

describe('gate() → record() round-trip', () => {
  it('transitions from allowed to denied after spend accumulates', async () => {
    const ledger = makeLedger();
    const adapter = createRuntimeCostAdapter({ ledger, globalLimitUsd: 0.50 });

    const before = await adapter.gate({ userId: 'u1', tenantId: null });
    expect(before.allowed).toBe(true);

    await adapter.record({ userId: 'u1', tenantId: null, model: 'm', provider: 'p', promptTokens: 0, completionTokens: 0, costUsd: 0.60 });

    const after = await adapter.gate({ userId: 'u1', tenantId: null });
    expect(after.allowed).toBe(false);
  });
});
