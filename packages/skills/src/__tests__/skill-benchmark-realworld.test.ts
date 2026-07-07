// SPDX-License-Identifier: MIT
/**
 * The EXTENDED, real-world benchmark: ~50 skills modelled on actual published Agent Skills, driven by
 * messy human messages. Retrieval is scored with REAL OpenAI embeddings (skipped without a key); the
 * embedder-independent guarantees (security, composition, mining, interop, scale) always run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSkillBenchmark } from '../skill-benchmark.js';
import { buildRealWorldCatalog, REAL_WORLD_QUERIES } from '../skill-benchmark-realworld.js';
import type { SkillEmbedFn } from '../retrieval.js';

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
const KEY = loadKey();
const realEmbed: SkillEmbedFn = async (texts) => {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map((d) => d.embedding);
};

describe('real-world skill benchmark', () => {
  it('the dataset is realistic in size and shape', () => {
    const catalog = buildRealWorldCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(45);          // ~50 real skills
    expect(REAL_WORLD_QUERIES.length).toBeGreaterThanOrEqual(30); // plenty of messy human messages
    // Every gold label points at a real skill in the catalog.
    const ids = new Set(catalog.map((s) => s.id));
    for (const q of REAL_WORLD_QUERIES) for (const g of q.gold) expect(ids.has(g), `${q.query} → ${g}`).toBe(true);
  });

  it.skipIf(!KEY)('meets public-benchmark targets on real skills + real human messages (real embeddings)', async () => {
    const result = await runSkillBenchmark({ catalog: buildRealWorldCatalog(), queries: REAL_WORLD_QUERIES, embed: realEmbed, stressCatalogSize: 500, log: (l) => console.log(l) });
    const misses = Object.entries(result.sections).flatMap(([section, rows]) => rows.filter((r) => !r.pass).map((r) => `${section} → ${r.name} = ${r.value.toFixed(3)}`));
    expect(misses, misses.join('\n')).toHaveLength(0);
    expect(result.passed).toBe(true);
  }, 120_000);

  it('the safety guarantees hold on the real-world catalog regardless of embedder', async () => {
    // No key → retrieval leans on keywords, but security/composition/mining/interop must still pass.
    const result = await runSkillBenchmark({ catalog: buildRealWorldCatalog(), queries: REAL_WORLD_QUERIES, embed: KEY ? realEmbed : undefined });
    // "MCP discovery accuracy" scores semantic retrieval quality, so it is inherently
    // embedder-dependent (keyword fallback ≈ 0.56 vs real embeddings ≈ 0.97). Only assert it when a
    // real embedder is in play; the other rows (e.g. Interop's SKILL.md round-trip fidelity) are
    // embedder-independent and must hold on any embedder.
    const embedderDependent = new Set(['MCP discovery accuracy']);
    for (const name of ['Security (block bad skills & attacks)', 'Composition (order a multi-skill plan)', 'Mining (learn new skills safely)', 'Interop (SKILL.md round-trip + MCP discovery)']) {
      const rows = result.sections[name]!.filter((r) => KEY || !embedderDependent.has(r.name));
      expect(rows.every((r) => r.pass), `${name}: ${JSON.stringify(rows)}`).toBe(true);
    }
  }, 60_000);
});
