// SPDX-License-Identifier: MIT
/**
 * Real-world proof for the tenant hierarchy on a REAL Postgres (Testcontainers), plus a real-LLM
 * flagship that builds a live org chart from a natural-language description. Skips automatically when
 * Docker isn't available; the LLM leg skips without an OpenAI key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { createSqlTenantHierarchy, type SqlClient } from './tenant-hierarchy-sql.js';
import { runTenantHierarchyContract } from './tenant-hierarchy-contract.js';
import { ancestorIds, depthOf } from './hierarchy-path.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

function loadOpenAIKey(): string | undefined {
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
const OPENAI_KEY = loadOpenAIKey();

describe.skipIf(!HAS_DOCKER)('Tenant hierarchy on REAL Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  const client = (): SqlClient => pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 16 });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
  }, 120_000);
  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  let tableSeq = 0;
  const freshTable = (): string => `tenants_t${Date.now()}_${tableSeq++}`;

  it('passes the FULL conformance contract on real Postgres (drop-in parity with SQLite)', async () => {
    const made: string[] = [];
    const results = await runTenantHierarchyContract({
      makeStore: () => {
        const table = freshTable();
        made.push(table);
        return createSqlTenantHierarchy({ client: client(), dialect: 'postgres', table });
      },
    });
    const failed = results.filter((r) => !r.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.error}`).join('\n')).toHaveLength(0);
    for (const t of made) await pool.query(`DROP TABLE IF EXISTS ${t}`);
  }, 120_000);

  it('STRESS: a 3,000-node multinational — subtree/ancestor reads + a whole-region reparent', async () => {
    const table = freshTable();
    const org = createSqlTenantHierarchy({ client: client(), dialect: 'postgres', table });

    // A realistic shape: 1 holding company → 6 regions → 20 countries each → 25 offices each = 3,127.
    const COUNTRIES = 20;
    const OFFICES = 25;
    await org.create({ id: 'acme', name: 'Acme Holdings' });
    const regions = ['namer', 'emea', 'apac', 'latam', 'mea', 'anz'];
    let created = 1;
    const officeIds: string[] = [];
    for (const r of regions) {
      await org.create({ id: r, name: r.toUpperCase(), parentTenantId: 'acme' });
      created++;
      for (let c = 0; c < COUNTRIES; c++) {
        const country = `${r}-c${c}`;
        await org.create({ id: country, name: `${r} country ${c}`, parentTenantId: r });
        created++;
        for (let o = 0; o < OFFICES; o++) {
          const office = `${country}-o${o}`;
          await org.create({ id: office, name: `office ${o}`, parentTenantId: country });
          officeIds.push(office);
          created++;
        }
      }
    }
    expect(created).toBeGreaterThanOrEqual(3000);
    expect(await org.count()).toBe(created);

    // Read invariants at scale.
    const all = await org.descendants('acme');
    expect(all).toHaveLength(created - 1); // everything except the root itself
    expect((await org.subtree('emea')).length).toBe(1 + COUNTRIES + COUNTRIES * OFFICES); // region + countries + offices
    expect((await org.descendants('acme', { maxDepth: 1 })).map((t) => t.id).sort()).toEqual([...regions].sort());

    // Ancestor chain for a deep office (billing rollup): office → country → region → holding.
    const office = officeIds[officeIds.length - 1]!;
    const anc = await org.ancestors(office);
    expect(anc.map((t) => t.id)).toEqual(ancestorIds((await org.get(office))!.path));
    expect(anc[0]!.id).toBe('acme'); // root first
    expect(anc).toHaveLength(3);

    // Acquisition: move the whole EMEA region (1 + 14 + 70 = 85 nodes) under LATAM — one UPDATE.
    const emeaSubtreeBefore = (await org.subtree('emea')).length;
    const t0 = Date.now();
    await org.reparent('emea', 'latam');
    const moveMs = Date.now() - t0;
    expect(moveMs).toBeLessThan(5000); // a single prefix-rewrite UPDATE, even for 85 rows
    const emea = await org.get('emea');
    expect(emea!.path).toBe('/acme/latam/emea/');
    expect(emea!.depth).toBe(2);
    // Every descendant rebased + re-depthed correctly.
    const movedSubtree = await org.subtree('emea');
    expect(movedSubtree.length).toBe(emeaSubtreeBefore);
    for (const node of movedSubtree) {
      expect(node.path.startsWith('/acme/latam/emea/')).toBe(true);
      expect(node.depth).toBe(depthOf(node.path));
    }
    // The old grandparent no longer sees EMEA; namer is untouched.
    expect((await org.children('acme')).map((t) => t.id).sort()).toEqual([...regions].filter((r) => r !== 'emea').sort());

    await pool.query(`DROP TABLE IF EXISTS ${table}`);
  }, 180_000);

  it('SECURITY: adversarial ids (LIKE wildcards, quotes, SQL) cannot leak across subtrees or inject', async () => {
    const table = freshTable();
    const org = createSqlTenantHierarchy({ client: client(), dialect: 'postgres', table });

    // Two separate roots whose ids are hostile: a LIKE wildcard, a quote, a comment sequence.
    await org.create({ id: 'a', name: 'Victim root' });
    await org.create({ id: 'kid', name: 'Victim child', parentTenantId: 'a' });
    await org.create({ id: 'a_evil', name: 'Underscore sibling (own root)' }); // '_' = LIKE any-char
    await org.create({ id: 'a%evil', name: 'Percent sibling (own root)' });     // '%' = LIKE any-run
    await org.create({ id: "rob'; DROP TABLE " + table + '; --', name: 'SQL-injection id' });
    await org.create({ id: 'child-of-evil', name: 'hidden', parentTenantId: 'a%evil' });

    // The wildcard/percent siblings must NOT show up as descendants of 'a'.
    const desc = (await org.descendants('a')).map((t) => t.id);
    expect(desc).toEqual(['kid']);

    // The injection id round-trips as pure data; the table still exists and the row is retrievable.
    const injected = await org.get("rob'; DROP TABLE " + table + '; --');
    expect(injected?.name).toBe('SQL-injection id');
    expect(await org.count()).toBe(6);

    // Cross-subtree isolation: 'a%evil' keeps its own child, invisible to 'a'.
    expect((await org.descendants('a%evil')).map((t) => t.id)).toEqual(['child-of-evil']);

    await pool.query(`DROP TABLE IF EXISTS ${table}`);
  }, 120_000);

  it.skipIf(!OPENAI_KEY)(
    'FLAGSHIP (real LLM): build a live org chart from a plain-English brief, then answer hierarchy questions',
    async () => {
      const table = freshTable();
      const org = createSqlTenantHierarchy({ client: client(), dialect: 'postgres', table });

      // Ask a real model to design a realistic enterprise org as a flat parent/child list.
      const prompt = `You are designing the tenant hierarchy for a large multinational called "Globex Corporation".
Return ONLY a JSON array of nodes, each: {"id": "<kebab-slug, no slashes>", "name": "<display name>", "parentId": "<id or null>"}.
Exactly one node has parentId null (the company root, id "globex"). Include 4-6 regional subsidiaries under the root,
and 2-4 country/business-unit tenants under each region. 20-40 nodes total. Use realistic names. JSON only, no prose.`;
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
      });
      expect(res.ok, `OpenAI HTTP ${res.status}`).toBe(true);
      const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      const raw = json.choices[0]!.message.content;
      // The model may wrap the array in an object; extract the array either way.
      const parsed = JSON.parse(raw) as unknown;
      const nodes = (Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>).find(Array.isArray)) as Array<{
        id: string;
        name: string;
        parentId: string | null;
      }>;
      expect(Array.isArray(nodes) && nodes.length >= 10).toBe(true);

      // Insert parents before children (topological-ish): repeatedly place any node whose parent is present.
      const wanted = new Map(nodes.map((n) => [n.id, n]));
      const placed = new Set<string>();
      let progress = true;
      while (placed.size < wanted.size && progress) {
        progress = false;
        for (const n of wanted.values()) {
          if (placed.has(n.id)) continue;
          const parentId = n.parentId && wanted.has(n.parentId) ? n.parentId : null;
          if (parentId && !placed.has(parentId)) continue; // wait for parent
          try {
            await org.create({ id: n.id, name: String(n.name).slice(0, 200), parentTenantId: parentId });
            placed.add(n.id);
            progress = true;
          } catch { placed.add(n.id); } // skip dup/invalid ids the model may have produced
        }
      }
      const total = await org.count();
      expect(total).toBeGreaterThanOrEqual(10);
      console.log(`  [real-LLM] built a ${total}-tenant org for "Globex Corporation" and persisted it to Postgres`);

      // Tree invariants hold on real, messy, model-generated data.
      const roots = await org.roots();
      expect(roots.length).toBeGreaterThanOrEqual(1);
      const root = roots.find((r) => r.id === 'globex') ?? roots[0]!;
      const everyone = await org.subtree(root.id);
      for (const t of everyone) {
        expect(t.depth).toBe(depthOf(t.path)); // path and depth agree
        if (t.parentTenantId) {
          const parent = await org.get(t.parentTenantId);
          expect(t.path.startsWith(parent!.path)).toBe(true); // child path extends parent path
        }
      }

      // Answer a real hierarchy question: pick a leaf and roll billing up its ancestor chain.
      const leaf = everyone.reduce((a, b) => (b.depth > a.depth ? b : a));
      const chain = await org.ancestors(leaf.id);
      console.log(`  [real-LLM] deepest tenant "${leaf.name}" rolls up through: ${chain.map((c) => c.name).join(' → ')}`);
      expect(chain[0]!.id).toBe(root.id); // rollup reaches the company root

      // A real reorg: move the deepest leaf's region to report directly to the root, verify rebasing.
      const region = chain.length >= 2 ? chain[1]! : leaf;
      const before = (await org.subtree(region.id)).length;
      await org.reparent(region.id, root.id);
      const after = await org.subtree(region.id);
      expect(after.length).toBe(before);
      for (const t of after) expect(t.path.startsWith(`${root.path}${region.id}/`) || t.id === region.id).toBe(true);

      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    },
    180_000,
  );
});
