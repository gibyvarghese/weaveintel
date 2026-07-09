// SPDX-License-Identifier: MIT
/**
 * Phase 4 on a REAL Postgres (Testcontainers) with a REAL tenant tree: a parent org's shared
 * customization resolves for its subsidiaries at depth (subtree resolution), blast radius is computed
 * from the real hierarchy, private forks stay invisible to children, promotion lifts a fork to global,
 * and a real-LLM flagship shares a regional brand voice down a multinational org.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createSqlTenantHierarchy } from '@weaveintel/identity';
import {
  createSqlRealmStore, createRealmResolver, createSqlVersionLog, buildRealmContext, blastRadius, promoteFork,
  type SqlClient,
} from './index.js';

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
type P = { template: string };

describe.skipIf(!HAS_DOCKER)('Realm Phase 4 on REAL Postgres + real tenant tree', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 16 });
    pool.on('error', () => {});
  }, 120_000);
  afterAll(async () => { await pool?.end().catch(() => {}); await container?.stop().catch(() => {}); });
  let seq = 0;

  // Build a fresh tenant tree + realm store on their own tables for each test.
  const fresh = async () => {
    const s = seq++;
    const hierarchy = createSqlTenantHierarchy({ client: pool as unknown as SqlClient, dialect: 'postgres', table: `tenants_${s}` });
    const store = createSqlRealmStore<P>({ client: pool as SqlClient, dialect: 'postgres', table: `cfg_${s}` });
    const log = createSqlVersionLog<P>({ client: pool as SqlClient, dialect: 'postgres', table: `ver_${s}` });
    const resolver = createRealmResolver({ store });
    return { hierarchy, store, log, resolver };
  };

  it('SUBTREE RESOLUTION AT DEPTH: a parent org shares a fork; a grandchild inherits it; a sibling branch gets global', async () => {
    const { hierarchy, store, resolver } = await fresh();
    // acme (root) → emea → uk;  acme → apac (a sibling branch)
    await hierarchy.create({ id: 'acme', name: 'Acme' });
    await hierarchy.create({ id: 'emea', name: 'EMEA', parentTenantId: 'acme' });
    await hierarchy.create({ id: 'uk', name: 'UK', parentTenantId: 'emea' });
    await hierarchy.create({ id: 'apac', name: 'APAC', parentTenantId: 'acme' });

    await store.publishGlobal('assistant.general', { template: 'You are a helpful assistant.' });
    // EMEA customises and shares to its whole subtree.
    const emeaCtx = await buildRealmContext(hierarchy, 'emea');
    const fork = await store.customize('assistant.general', emeaCtx, { template: 'You are a GDPR-aware EMEA assistant.' });
    await store.setShareMode(fork.id, 'subtree');

    // UK (a grandchild of acme, child of emea) resolves EMEA's shared fork — not the global.
    const ukCtx = await buildRealmContext(hierarchy, 'uk');
    const uk = await resolver.resolve('assistant.general', ukCtx);
    expect(uk?.template).toBe('You are a GDPR-aware EMEA assistant.');
    expect(uk?.realmProvenance.kind).toBe('inherited');

    // APAC (a different branch) is untouched → global.
    const apac = await resolver.resolve('assistant.general', await buildRealmContext(hierarchy, 'apac'));
    expect(apac?.template).toBe('You are a helpful assistant.');
    expect(apac?.realmProvenance.kind).toBe('global');

    // Blast radius of EMEA's subtree share, computed from the REAL hierarchy.
    const descendants = (await hierarchy.descendants('emea')).map((t) => ({ tenantId: t.id, depth: t.depth }));
    const radius = blastRadius(1 /* emea depth */, descendants, 'subtree', new Set());
    expect(radius.inheriting).toContain('uk');
  }, 120_000);

  it('SECURITY: a parent’s PRIVATE fork stays invisible to its children (privacy hides the customization)', async () => {
    const { hierarchy, store, resolver } = await fresh();
    await hierarchy.create({ id: 'bank', name: 'Bank' });
    await hierarchy.create({ id: 'retail', name: 'Retail', parentTenantId: 'bank' });
    await store.publishGlobal('policy.tone', { template: 'GLOBAL' });
    const bankCtx = await buildRealmContext(hierarchy, 'bank');
    await store.customize('policy.tone', bankCtx, { template: 'BANK PRIVATE' }); // stays private (default)
    // The child resolves past the parent's private fork to the global.
    const retail = await resolver.resolve('policy.tone', await buildRealmContext(hierarchy, 'retail'));
    expect(retail?.template).toBe('GLOBAL');
    expect(retail?.realmProvenance.kind).toBe('global');
  }, 120_000);

  it('PROMOTE: a subsidiary’s fork is promoted to the shared global default; everyone gets it', async () => {
    const { hierarchy, store, log, resolver } = await fresh();
    await hierarchy.create({ id: 'acme', name: 'Acme' });
    await store.publishGlobal('brand.voice', { template: 'neutral' });
    const fork = await store.customize('brand.voice', await buildRealmContext(hierarchy, 'acme'), { template: 'warm, plain-spoken' });
    await promoteFork(store, log, 'brand.voice', fork as unknown as Record<string, unknown> & { logicalKey: string });
    // A brand-new, unrelated tenant now gets the promoted default.
    await hierarchy.create({ id: 'globex', name: 'Globex' });
    const globex = await resolver.resolve('brand.voice', await buildRealmContext(hierarchy, 'globex'));
    expect(globex?.template).toBe('warm, plain-spoken');
    expect(globex?.realmProvenance.kind).toBe('global');
  }, 120_000);

  it('STRESS: a holding company shares a policy to a 600-node subtree — blast radius is exact', async () => {
    const { hierarchy } = await fresh();
    await hierarchy.create({ id: 'holdco', name: 'HoldCo' });
    // 6 regions × 100 country offices = 600 descendants.
    for (let r = 0; r < 6; r++) {
      await hierarchy.create({ id: `region-${r}`, name: `R${r}`, parentTenantId: 'holdco' });
      for (let c = 0; c < 100; c++) await hierarchy.create({ id: `off-${r}-${c}`, name: `O${r}-${c}`, parentTenantId: `region-${r}` });
    }
    const descendants = (await hierarchy.descendants('holdco')).map((t) => ({ tenantId: t.id, depth: t.depth }));
    expect(descendants.length).toBe(606);
    // Share to direct children only → 6 regions inherit, 600 offices out of scope.
    const children = blastRadius(0, descendants, 'children', new Set());
    expect(children.inheriting).toHaveLength(6);
    expect(children.outOfScope).toBe(600);
    // Share to the whole subtree, with 3 offices already forked → they're shadowed.
    const subtree = blastRadius(0, descendants, 'subtree', new Set(['off-0-0', 'off-1-0', 'off-2-0']));
    expect(subtree.inheriting).toHaveLength(603);
    expect(subtree.shadowed).toHaveLength(3);
  }, 180_000);

  it.skipIf(!OPENAI_KEY)(
    'FLAGSHIP (real LLM): a regional HQ shares an AI-written brand voice down its subtree; every office inherits it',
    async () => {
      const { hierarchy, store, resolver } = await fresh();
      await hierarchy.create({ id: 'globalco', name: 'GlobalCo' });
      await hierarchy.create({ id: 'emea-hq', name: 'EMEA HQ', parentTenantId: 'globalco' });
      const offices = ['london', 'paris', 'berlin'];
      for (const o of offices) await hierarchy.create({ id: o, name: o, parentTenantId: 'emea-hq' });

      await store.publishGlobal('assistant.brand', { template: 'You are a helpful assistant.' });

      // A model writes EMEA HQ's brand voice; HQ shares it to its whole subtree.
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.4, messages: [{ role: 'user', content: 'Write a 1-2 sentence assistant system prompt for a European company that is warm, GDPR-aware, and multilingual. Output only the prompt.' }] }),
      });
      expect(res.ok, `OpenAI ${res.status}`).toBe(true);
      const voice = ((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content.trim();

      const hqCtx = await buildRealmContext(hierarchy, 'emea-hq');
      const fork = await store.customize('assistant.brand', hqCtx, { template: voice });
      await store.setShareMode(fork.id, 'subtree');

      // Every office inherits HQ's shared brand voice — no per-office copy.
      for (const o of offices) {
        const eff = await resolver.resolve('assistant.brand', await buildRealmContext(hierarchy, o));
        expect(eff?.template, o).toBe(voice);
        expect(eff?.realmProvenance.kind).toBe('inherited');
      }
      // A tenant outside EMEA HQ's branch still gets the global baseline.
      await hierarchy.create({ id: 'us-office', name: 'US', parentTenantId: 'globalco' });
      const us = await resolver.resolve('assistant.brand', await buildRealmContext(hierarchy, 'us-office'));
      expect(us?.realmProvenance.kind).toBe('global');
      const radius = blastRadius(1, (await hierarchy.descendants('emea-hq')).map((t) => ({ tenantId: t.id, depth: t.depth })), 'subtree', new Set());
      console.log(`  [real-LLM] EMEA HQ shared its brand voice to ${radius.inheriting.length} offices; US office kept the global baseline`);
    },
    180_000,
  );
});
