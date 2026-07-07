/**
 * Example 168: Skill-System Benchmark
 *
 * Measures how good your *skills layer* is — NOT how good the model is. It runs the same battery the
 * public agent-skill benchmarks use (SkillRouter, SkillsBench, MalSkillBench, AgentDojo, Agent-Security-
 * Bench) and prints a scorecard with those benchmarks' targets, so you can see whether your skills
 * layer is performing where it should. It exercises every capability the package ships:
 *
 *   • Retrieval   — can it find the right skill for a request?      (Hit@1, Recall@5/10, MRR, nDCG)
 *   • Composition — can it order a multi-skill plan correctly?      (ordering, dependencies, cycles)
 *   • Security    — does it block malicious skills and attacks?     (recall, false-positives, ASR)
 *   • Evaluation  — does it rank good skills over weak ones?        (calibration)
 *   • Interop     — SKILL.md round-trip + MCP discovery             (fidelity, discovery accuracy)
 *   • Mining      — does it learn new skills SAFELY?                (never auto-enable, no injection mint)
 *   • Scale       — throughput + latency over a big catalog         (stress)
 *
 * Optional environment variables:
 *   OPENAI_API_KEY — if set, retrieval is scored with REAL embeddings; otherwise a deterministic
 *                    (hermetic) embedder is used so the example runs offline.
 *
 * WeaveIntel packages used:
 *   @weaveintel/skills — runSkillBenchmark() runs the whole battery and returns a scorecard.
 *                        buildDemoCatalog() / DEMO_QUERIES are the built-in demo dataset; swap in your
 *                        own catalog + labelled queries to benchmark YOUR skills.
 *
 * Run:  tsx examples/168-skill-benchmark.ts
 */
import 'dotenv/config';
import { runSkillBenchmark, buildDemoCatalog, DEMO_QUERIES } from '@weaveintel/skills';
import type { SkillEmbedFn } from '@weaveintel/skills';

// If you have an OpenAI key, score retrieval with real embeddings; otherwise run fully offline.
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
  console.log(`Benchmarking a catalog of ${buildDemoCatalog().length} skills over ${DEMO_QUERIES.length} labelled queries`);
  console.log(`Embeddings: ${realEmbed ? 'REAL (OpenAI text-embedding-3-small)' : 'deterministic (offline demo)'}\n`);

  // To benchmark YOUR OWN skills, pass { catalog: mySkills, queries: myLabelledQueries }.
  const result = await runSkillBenchmark({ embed: realEmbed, log: (line) => console.log(line) });

  // The scorecard is already printed above via `log`. Use the structured result to gate CI, etc.
  process.exitCode = result.passed ? 0 : 1;
  console.log(result.passed ? 'Benchmark PASSED — skills layer meets public-benchmark targets.' : 'Benchmark FAILED — see the ❌ rows above.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
