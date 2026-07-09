// SPDX-License-Identifier: MIT
/**
 * Real-world proof on a REAL Postgres (Testcontainers): the conformance contract, a large marketplace
 * stress scenario, cross-tenant security, and a real-LLM flagship where a model writes per-industry
 * prompt customizations that are then resolved per tenant with provenance + drift.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createSqlRealmStore, type SqlClient } from './realm-store-sql.js';
import { createRealmResolver } from './realm-store.js';
import { runRealmContract } from './realm-contract.js';
import type { RealmContext } from './context.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();
function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../../.env', '../../../.env', '../../.env']) {
    try {
      const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m);
      if (m) return m[1]!.trim().replace(/^["']|["']$/g, '');
    } catch { /* keep looking */ }
  }
  return undefined;
}
const OPENAI_KEY = loadKey();

/** Root context helper: a flat tenant (root) with the given id. */
const rootCtx = (id: string): RealmContext => ({ tenantId: id, depth: 0, lineage: [{ tenantId: id, depth: 0 }] });

describe.skipIf(!HAS_DOCKER)('Realm on REAL Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 16 });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
  }, 120_000);
  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });
  let seq = 0;
  const freshTable = (): string => `realm_${Date.now()}_${seq++}`;
  const client = (): SqlClient => pool;

  it('passes the FULL conformance contract on real Postgres (parity with SQLite)', async () => {
    const made: string[] = [];
    const results = await runRealmContract({
      makeStore: () => {
        const table = freshTable();
        made.push(table);
        return createSqlRealmStore({ client: client(), dialect: 'postgres', table });
      },
    });
    const failed = results.filter((r) => !r.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.error}`).join('\n')).toHaveLength(0);
    for (const t of made) await pool.query(`DROP TABLE IF EXISTS ${t}`);
  }, 120_000);

  it('STRESS: 1 global default + 2,000 tenants each customizing — every tenant resolves ITS own', async () => {
    const table = freshTable();
    const store = createSqlRealmStore<{ template: string }>({ client: client(), dialect: 'postgres', table });
    const resolver = createRealmResolver({ store });

    await store.publishGlobal('assistant.general', { template: 'GLOBAL BASELINE' });
    const N = 2000;
    for (let i = 0; i < N; i++) {
      await store.customize('assistant.general', rootCtx(`t${i}`), { template: `Tenant ${i} custom prompt` });
    }
    expect(await store.count()).toBe(N + 1); // global + N overrides

    // A tenant that DID customize gets its own; an unseen tenant gets the global; each is isolated.
    const t7 = await resolver.resolve('assistant.general', rootCtx('t7'));
    expect(t7?.template).toBe('Tenant 7 custom prompt');
    expect(t7?.realmProvenance.kind).toBe('own_override');
    const t1999 = await resolver.resolve('assistant.general', rootCtx('t1999'));
    expect(t1999?.template).toBe('Tenant 1999 custom prompt');
    const noCustom = await resolver.resolve('assistant.general', rootCtx('t9999'));
    expect([noCustom?.template, noCustom?.realmProvenance.kind]).toEqual(['GLOBAL BASELINE', 'global']);

    // Resolution for one tenant is a single visibility query, fast even with 2k copies present.
    const t0 = Date.now();
    for (let i = 0; i < 50; i++) await resolver.resolve('assistant.general', rootCtx(`t${i * 37 % N}`));
    expect(Date.now() - t0).toBeLessThan(5000);

    // Update the global → customizers keep their own copy (never clobbered). t7 both edited its
    // content AND the source moved on, so its drift is 'diverged' (a real merge candidate).
    await store.publishGlobal('assistant.general', { template: 'GLOBAL v2' });
    const stillOwn = await resolver.resolve('assistant.general', rootCtx('t7'));
    expect(stillOwn?.template).toBe('Tenant 7 custom prompt'); // resolution unaffected
    expect((stillOwn?.realmProvenance as { drift: string }).drift).toBe('diverged');
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
  }, 180_000);

  it('SECURITY: adversarial logical keys / payloads + strict cross-tenant isolation at scale', async () => {
    const table = freshTable();
    const store = createSqlRealmStore({ client: client(), dialect: 'postgres', table });
    const resolver = createRealmResolver({ store });

    // Hostile logical keys and payloads stored as pure data (parameterised) — no injection.
    const evilKey = "k'; DROP TABLE " + table + '; --';
    await store.publishGlobal(evilKey, { note: "value with ' quote and % and _" });
    await store.putNative('secret', 'acme', { note: 'ACME SECRET' });
    await store.putNative('secret', 'globex', { note: 'GLOBEX SECRET' });
    expect(await store.count()).toBe(3); // table survived the injection attempt
    expect((await resolver.resolve(evilKey, rootCtx('acme')))?.['note']).toBe("value with ' quote and % and _");

    // acme and globex are separate roots — neither can see the other's native record.
    expect((await resolver.resolve('secret', rootCtx('acme')))?.['note']).toBe('ACME SECRET');
    expect((await resolver.resolve('secret', rootCtx('globex')))?.['note']).toBe('GLOBEX SECRET');
    const acmeVisible = await store.listVisible(rootCtx('acme'), ['secret']);
    expect(acmeVisible.some((r) => (r as { note?: string })['note'] === 'GLOBEX SECRET')).toBe(false);
    await pool.query(`DROP TABLE IF EXISTS ${table}`);
  }, 120_000);

  it.skipIf(!OPENAI_KEY)(
    'FLAGSHIP (real LLM): a model writes per-industry prompt customizations; each tenant resolves ITS own; a global update surfaces as drift',
    async () => {
      const table = freshTable();
      const store = createSqlRealmStore<{ template: string }>({ client: client(), dialect: 'postgres', table });
      const resolver = createRealmResolver({ store });

      // A global baseline assistant prompt.
      await store.publishGlobal('assistant.general', { template: 'You are a helpful assistant. Be concise and accurate.' });

      // Ask a real model to tailor that prompt for three regulated industries.
      const industries = ['a hospital / clinical setting', 'a corporate law firm', 'a retail bank'];
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: `Rewrite this base assistant system prompt, tailored for each setting. Base: "You are a helpful assistant. Be concise and accurate."\nSettings: ${industries.map((s, i) => `${i}=${s}`).join(', ')}.\nReturn ONLY JSON: {"prompts": ["<for 0>", "<for 1>", "<for 2>"]} — each a complete tailored system prompt (2-4 sentences) reflecting that setting's tone, caveats and compliance needs.`,
          }],
        }),
      });
      expect(res.ok, `OpenAI HTTP ${res.status}`).toBe(true);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      const parsed = JSON.parse(body.choices[0]!.message.content) as { prompts: string[] };
      const prompts = parsed.prompts;
      expect(prompts.length).toBe(3);

      const tenants = ['mercy-health', 'lex-partners', 'first-bank'];
      for (let i = 0; i < 3; i++) {
        await store.customize('assistant.general', rootCtx(tenants[i]!), { template: prompts[i]! });
      }
      // Each tenant resolves ITS OWN tailored prompt, stamped as an own_override; provenance is per-tenant.
      for (let i = 0; i < 3; i++) {
        const eff = await resolver.resolve('assistant.general', rootCtx(tenants[i]!));
        expect(eff?.template).toBe(prompts[i]);
        expect(eff?.realmProvenance.kind).toBe('own_override');
        console.log(`  [real-LLM] ${tenants[i]} → own prompt (${eff?.template?.slice(0, 60)}…)`);
      }
      // A tenant that never customized still gets the global baseline.
      const plain = await resolver.resolve('assistant.general', rootCtx('acme-generic'));
      expect(plain?.realmProvenance.kind).toBe('global');

      // Product ships a new global baseline → the customizers are now 'diverged'/'customized', not clobbered.
      await store.publishGlobal('assistant.general', { template: 'You are a helpful, safe assistant. Cite sources when asked.' });
      const hospital = await resolver.resolve('assistant.general', rootCtx('mercy-health'));
      expect(hospital?.template).toBe(prompts[0]); // still the tenant's own — never silently overwritten
      const drift = (hospital?.realmProvenance as { drift: string }).drift;
      expect(['customized', 'diverged']).toContain(drift);
      console.log(`  [real-LLM] after a global update, mercy-health keeps its prompt; drift = ${drift}`);
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    },
    180_000,
  );
});
