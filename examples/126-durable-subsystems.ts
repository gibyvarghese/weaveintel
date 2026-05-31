/**
 * Example 126 — Phase 4.x: Durable subsystems share one runtime.
 *
 * Shows that legal hold, OAuth flow state, tenant budget, and a browser
 * pending-handoff all consume the SAME `runtime.persistence` slot. One
 * SQLite file = restart-safe for every cross-cutting subsystem at once.
 *
 * No LLM. No external service. Sub-100 lines.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

import { weaveRuntime } from '@weaveintel/core';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { createDurableLegalHoldManager } from '@weaveintel/compliance';
import { createDurableOAuthStateStore } from '@weaveintel/oauth';
import { createDurableBudgetEnforcer } from '@weaveintel/tenancy';
import { createDurableBrowserHandoffStore } from '@weaveintel/tools-browser';

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'wv-ex126-'));
  const path = join(dir, 'wv.db');
  console.log(`[ex126] sqlite at ${path}`);

  // --- process A: write across four subsystems, one runtime, one slot ---
  const rtA = weaveRuntime({
    installDefaultTracer: false,
    persistence: weaveSqlitePersistence({ path }),
  });

  const holdsA = createDurableLegalHoldManager({ runtime: rtA });
  const oauthA = createDurableOAuthStateStore({ runtime: rtA });
  const budgetA = createDurableBudgetEnforcer({ runtime: rtA });
  const handoffA = createDurableBrowserHandoffStore({ runtime: rtA });

  await holdsA.create({
    id: 'lh-7',
    name: 'Doe v Acme',
    description: 'Pending litigation',
    subjectIds: ['user-9'],
    dataCategories: ['*'],
    issuedBy: 'legal@acme',
    expiresAt: null,
  });

  await oauthA.set('csrf-state-1', {
    codeVerifier: 'pkce-verifier-abc',
    expiresAt: Date.now() + 5 * 60_000,
    provider: 'github',
    redirectUri: 'https://app.example/callback',
  });

  await budgetA.setBudget({
    tenantId: 'acme',
    daily: { tokens: 1_000_000, costUsd: 25, steps: 5_000, runs: 500 },
    monthly: { tokens: 30_000_000, costUsd: 500, steps: 100_000, runs: 10_000 },
  });
  await budgetA.recordUsage('acme', 50_000, 12.34, 3);

  await handoffA.set('task-1', {
    taskId: 'task-1',
    sessionId: 'browser-session-42',
    reason: 'login required',
    pageUrl: 'https://provider.example/login',
    createdAt: new Date().toISOString(),
  });

  console.log('[ex126] runtime A wrote: legal hold, oauth state, budget+usage, browser handoff');

  // --- process B: fresh runtime, same path, every subsystem reads back ---
  const rtB = weaveRuntime({
    installDefaultTracer: false,
    persistence: weaveSqlitePersistence({ path }),
  });

  const holdsB = createDurableLegalHoldManager({ runtime: rtB });
  const oauthB = createDurableOAuthStateStore({ runtime: rtB });
  const budgetB = createDurableBudgetEnforcer({ runtime: rtB });
  const handoffB = createDurableBrowserHandoffStore({ runtime: rtB });

  assert.equal((await holdsB.get('lh-7'))?.name, 'Doe v Acme');
  assert.equal(await holdsB.isHeld('user-9', 'profile'), true);

  const flow = await oauthB.get('csrf-state-1');
  assert.equal(flow?.codeVerifier, 'pkce-verifier-abc');

  const usage = await budgetB.getUsage('acme', 'monthly');
  assert.equal(Math.round((usage?.costUsd ?? 0) * 100), 1234);

  const handoff = await handoffB.get('task-1');
  assert.equal(handoff?.sessionId, 'browser-session-42');

  console.log('[ex126] runtime B confirmed: all four subsystems survived restart ✔');

  rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
