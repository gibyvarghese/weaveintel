import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { weaveSqliteCostLedger } from './sqlite-cost-ledger.js';
import { weaveSqliteEmbeddingStore } from './sqlite-embedding-store.js';
import type { CostLedgerEntry } from '../types.js';
import type { ToolEmbedding } from '../intent-rag.js';

const now = () => Date.now();

function mkEntry(over: Partial<CostLedgerEntry> = {}): CostLedgerEntry {
  return {
    id: over.id ?? `e-${Math.random().toString(36).slice(2, 10)}`,
    runId: over.runId ?? 'run-1',
    source: over.source ?? 'model',
    lever: over.lever ?? 'model',
    subject: over.subject ?? 'gpt-4o-mini',
    costUsd: over.costUsd ?? 0.01,
    observedAt: over.observedAt ?? now(),
    ...over,
  };
}

function mkEmbedding(over: Partial<ToolEmbedding> = {}): ToolEmbedding {
  return {
    toolKey: over.toolKey ?? 'tool_a',
    modelId: over.modelId ?? 'text-embedding-3-small',
    dimension: over.dimension ?? 4,
    vector: over.vector ?? [0.1, 0.2, 0.3, 0.4],
    descriptionHash: over.descriptionHash ?? 'abc123',
  };
}

describe('weaveSqliteCostLedger', () => {
  it('records entries and computes total + breakdown', async () => {
    const db = new Database(':memory:');
    const ledger = weaveSqliteCostLedger({ database: db });
    await ledger.record(mkEntry({ id: 'a', costUsd: 0.5, source: 'model', subject: 'gpt-4o', lever: 'model', inputTokens: 100, outputTokens: 50 }));
    await ledger.record(mkEntry({ id: 'b', costUsd: 0.25, source: 'tool', subject: 'web_search', lever: 'tool', agentId: 'agent-1' }));
    const total = await ledger.total('run-1');
    expect(total).toBeCloseTo(0.75);
    const bd = await ledger.breakdown('run-1');
    expect(bd.entryCount).toBe(2);
    expect(bd.byLever['model']).toBeCloseTo(0.5);
    expect(bd.byLever['tool']).toBeCloseTo(0.25);
    expect(bd.byModel['gpt-4o']).toBeCloseTo(0.5);
    expect(bd.byAgent['agent-1']).toBeCloseTo(0.25);
    expect(bd.tokens.input).toBe(100);
    expect(bd.tokens.output).toBe(50);
  });

  it('is idempotent on duplicate ids', async () => {
    const ledger = weaveSqliteCostLedger({});
    await ledger.record(mkEntry({ id: 'dup', costUsd: 0.1 }));
    await ledger.record(mkEntry({ id: 'dup', costUsd: 999 }));
    expect(await ledger.total('run-1')).toBeCloseTo(0.1);
  });

  it('isolates runs', async () => {
    const ledger = weaveSqliteCostLedger({});
    await ledger.record(mkEntry({ id: '1', runId: 'r1', costUsd: 1 }));
    await ledger.record(mkEntry({ id: '2', runId: 'r2', costUsd: 2 }));
    expect(await ledger.total('r1')).toBeCloseTo(1);
    expect(await ledger.total('r2')).toBeCloseTo(2);
  });

  it('round-trips metadata JSON', async () => {
    const ledger = weaveSqliteCostLedger({});
    await ledger.record(mkEntry({ id: 'm', metadata: { foo: 'bar', n: 42 } }));
    const bd = await ledger.breakdown('run-1');
    expect(bd.entries[0]?.metadata).toEqual({ foo: 'bar', n: 42 });
  });

  it('returns 0 for unknown run', async () => {
    const ledger = weaveSqliteCostLedger({});
    expect(await ledger.total('nope')).toBe(0);
    const bd = await ledger.breakdown('nope');
    expect(bd.entryCount).toBe(0);
    expect(bd.entries).toEqual([]);
  });
});

describe('weaveSqliteEmbeddingStore', () => {
  it('upserts and retrieves by tool_key', async () => {
    const store = weaveSqliteEmbeddingStore({});
    await store.upsert(mkEmbedding({ toolKey: 'a', vector: [1, 0, 0, 0] }));
    const got = await store.get('a');
    expect(got?.toolKey).toBe('a');
    expect(got?.vector).toEqual([1, 0, 0, 0]);
    expect(got?.dimension).toBe(4);
  });

  it('upsert updates existing row', async () => {
    const store = weaveSqliteEmbeddingStore({});
    await store.upsert(mkEmbedding({ toolKey: 'x', descriptionHash: 'h1', vector: [0, 0, 0, 0] }));
    await store.upsert(mkEmbedding({ toolKey: 'x', descriptionHash: 'h2', vector: [9, 9, 9, 9] }));
    const got = await store.get('x');
    expect(got?.descriptionHash).toBe('h2');
    expect(got?.vector).toEqual([9, 9, 9, 9]);
  });

  it('getAll returns all rows', async () => {
    const store = weaveSqliteEmbeddingStore({});
    await store.upsert(mkEmbedding({ toolKey: 'a' }));
    await store.upsert(mkEmbedding({ toolKey: 'b' }));
    const all = await store.getAll();
    expect(all.length).toBe(2);
    const keys = all.map((e) => e.toolKey).sort();
    expect(keys).toEqual(['a', 'b']);
  });

  it('get returns null for missing key', async () => {
    const store = weaveSqliteEmbeddingStore({});
    expect(await store.get('missing')).toBeNull();
  });
});
