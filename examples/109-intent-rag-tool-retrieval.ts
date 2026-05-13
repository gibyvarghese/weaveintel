/**
 * Example 109 — Cost Governor Phase 8 — Intent-RAG Tool Retrieval.
 *
 * Demonstrates the per-step top-K tool retrieval lever in
 * `@weaveintel/cost-governor`. Pure in-memory, no DB, no LLM, no network.
 *
 * The "embedder" is a deterministic word-hash bag-of-words vectoriser so
 * the example is reproducible and runs in <100 ms with no API key.
 *
 * What this shows:
 *   1. `cosineSimilarity` and `hashDescription` pure helpers.
 *   2. `decideIntentRagSubset` — pure ranking decision.
 *   3. `weaveIntentRagToolSubsetFilter` — full filter factory with a stub
 *      `Embedder` + in-memory `EmbeddingStore` + `GoalResolver`.
 *   4. Pass-through guarantees: no goal, embedder throws, empty store,
 *      zero overlap → all return `null` (consumer keeps full registry).
 *   5. `includeAlways` — a `submit` tool always survives.
 *   6. `topK` clamp + `minSimilarity` threshold.
 */

import {
  cosineSimilarity,
  hashDescription,
  decideIntentRagSubset,
  weaveIntentRagToolSubsetFilter,
  type Embedder,
  type EmbeddingStore,
  type ToolEmbedding,
} from '@weaveintel/cost-governor';

// ─── 1. Stub deterministic embedder (no API key, no network) ────────────

const VOCAB = [
  'fit', 'model', 'train', 'gradient', 'boosting', 'tree', 'random', 'forest',
  'submit', 'prediction', 'kaggle', 'csv', 'load', 'data', 'feature',
  'engineer', 'cross', 'validation', 'tune', 'hyperparameter', 'evaluate',
  'metric', 'visualize', 'plot', 'explore',
];
const DIM = VOCAB.length;

function bagOfWordsEmbed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const tok of tokens) {
    const idx = VOCAB.indexOf(tok);
    if (idx >= 0) vec[idx] = (vec[idx] ?? 0) + 1;
  }
  // L2 normalise for stable cosine
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

const stubEmbedder: Embedder = {
  modelId: 'stub-bag-of-words',
  dimension: DIM,
  async embed(texts) {
    return texts.map(bagOfWordsEmbed);
  },
};

// ─── 2. Tool catalog ────────────────────────────────────────────────────

const TOOLS: Record<string, string> = {
  load_data: 'Load CSV data and explore feature distributions',
  feature_engineer: 'Engineer new features from raw data',
  fit_random_forest: 'Fit a random forest model on training data',
  fit_gradient_boosting: 'Fit a gradient boosting tree model',
  cross_validate: 'Run cross validation to evaluate model fit',
  tune_hyperparameter: 'Tune hyperparameter for the current model',
  visualize_plot: 'Visualize plot of feature distributions',
  evaluate_metric: 'Evaluate metric on hold-out set',
  submit_prediction: 'Submit prediction CSV to Kaggle',
};

// ─── 3. In-memory embedding store + warm it once ────────────────────────

class InMemoryStore implements EmbeddingStore {
  private readonly data = new Map<string, ToolEmbedding>();
  async get(k: string) { return this.data.get(k) ?? null; }
  async getAll() { return Array.from(this.data.values()); }
  async upsert(e: ToolEmbedding) { this.data.set(e.toolKey, e); }
}

async function warm(store: EmbeddingStore, embedder: Embedder) {
  const keys = Object.keys(TOOLS);
  const descs = keys.map((k) => TOOLS[k]!);
  const vectors = await embedder.embed(descs);
  for (let i = 0; i < keys.length; i++) {
    await store.upsert({
      toolKey: keys[i]!,
      modelId: embedder.modelId,
      dimension: embedder.dimension,
      vector: [...vectors[i]!],
      descriptionHash: hashDescription(descs[i]!),
    });
  }
}

