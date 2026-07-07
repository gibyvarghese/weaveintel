// SPDX-License-Identifier: MIT
/**
 * Hermetic tests for `weaveSharedPostgres` — no Docker, no real database.
 *
 * These cover the hub's *orchestration* and *guardrails*: how it names and isolates KV slots, how it
 * refuses ambiguous/unsafe input, how it reports health, and that it never closes a pool it doesn't
 * own. The real key/value I/O and the full multi-store coexistence run on a real Postgres in
 * `shared-postgres-coexistence.realsandbox.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { weaveSharedPostgres, type SqlClient } from './shared-postgres.js';

/** A tiny recording client. Slots are lazy (they only touch the DB on a kv op), so hub orchestration
 *  — naming, collisions, health, close — is fully testable without a working database. */
class FakeClient implements SqlClient {
  queries: string[] = [];
  ended = 0;
  failSelect1 = false;
  async query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries.push(text);
    if (/SELECT 1/.test(text)) {
      if (this.failSelect1) throw new Error('connection refused');
      return { rows: [{}] };
    }
    return { rows: [] };
  }
  async end(): Promise<void> { this.ended += 1; }
}

describe('weaveSharedPostgres — hub orchestration (hermetic)', () => {
  // ── Positive ────────────────────────────────────────────────────────────────
  it('mints a Postgres KV slot per name, each in its own prefixed table', () => {
    const hub = weaveSharedPostgres({ client: new FakeClient() });
    const dlq = hub.slot('dead-letter-queue');
    const cost = hub.slot('cost-meter');
    expect(dlq.kind).toBe('postgres');
    expect(cost.kind).toBe('postgres');
    expect(hub.registeredTables()).toEqual(['weave_kv_cost_meter', 'weave_kv_dead_letter_queue']);
  });

  it('the same slot name is idempotent — returns the very same slot object', () => {
    const hub = weaveSharedPostgres({ client: new FakeClient() });
    expect(hub.slot('idempotency')).toBe(hub.slot('idempotency'));
    expect(hub.registeredTables()).toEqual(['weave_kv_idempotency']);
  });

  it('a custom tablePrefix lets two hubs share one database without colliding', () => {
    const a = weaveSharedPostgres({ client: new FakeClient(), tablePrefix: 'tenant_a_' });
    const b = weaveSharedPostgres({ client: new FakeClient(), tablePrefix: 'tenant_b_' });
    a.slot('cost');
    b.slot('cost');
    expect(a.registeredTables()).toEqual(['tenant_a_cost']);
    expect(b.registeredTables()).toEqual(['tenant_b_cost']);
  });

  it('reports accurate capabilities (TTL is supported by the slots)', () => {
    const caps = weaveSharedPostgres({ client: new FakeClient() }).capabilities();
    expect(caps).toEqual({ transactions: true, ttl: true, optimisticConcurrency: true, pubsub: true, jsonQuery: true });
  });

  it('health() does a single SELECT 1 round-trip and reports ok + latency', async () => {
    const client = new FakeClient();
    const hub = weaveSharedPostgres({ client });
    const h = await hub.health();
    expect(h.ok).toBe(true);
    expect(typeof h.latencyMs).toBe('number');
    expect(client.queries.some((q) => /SELECT 1/.test(q))).toBe(true);
  });

  // ── Negative ────────────────────────────────────────────────────────────────
  it('health() never throws — a dead connection is reported as { ok:false, error }', async () => {
    const client = new FakeClient();
    client.failSelect1 = true;
    const h = await weaveSharedPostgres({ client }).health();
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/connection refused/);
  });

  it('rejects passing both a client and a connectionString', () => {
    expect(() => weaveSharedPostgres({ client: new FakeClient(), connectionString: 'postgresql://x' }))
      .toThrow(/either .*client.* or .*connectionString/i);
  });

  it('rejects passing neither a client nor a connectionString', () => {
    // `{}` type-checks (both fields are optional), but the runtime guard still refuses it.
    expect(() => weaveSharedPostgres({})).toThrow(/client.*or.*connectionString/i);
  });

  it('a slot name with no letters or digits is refused (nothing to make a table from)', () => {
    const hub = weaveSharedPostgres({ client: new FakeClient() });
    expect(() => hub.slot('!!!')).toThrow(/no letters or digits/i);
  });

  it('an invalid tablePrefix is refused', () => {
    expect(() => weaveSharedPostgres({ client: new FakeClient(), tablePrefix: 'bad-prefix!' }))
      .toThrow(/invalid tablePrefix/i);
  });

  // ── Security / correctness ────────────────────────────────────────────────────
  it('two names that differ only by punctuation/case are caught before they can clobber each other', () => {
    const hub = weaveSharedPostgres({ client: new FakeClient() });
    hub.slot('cost-meter');
    // 'Cost Meter' also sanitises to `weave_kv_cost_meter` → would silently share one table.
    expect(() => hub.slot('Cost Meter')).toThrow(/both map to table/i);
  });

  it('does NOT close a pool it was handed (caller owns the injected connection)', async () => {
    const client = new FakeClient();
    const hub = weaveSharedPostgres({ client });
    await hub.close();
    expect(client.ended).toBe(0); // injected → left open
  });

  it('DOES own and close a pool it created from a connectionString', async () => {
    // pg is a devDependency; the hub lazily creates a real pg.Pool. end() resolves without ever connecting.
    const hub = weaveSharedPostgres({ connectionString: 'postgresql://user:pass@127.0.0.1:5432/none' });
    await expect(hub.close()).resolves.toBeUndefined();
  });
});
