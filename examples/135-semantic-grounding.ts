/**
 * Example 135 — Semantic grounding check (W3)
 *
 * Demonstrates embedding-based grounding using weaveFakeEmbedding.
 * Compares a grounded response vs an off-topic response against the
 * same user query.
 *
 * Run: npx tsx examples/135-semantic-grounding.ts
 */
import type { Guardrail } from '@weaveintel/core';
import { weaveFakeEmbedding } from '@weaveintel/testing';
import { createGuardrailPipeline } from '@weaveintel/guardrails';

const SEMANTIC_GROUNDING: Guardrail = {
  id: 'sem-grounding',
  name: 'Semantic Grounding',
  type: 'model-graded',
  stage: 'post-execution',
  enabled: true,
  config: {
    rule: 'semantic-grounding',
    min_similarity: 0.60,
    evidence_field: 'userInput',
    timeout_ms: 5000,
    on_error: 'allow',
  },
};

const LEXICAL_GROUNDING: Guardrail = {
  id: 'lex-grounding',
  name: 'Lexical Grounding (fallback)',
  type: 'custom',
  stage: 'post-execution',
  enabled: true,
  config: { rule: 'grounding-overlap', category: 'cognitive', min_overlap: 0.06 },
};

async function check(
  label: string,
  userInput: string,
  assistantOutput: string,
  toolEvidence?: string,
) {
  const embeddingModel = weaveFakeEmbedding({ dimensions: 128 });

  const pipeline = createGuardrailPipeline(
    [SEMANTIC_GROUNDING, LEXICAL_GROUNDING],
    { shortCircuitOnDeny: false, embeddingModel },
  );

  const results = await pipeline.evaluate(assistantOutput, 'post-execution', {
    userInput,
    assistantOutput,
    toolEvidence,
  });

  console.log(`\n── ${label}`);
  console.log(`   Query:    "${userInput}"`);
  console.log(`   Response: "${assistantOutput.slice(0, 100)}"`);
  for (const r of results) {
    const sim = r.metadata?.['similarity'] !== undefined
      ? ` sim=${Number(r.metadata['similarity']).toFixed(3)}`
      : r.metadata?.['overlap'] !== undefined
        ? ` overlap=${Number(r.metadata['overlap']).toFixed(3)}`
        : '';
    console.log(`   [${r.decision.toUpperCase().padEnd(5)}] ${r.guardrailId}${sim} — ${r.explanation?.slice(0, 80) ?? ''}`);
  }
}

async function main() {
  console.log('\n=== Example 135: Semantic Grounding Check ===');
  console.log('Uses weaveFakeEmbedding — hash-based, not semantically meaningful.');
  console.log('Expect warnings even for "similar" pairs; a real embedder would score correctly.\n');

  await check(
    'Tool-grounded answer (short-circuit: bypasses embedding check)',
    'What is the weather in London today?',
    "Today in London it's partly cloudy with a high of 18°C.",
    'weather_api(city=London) => { temp: 18, condition: "partly cloudy" }',
  );

  await check(
    'Semantically similar answer (should allow)',
    'Explain TypeScript generics',
    'TypeScript generics allow you to write reusable, type-safe code that works across different types.',
  );

  await check(
    'Unrelated answer (should warn — low similarity)',
    'Explain TypeScript generics',
    'The capital of France is Paris, which is a beautiful city on the Seine river.',
  );

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
