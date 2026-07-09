// SPDX-License-Identifier: MIT
/**
 * The ONE Drizzle checkpoint implementation, proven on a REAL Postgres (Testcontainers — a throwaway
 * container, no mocks). Skipped automatically when Docker isn't available.
 *
 *   1. The SHARED contract — the exact battery the in-memory reference and the SQLite adapter pass —
 *      now on real Postgres. Passing it proves the one Drizzle implementation behaves identically on
 *      both dialects: the whole point of collapsing the two hand-written SQL adapters into one.
 *   2. Stress — 2,000 checkpoints across 100 runs stay correct and fast.
 *   3. Security — a hostile payload is stored as data (Drizzle binds every value).
 *   4. REAL LLM — a durable "resume after crash": an agent does step 1 with a real model, we checkpoint,
 *      then a fresh store loads the checkpoint and the agent continues step 2 from exactly where it was.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import type { WorkflowState } from '@weaveintel/core';
import { weavePostgresCheckpointStore } from './postgres-checkpoint-store.js';
import { checkpointStoreContract } from './checkpoint-store-contract.js';

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

const state = (over: Partial<WorkflowState> = {}): WorkflowState =>
  ({ currentStepId: 'step-1', variables: {}, history: [], ...over } as WorkflowState);

describe.skipIf(!HAS_DOCKER)('Drizzle checkpoint store → real Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await weavePostgresCheckpointStore({ pool }); // create the schema once
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  // 1) The SAME contract — now on Postgres. Distinct run ids per test → the shared table is fine.
  describe('Drizzle → Postgres', () => {
    checkpointStoreContract(
      () => weavePostgresCheckpointStore({ pool, ensureSchema: false }),
      { describe, it, beforeEach, expect } as never,
    );
  });

  // 2) Stress: a busy server — 2,000 checkpoints across 100 runs.
  it('STRESS: 2,000 checkpoints across 100 runs list/latest correctly', async () => {
    const store = await weavePostgresCheckpointStore({ pool, ensureSchema: false });
    const t0 = Date.now();
    for (let r = 0; r < 100; r++) {
      const runId = `stress-run-${r}`;
      for (let s = 0; s < 20; s++) {
        await store.save(runId, `step-${s}`, state({ variables: { r, s } }));
      }
    }
    expect(await store.list('stress-run-42')).toHaveLength(20);
    const latest = await store.latest('stress-run-42');
    expect(latest?.stepId).toBe('step-19'); // the last one saved
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  // 3) Security: a hostile payload is stored as data, not executed.
  it('SECURITY: an injection-laden payload round-trips and cannot drop the table', async () => {
    const store = await weavePostgresCheckpointStore({ pool, ensureSchema: false });
    const evil = `'; DROP TABLE wf_checkpoints; -- ${'x'.repeat(20)}`;
    const cp = await store.save('sec-run', 'step-1', state({ variables: { evil } }));
    const loaded = await store.load(cp.id);
    expect((loaded?.state.variables as { evil: string }).evil).toBe(evil);
    // Table still works.
    const after = await store.save('sec-run', 'step-2', state());
    expect((await store.load(after.id))?.stepId).toBe('step-2');
  }, 60_000);

  // 4) REAL LLM: durable resume across a "crash", on Postgres, via the Drizzle adapter.
  it.skipIf(!KEY)('REAL LLM: an agent checkpoints after step 1 and a fresh store resumes step 2', async () => {
    const chat = async (prompt: string): Promise<string> => {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
      });
      if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
      return ((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
    };

    const runId = 'llm-resume-run';

    // ── Step 1 (on one "process"): extract structured data, then checkpoint the state. ──
    const step1Raw = await chat(
      'Extract the customer and amount from: "Invoice for Globex Corp totals $4,200, net 30." '
      + 'Reply as strict JSON: {"customer": string, "amount": number}.',
    );
    const step1 = JSON.parse(step1Raw) as { customer: string; amount: number };
    expect(step1.amount).toBe(4200);

    const store1 = await weavePostgresCheckpointStore({ pool, ensureSchema: false });
    await store1.save(runId, 'extract', state({ currentStepId: 'extract', variables: { step1 } }));

    // ── "Crash": a brand-new store instance loads the durable state from Postgres. ──
    const store2 = await weavePostgresCheckpointStore({ pool, ensureSchema: false });
    const resumed = await store2.latest(runId);
    expect(resumed?.stepId).toBe('extract');
    const carried = (resumed!.state.variables as { step1: { customer: string; amount: number } }).step1;
    expect(carried.amount).toBe(4200); // the earlier LLM result survived the "crash"

    // ── Step 2: continue from exactly where we left off, using the resumed data. ──
    const step2Raw = await chat(
      `A customer named "${carried.customer}" owes $${carried.amount}. `
      + 'Reply as strict JSON: {"reminder": a one-sentence friendly payment reminder mentioning the amount}.',
    );
    const step2 = JSON.parse(step2Raw) as { reminder: string };
    // The amount the FIRST step extracted appears in the reminder (comma formatting varies by model).
    expect(step2.reminder.replace(/,/g, '')).toContain('4200');

    await store2.save(runId, 'notify', state({ currentStepId: 'notify', variables: { step1: carried, step2 } }));
    const finalCp = await store2.latest(runId);
    expect(finalCp?.stepId).toBe('notify');
    expect(await store2.list(runId)).toHaveLength(2); // both steps are durably recorded
  }, 180_000);
});
