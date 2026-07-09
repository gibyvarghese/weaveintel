// SPDX-License-Identifier: MIT
/**
 * Phase 3 on a REAL Postgres (Testcontainers): the state overlay at scale, adversarial inputs, and a
 * real-LLM flagship where a model sets a per-industry enable/priority policy over shared built-in skills
 * — no forking — and each tenant resolves its own disposition (with a parent-org policy inherited down).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createSqlStateStore } from './realm-state-sql.js';
import { resolveStateFor } from './realm-state.js';
import type { SqlClient } from './realm-store-sql.js';
import type { RealmContext } from './context.js';

function hasDocker(): boolean { try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; } }
const HAS_DOCKER = hasDocker();
function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../../.env', '../../../.env', '../../.env']) {
    try { const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m); if (m) return m[1]!.trim().replace(/^["']|["']$/g, ''); } catch { /* keep looking */ }
  }
  return undefined;
}
const OPENAI_KEY = loadKey();

const rootCtx = (id: string): RealmContext => ({ tenantId: id, depth: 0, lineage: [{ tenantId: id, depth: 0 }] });
const chainCtx = (chain: string[]): RealmContext => ({ tenantId: chain[chain.length - 1]!, depth: chain.length - 1, lineage: chain.map((tenantId, i) => ({ tenantId, depth: i })) });
const FAMILY = 'skills';

describe.skipIf(!HAS_DOCKER)('Realm Phase 3 state overlay on REAL Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 16 });
    pool.on('error', () => {});
  }, 120_000);
  afterAll(async () => { await pool?.end().catch(() => {}); await container?.stop().catch(() => {}); });
  let seq = 0;
  const fresh = () => createSqlStateStore({ client: pool as SqlClient, dialect: 'postgres', table: `state_${Date.now()}_${seq++}` });

  it('STRESS: 2,000 tenants each toggling a shared skill — every tenant resolves its own disposition', async () => {
    const store = fresh();
    const KEY = 'skill.web-search';
    const N = 2000;
    for (let i = 0; i < N; i++) {
      // even tenants disable it, odd tenants pin a version and bump priority.
      if (i % 2 === 0) await store.setState(FAMILY, KEY, `t${i}`, { enabled: false });
      else await store.setState(FAMILY, KEY, `t${i}`, { priority: i % 10, pinnedVersion: (i % 3) + 1 });
    }
    expect((await resolveStateFor(store, FAMILY, KEY, rootCtx('t0'))).active).toBe(false);
    expect((await resolveStateFor(store, FAMILY, KEY, rootCtx('t1'))).active).toBe(true);
    expect((await resolveStateFor(store, FAMILY, KEY, rootCtx('t1'))).pinnedVersion).toBe(2);
    const unseen = await resolveStateFor(store, FAMILY, KEY, rootCtx('t999999'));
    expect([unseen.active, unseen.enabled]).toEqual([true, null]); // no overlay → default active

    const t0 = Date.now();
    for (let i = 0; i < 50; i++) await resolveStateFor(store, FAMILY, KEY, rootCtx(`t${(i * 37) % N}`));
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 180_000);

  it('HIERARCHY: a parent org disables a skill for its subtree; a child re-enables just for itself', async () => {
    const store = fresh();
    const KEY = 'skill.code-exec';
    // Org tree: bank (root) → retail → branch-42.
    await store.setState(FAMILY, KEY, 'bank', { enabled: false });          // whole bank subtree off
    await store.setState(FAMILY, KEY, 'branch-42', { enabled: true });      // one branch re-enables
    expect((await resolveStateFor(store, FAMILY, KEY, chainCtx(['bank']))).active).toBe(false);
    expect((await resolveStateFor(store, FAMILY, KEY, chainCtx(['bank', 'retail']))).active).toBe(false); // inherits
    expect((await resolveStateFor(store, FAMILY, KEY, chainCtx(['bank', 'retail', 'branch-42']))).active).toBe(true); // override
  }, 120_000);

  it('SECURITY: hostile keys / tenant ids are pure data; overlays never leak across tenants or inject', async () => {
    const store = fresh();
    const evilKey = "k'; DROP TABLE realm_tenant_state; --";
    await store.setState(FAMILY, evilKey, "acme'; DROP TABLE x; --", { enabled: false });
    await store.setState(FAMILY, 'skill.secret', 'acme', { enabled: false });
    await store.setState(FAMILY, 'skill.secret', 'globex', { priority: 9 });
    // Tables survived; the hostile key round-trips as data.
    expect((await store.getOwn(FAMILY, evilKey, "acme'; DROP TABLE x; --"))?.enabled).toBe(false);
    // acme and globex are separate roots — neither sees the other's overlay.
    expect((await resolveStateFor(store, FAMILY, 'skill.secret', rootCtx('acme'))).active).toBe(false);
    expect((await resolveStateFor(store, FAMILY, 'skill.secret', rootCtx('globex'))).active).toBe(true);
    expect((await resolveStateFor(store, FAMILY, 'skill.secret', rootCtx('globex'))).priority).toBe(9);
  }, 120_000);

  it.skipIf(!OPENAI_KEY)(
    'FLAGSHIP (real LLM): a model sets a per-industry enable/priority policy over shared skills; each tenant resolves its own',
    async () => {
      const store = fresh();
      const skills = ['skill.web-search', 'skill.code-exec', 'skill.file-upload', 'skill.email-send'];
      const tenants = ['mercy-hospital', 'first-bank', 'acme-retail'];

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini', temperature: 0.2, response_format: { type: 'json_object' },
          messages: [{ role: 'user', content:
            `For each organisation, decide which of these shared built-in skills should be ENABLED (true/false) given its compliance posture. Skills: ${skills.join(', ')}. Organisations: ${tenants.join(', ')}.\n` +
            `Return ONLY JSON: {"policy": {"<org>": {"<skill>": <true|false>}}} covering every org and skill.` }],
        }),
      });
      expect(res.ok, `OpenAI ${res.status}`).toBe(true);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      const policy = (JSON.parse(body.choices[0]!.message.content) as { policy: Record<string, Record<string, boolean>> }).policy;

      // Apply the model's policy as sparse overlays — no skill is forked or duplicated.
      for (const org of tenants) for (const sk of skills) {
        const on = policy[org]?.[sk];
        if (on === false) await store.setState(FAMILY, sk, org, { enabled: false });
      }

      // Each tenant resolves ITS OWN disposition; a skill the model left alone stays active.
      for (const org of tenants) {
        for (const sk of skills) {
          const resolved = await resolveStateFor(store, FAMILY, sk, rootCtx(org));
          const expected = policy[org]?.[sk] === false ? false : true;
          expect(resolved.active, `${org}/${sk}`).toBe(expected);
        }
        const offCount = skills.filter((sk) => policy[org]?.[sk] === false).length;
        console.log(`  [real-LLM] ${org}: ${offCount}/${skills.length} shared skills disabled by policy (no forks)`);
      }
      // A tenant with no policy at all sees every skill active (shared defaults untouched).
      for (const sk of skills) expect((await resolveStateFor(store, FAMILY, sk, rootCtx('unseen-tenant'))).active).toBe(true);
    },
    180_000,
  );
});