// ─── 4. Demo ────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Phase 8 — Intent-RAG Tool Retrieval ===\n');

  // 4.1 — Pure helpers
  const v1 = bagOfWordsEmbed('fit a random forest model');
  const v2 = bagOfWordsEmbed('train a random forest');
  console.log(`cosineSimilarity('fit a random forest model', 'train a random forest') = ${cosineSimilarity(v1, v2).toFixed(3)}`);
  console.log(`hashDescription('hello') = ${hashDescription('hello')}`);
  console.log();

  // 4.2 — Warm store
  const store = new InMemoryStore();
  await warm(store, stubEmbedder);
  const allEmb = await store.getAll();
  console.log(`Warmed ${allEmb.length} tool embeddings (dim=${stubEmbedder.dimension})\n`);

  const availableKeys = Object.keys(TOOLS);

  // 4.3 — Pure decision: ranking for a modelling goal
  const modellingGoal = await stubEmbedder.embed(['fit a gradient boosting model and tune hyperparameter']);
  const d1 = decideIntentRagSubset({
    config: { topK: 4, minSimilarity: 0.1 },
    availableKeys,
    goalVector: modellingGoal[0]!,
    toolEmbeddings: allEmb,
  });
  console.log(`Goal: "fit a gradient boosting model and tune hyperparameter"`);
  console.log(`  filtered: ${d1.filtered}  keep: ${JSON.stringify(d1.keep)}`);
  console.log(`  reason : ${d1.reason}\n`);

  // 4.4 — Different goal — submission
  const submitGoal = await stubEmbedder.embed(['submit prediction csv to kaggle']);
  const d2 = decideIntentRagSubset({
    config: { topK: 4, minSimilarity: 0.1, includeAlways: ['submit_prediction'] },
    availableKeys,
    goalVector: submitGoal[0]!,
    toolEmbeddings: allEmb,
  });
  console.log(`Goal: "submit prediction csv to kaggle"`);
  console.log(`  filtered: ${d2.filtered}  keep: ${JSON.stringify(d2.keep)}`);
  console.log(`  reason : ${d2.reason}\n`);

  // 4.5 — End-to-end filter via factory
  const filter = weaveIntentRagToolSubsetFilter({
    config: { strategy: 'intent-rag', topK: 3, minSimilarity: 0.1, includeAlways: ['submit_prediction'] },
    embedder: stubEmbedder,
    embeddingStore: store,
    goalResolver: (ctx) => (ctx as { goal?: string }).goal ?? null,
    log: () => {},
  });

  const r1 = await filter(availableKeys, { goal: 'cross validation random forest' } as never);
  console.log(`Filter (goal="cross validation random forest"): ${JSON.stringify(r1)}`);

  // 4.6 — Pass-through: no goal
  const r2 = await filter(availableKeys, {} as never);
  console.log(`Filter (no goal): ${r2 === null ? 'null (pass-through, full registry)' : JSON.stringify(r2)}`);

  // 4.7 — Pass-through: embedder throws
  const throwingEmbedder: Embedder = {
    modelId: 'throws',
    dimension: DIM,
    async embed() { throw new Error('boom'); },
  };
  const filter2 = weaveIntentRagToolSubsetFilter({
    config: { strategy: 'intent-rag', topK: 3 },
    embedder: throwingEmbedder,
    embeddingStore: store,
    goalResolver: () => 'fit model',
    log: () => {},
  });
  const r3 = await filter2(availableKeys, {} as never);
  console.log(`Filter (embedder throws): ${r3 === null ? 'null (pass-through)' : JSON.stringify(r3)}`);

  // 4.8 — Pass-through: empty store
  const filter3 = weaveIntentRagToolSubsetFilter({
    config: { strategy: 'intent-rag', topK: 3 },
    embedder: stubEmbedder,
    embeddingStore: new InMemoryStore(),
    goalResolver: () => 'fit model',
    log: () => {},
  });
  const r4 = await filter3(availableKeys, {} as never);
  console.log(`Filter (empty store): ${r4 === null ? 'null (pass-through)' : JSON.stringify(r4)}`);

  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
