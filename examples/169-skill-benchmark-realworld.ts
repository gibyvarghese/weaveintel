/**
 * Example 169: Real-World Skill Benchmark
 *
 * The same skill-system benchmark as example 168, but on a REAL-WORLD dataset:
 *   • ~50 skills modelled on actual published Agent Skills — Anthropic's official set
 *     (pdf, docx, xlsx, pptx, skill-creator, mcp-builder, brand-guidelines, canvas-design, …) plus
 *     popular community skills from awesome-agent-skills (Next.js, Terraform, Stripe, Playwright,
 *     Semgrep, Notion, Cloudflare Workers, PostgreSQL, …).
 *   • Real human messages — the messy, colloquial, typo-ridden way people actually ask ("my nextjs
 *     site feels really sluggish, how do i speed it up", "scan my repo for any passwords i left in").
 *
 * Many of these skills overlap (three different security skills; Playwright vs Cypress vs webapp
 * testing), so finding the *right* one from a vague request is genuinely hard — exactly what
 * meaning-based retrieval is for. Set OPENAI_API_KEY to score retrieval with real embeddings.
 *
 * WeaveIntel packages used:
 *   @weaveintel/skills — runSkillBenchmark(), buildRealWorldCatalog(), REAL_WORLD_QUERIES
 *
 * Run:  OPENAI_API_KEY=... tsx examples/169-skill-benchmark-realworld.ts
 */
import 'dotenv/config';
import { runSkillBenchmark, buildRealWorldCatalog, REAL_WORLD_QUERIES } from '@weaveintel/skills';
import type { SkillEmbedFn } from '@weaveintel/skills';

const KEY = process.env.OPENAI_API_KEY;
const realEmbed: SkillEmbedFn | undefined = KEY
  ? async (texts) => {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
      return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map((d) => d.embedding);
    }
  : undefined;

async function main() {
  const catalog = buildRealWorldCatalog();
  console.log(`Real-world catalog: ${catalog.length} skills modelled on published Agent Skills`);
  console.log(`Queries: ${REAL_WORLD_QUERIES.length} messy human messages`);
  console.log(`Embeddings: ${realEmbed ? 'REAL (OpenAI)' : 'deterministic offline (retrieval will lean on keywords — set OPENAI_API_KEY for the real picture)'}\n`);

  const result = await runSkillBenchmark({ catalog, queries: REAL_WORLD_QUERIES, embed: realEmbed, log: (l) => console.log(l) });
  process.exitCode = result.passed ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
