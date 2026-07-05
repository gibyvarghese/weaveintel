// SPDX-License-Identifier: MIT
/**
 * The skill-system benchmark, run as a guarded test.
 *
 * This asserts that every capability shipped across the phases meets the public-benchmark-aligned
 * targets — retrieval quality, composition, security detection, evaluation calibration, interop
 * fidelity, mining safety, and throughput at scale. It runs hermetically by default (a deterministic
 * embedder), and against REAL OpenAI embeddings when a key is present. It prints the full scorecard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runSkillBenchmark, BENCHMARK_TARGETS } from '../skill-benchmark.js';
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

describe('skill-system benchmark', () => {
  it('meets every public-benchmark-aligned target (hermetic, deterministic embedder)', async () => {
    const result = await runSkillBenchmark({ log: (l) => console.log(l) });
    // Surface any miss with its section for a readable failure.
    const misses = Object.entries(result.sections).flatMap(([section, rows]) => rows.filter((r) => !r.pass).map((r) => `${section} → ${r.name} = ${r.value.toFixed(3)} (target ${r.higherIsBetter ? '≥' : '≤'} ${r.target})`));
    expect(misses, misses.join('\n')).toHaveLength(0);
    expect(result.passed).toBe(true);
  }, 60_000);

  it('the targets themselves match the public benchmarks (documented constants)', () => {
    // Guard against silent target drift — these mirror SkillRouter/SkillsBench + MalSkillBench/Snyk.
    expect(BENCHMARK_TARGETS.retrieval.recallAt5).toBeGreaterThanOrEqual(0.85);
    expect(BENCHMARK_TARGETS.security.maliciousRecall).toBeGreaterThanOrEqual(0.9); // Snyk agent-scan 90–100%
    expect(BENCHMARK_TARGETS.security.attackSuccessRate).toBe(0);                    // vs 84%+ public ASR undefended
    expect(BENCHMARK_TARGETS.mining.neverAutoEnable).toBe(1);
  });

  it.skipIf(!KEY)('also meets the retrieval targets with REAL OpenAI embeddings', async () => {
    const realEmbed: SkillEmbedFn = async (texts) => {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
      return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map((d) => d.embedding);
    };
    const result = await runSkillBenchmark({ embed: realEmbed, stressCatalogSize: 500, log: (l) => console.log(l) });
    const retrieval = result.sections['Retrieval (find the right skill)']!;
    // With real embeddings, retrieval quality should be at least as strong.
    expect(retrieval.find((r) => r.name === 'Recall@5')!.pass).toBe(true);
    expect(retrieval.find((r) => r.name === 'MRR@10')!.pass).toBe(true);
    // The safety and interop guarantees are embedder-independent — still all green.
    for (const name of ['Security (block bad skills & attacks)', 'Mining (learn new skills safely)', 'Interop (SKILL.md round-trip + MCP discovery)']) {
      expect(result.sections[name]!.every((r) => r.pass), name).toBe(true);
    }
  }, 120_000);
});
