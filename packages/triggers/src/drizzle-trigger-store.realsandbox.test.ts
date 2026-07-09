// SPDX-License-Identifier: MIT
/**
 * The ONE Drizzle trigger implementation, proven on a REAL Postgres (Testcontainers — a throwaway
 * container, no mocks). Skipped automatically when Docker isn't available.
 *
 *   1. The SHARED contract — the exact battery the in-memory reference and SQLite adapter pass — now on
 *      real Postgres. (The Postgres adapter was previously never run against a database in this package.)
 *   2. Stress — 2,000 triggers + a 5,000-row invocation ledger stay correct and paginate quickly.
 *   3. Security — hostile keys/config are stored as data.
 *   4. REAL LLM — a model designs an automation rule; we store it and record a firing.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { Trigger } from './dispatcher.js';
import { weavePostgresTriggerStore } from './postgres-trigger-store.js';
import { triggerStoreContract } from './trigger-store-contract.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../.env', '../../.env', '../.env']) {
    try { const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m); if (m) return m[1]!.trim().replace(/^["']|["']$/g, ''); } catch { /* */ }
  }
  return undefined;
}
const KEY = loadKey();

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;
const mkTrigger = (over: Partial<Trigger> = {}): Trigger =>
  ({ id: uid('trg'), key: uid('key'), enabled: true, source: { kind: 'manual', config: {} }, target: { kind: 'workflow', config: { workflowId: 'wf-1' } }, ...over } as Trigger);

describe.skipIf(!HAS_DOCKER)('Drizzle trigger store → real Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await weavePostgresTriggerStore({ pool }); // create the schema once
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  // 1) The SAME contract — now on Postgres. Distinct ids/keys per test → the shared tables are fine.
  describe('Drizzle → Postgres', () => {
    triggerStoreContract(() => weavePostgresTriggerStore({ pool, ensureSchema: false }), { describe, it, beforeEach, expect } as never);
  });

  // 2) Stress: a big rule set + a busy invocation ledger.
  it('STRESS: 2,000 triggers + a 5,000-row invocation ledger stay correct and paginate', async () => {
    const store = await weavePostgresTriggerStore({ pool, ensureSchema: false });
    const owner = uid('owner');
    const t0 = Date.now();
    for (let i = 0; i < 2000; i += 100) {
      await Promise.all(Array.from({ length: 100 }, (_, j) => {
        const n = i + j;
        return store.save(mkTrigger({ key: `stress-${owner}-${n}`, ownerPrincipalId: n % 3 === 0 ? owner : uid('other'), enabled: n % 2 === 0 }));
      }));
    }
    const mine = await store.listByOwner(owner);
    expect(mine.length).toBe(Math.floor(2000 / 3) + 1); // n % 3 === 0 → 0,3,6,…

    const trg = mkTrigger();
    await store.save(trg);
    for (let i = 0; i < 5000; i += 500) {
      await Promise.all(Array.from({ length: 500 }, (_, j) => store.recordInvocation({ id: `inv-${trg.id}-${i + j}`, triggerId: trg.id, firedAt: 1_700_000_000_000 + i + j, sourceKind: 'manual', status: 'dispatched' })));
    }
    const page = await store.listInvocations({ triggerId: trg.id, limit: 50 });
    expect(page.length).toBe(50);
    expect(page[0]!.firedAt).toBe(1_700_000_000_000 + 4999); // newest first
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  // 3) Security: hostile content is data, not executed.
  it('SECURITY: an injection-laden key/config is stored as data (parameterised)', async () => {
    const store = await weavePostgresTriggerStore({ pool, ensureSchema: false });
    const evil = `'; DROP TABLE triggers; -- "x"`;
    const trg = mkTrigger({ key: `sec-${evil}`, source: { kind: 'webhook', config: { note: evil } } });
    await store.save(trg);
    const got = await store.getByKey(`sec-${evil}`);
    expect(got?.id).toBe(trg.id);
    expect((got?.source.config as { note: string }).note).toBe(evil);
    // Table still works.
    const t2 = mkTrigger();
    await store.save(t2);
    expect((await store.get(t2.id))?.id).toBe(t2.id);
  }, 60_000);

  // 4) REAL LLM: a model designs an automation rule; we persist it and record a firing.
  it.skipIf(!KEY)('REAL LLM: a model designs a trigger rule that is stored and fires', async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Design an automation: "when a new high-value order arrives, start the fulfilment workflow". Reply as strict JSON: {"key": string, "description": string, "workflowId": string}.' }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
    const design = JSON.parse(((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content) as { key: string; description: string; workflowId: string };
    expect(design.key.length).toBeGreaterThan(0);

    const store = await weavePostgresTriggerStore({ pool, ensureSchema: false });
    const trg = mkTrigger({
      key: `${design.key}-${uid('k')}`,
      source: { kind: 'webhook', config: { path: '/orders' } },
      target: { kind: 'workflow', config: { workflowId: design.workflowId } },
      metadata: { description: design.description },
    });
    await store.save(trg);

    // The AI-designed rule round-trips out of Postgres…
    const stored = await store.getByKey(trg.key);
    expect((stored?.target.config as { workflowId: string }).workflowId).toBe(design.workflowId);
    expect((stored?.metadata as { description: string }).description).toBe(design.description);

    // …and firing it leaves a durable audit row.
    await store.recordInvocation({ id: uid('inv'), triggerId: trg.id, firedAt: Date.now(), sourceKind: 'webhook', status: 'dispatched', targetRef: 'run-xyz' });
    const invs = await store.listInvocations({ triggerId: trg.id });
    expect(invs).toHaveLength(1);
    expect(invs[0]!.targetRef).toBe('run-xyz');
  }, 180_000);
});
