// SPDX-License-Identifier: MIT
/**
 * Phase 2 on a REAL Postgres (Testcontainers): the version log + reconcile engine at scale, adversarial
 * inputs, and a real-LLM flagship where a model ships v1 defaults, an operator edits some, the model
 * ships a v2 "release", and reconcile classifies drift and adopts only the safe changes — never
 * clobbering the operator.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createSqlRealmStore, type SqlClient } from './realm-store-sql.js';
import { createSqlVersionLog } from './realm-version-sql.js';
import { reconcile, resyncToDesired, type DesiredDefault } from './reconcile.js';

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

type P = { template: string };
const FAMILY = 'prompts';
const def = (logicalKey: string, template: string): DesiredDefault<P> => ({ logicalKey, payload: { template } });

describe.skipIf(!HAS_DOCKER)('Realm Phase 2 on REAL Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 16 });
    pool.on('error', () => {});
  }, 120_000);
  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });
  let seq = 0;
  const fresh = (): { store: ReturnType<typeof createSqlRealmStore<P>>; log: ReturnType<typeof createSqlVersionLog<P>> } => {
    const table = `p2_${Date.now()}_${seq++}`;
    const client: SqlClient = pool;
    return {
      store: createSqlRealmStore<P>({ client, dialect: 'postgres', table }),
      log: createSqlVersionLog<P>({ client, dialect: 'postgres', table: `${table}_versions` }),
    };
  };

  it('STRESS: seed 1,000 defaults, operator edits ~500, release changes ~333 → correct drift + safe adopt', async () => {
    const { store, log } = fresh();
    const N = 1000;
    const v1: DesiredDefault<P>[] = Array.from({ length: N }, (_, i) => def(`k${i}`, `default ${i} v1`));

    // Release 1 — everything published.
    const r1 = await reconcile(store, log, FAMILY, v1, { at: '2026-01-01T00:00:00Z', publishedBy: 'pkg@1.0.0' });
    expect(r1.applied).toHaveLength(N);
    expect(await store.count()).toBe(N);

    // Operator edits every EVEN default in place (~500) — no version recorded.
    const opEdited = (i: number) => i % 2 === 0;
    for (let i = 0; i < N; i++) if (opEdited(i)) await store.publishGlobal(`k${i}`, { template: `default ${i} OPERATOR EDIT` });

    // Release 2 — the package rewrites every 3rd default (~333) and adds 50 new ones.
    const pkgChanged = (i: number) => i % 3 === 0;
    const v2: DesiredDefault<P>[] = v1.map((d, i) => (pkgChanged(i) ? def(d.logicalKey, `default ${i} v2`) : d));
    for (let i = N; i < N + 50; i++) v2.push(def(`k${i}`, `added ${i}`));

    const t0 = Date.now();
    const r2 = await reconcile(store, log, FAMILY, v2, { at: '2026-02-01T00:00:00Z', publishedBy: 'pkg@2.0.0' });
    expect(Date.now() - t0).toBeLessThan(30_000);

    // both edited & changed → diverged; edited-only → customized; changed-only → stale(adopted); new → published.
    const s = r2.report.summary;
    expect(s.new).toBe(50);
    expect(s.diverged).toBeGreaterThan(0);   // i%6==0
    expect(s.customized).toBeGreaterThan(0); // even & not %3
    expect(s.stale).toBeGreaterThan(0);      // %3 & odd
    expect(s.in_sync).toBeGreaterThan(0);    // odd & not %3
    // k6: even (edited) AND %3 (changed) → diverged → operator edit preserved.
    expect(((await store.listAll(['k6'])).find((r) => r.realm === 'global') as unknown as P).template).toContain('OPERATOR EDIT');
    // k3: odd, %3 → package-only → stale → adopted.
    expect(((await store.listAll(['k3'])).find((r) => r.realm === 'global') as unknown as P).template).toBe('default 3 v2');
    // k2: even (edited), not %3 → customized → operator edit preserved.
    expect(((await store.listAll(['k2'])).find((r) => r.realm === 'global') as unknown as P).template).toContain('OPERATOR EDIT');
  }, 180_000);

  it('SECURITY: hostile logical keys / payloads are pure data; drift + reconcile never inject', async () => {
    const { store, log } = fresh();
    const evil = "k'; DROP TABLE realm_versions; --";
    const v1: DesiredDefault<P>[] = [def(evil, "value with ' quote and % and _"), def('safe', 'ok')];
    await reconcile(store, log, FAMILY, v1, { at: '2026-01-01T00:00:00Z' });
    expect(await store.count()).toBe(2); // tables survived
    // Re-running with the same content is a clean no-op (content-addressed).
    const again = await reconcile(store, log, FAMILY, v1, { at: '2026-01-02T00:00:00Z' });
    expect(again.applied).toHaveLength(0);
    // The hostile key round-trips as data and versions correctly.
    expect((await log.latest(FAMILY, evil))?.version).toBe(1);
  }, 120_000);

  it.skipIf(!OPENAI_KEY)(
    'FLAGSHIP (real LLM): model ships v1 defaults → operator edits some → model ships v2 → reconcile keeps edits, adopts safe changes',
    async () => {
      const { store, log } = fresh();
      const industries = ['hospital', 'law firm', 'retail bank', 'airline', 'university'];

      // Model authors v1 default assistant prompts, one per industry.
      const gen = async (instruction: string): Promise<string[]> => {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o-mini', temperature: 0.3, response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: `${instruction}\nSettings: ${industries.map((s, i) => `${i}=${s}`).join(', ')}.\nReturn ONLY JSON {"prompts":["<0>","<1>","<2>","<3>","<4>"]}, each a 1-2 sentence system prompt.` }],
          }),
        });
        expect(res.ok, `OpenAI ${res.status}`).toBe(true);
        const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
        const parsed = JSON.parse(body.choices[0]!.message.content) as { prompts: string[] };
        expect(parsed.prompts).toHaveLength(5);
        return parsed.prompts;
      };

      const v1Texts = await gen('Write a concise base assistant system prompt tailored to each setting.');
      const v1: DesiredDefault<P>[] = v1Texts.map((t, i) => def(`assistant.p${i}`, t));
      await reconcile(store, log, FAMILY, v1, { at: '2026-01-01T00:00:00Z', publishedBy: 'pkg@1.0.0' });

      // Operator edits p1 and p3 in place (adds a house rule) — no version recorded.
      await store.publishGlobal('assistant.p1', { template: `${v1Texts[1]} Always greet the customer by name.` });
      await store.publishGlobal('assistant.p3', { template: `${v1Texts[3]} Never quote a fare without taxes.` });

      // Model ships a v2 "release": it rewrites p2, p3, p4 (more compliance-aware); p0, p1 unchanged.
      const v2Texts = await gen('Rewrite each base assistant system prompt to be more explicit about compliance and citing sources.');
      const v2: DesiredDefault<P>[] = [
        def('assistant.p0', v1Texts[0]!),   // unchanged in release
        def('assistant.p1', v1Texts[1]!),   // unchanged in release
        def('assistant.p2', v2Texts[2]!),   // changed
        def('assistant.p3', v2Texts[3]!),   // changed
        def('assistant.p4', v2Texts[4]!),   // changed
      ];

      const r2 = await reconcile(store, log, FAMILY, v2, { at: '2026-02-01T00:00:00Z', publishedBy: 'pkg@2.0.0' });
      const state = Object.fromEntries(r2.report.entries.map((e) => [e.logicalKey, e.state]));
      expect(state['assistant.p0']).toBe('in_sync');    // nobody touched
      expect(state['assistant.p1']).toBe('customized');  // operator edited, release didn't change it
      expect(state['assistant.p2']).toBe('stale');       // release changed, operator didn't → adopt
      expect(state['assistant.p3']).toBe('diverged');    // both changed → review
      expect(state['assistant.p4']).toBe('stale');       // release changed, operator didn't → adopt

      // Operator edits preserved; safe upgrades adopted.
      expect(((await store.listAll(['assistant.p1'])).find((r) => r.realm === 'global') as unknown as P).template).toContain('greet the customer by name');
      expect(((await store.listAll(['assistant.p3'])).find((r) => r.realm === 'global') as unknown as P).template).toContain('Never quote a fare');
      expect(((await store.listAll(['assistant.p2'])).find((r) => r.realm === 'global') as unknown as P).template).toBe(v2Texts[2]);
      console.log(`  [real-LLM] release v2 → p0=in_sync p1=customized(kept) p2=stale(adopted) p3=diverged(review) p4=stale(adopted)`);

      // Operator resolves the diverged p3 by taking the shipped version → in_sync.
      await resyncToDesired(store, log, FAMILY, 'assistant.p3', { template: v2Texts[3]! }, { at: '2026-02-02T00:00:00Z' });
      const r3 = await reconcile(store, log, FAMILY, v2, { at: '2026-02-03T00:00:00Z' });
      expect(Object.fromEntries(r3.report.entries.map((e) => [e.logicalKey, e.state]))['assistant.p3']).toBe('in_sync');
    },
    180_000,
  );
});
