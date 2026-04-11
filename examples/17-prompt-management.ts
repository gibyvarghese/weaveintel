/**
 * Example 17 — Prompt Management & A/B Testing
 *
 * Demonstrates:
 *  • Template creation with {{variable}} substitution
 *  • Prompt registry with versioning and filtering
 *  • Instruction bundles for layered system prompts
 *  • Prompt experiments (A/B testing) with weighted variants
 *  • Prompt resolver with experiment-aware selection
 *
 * No API keys needed — all in-memory.
 *
 * Run: npx tsx examples/17-prompt-management.ts
 */

import {
  createTemplate,
  extractVariables,
  InMemoryPromptRegistry,
  InstructionBundleBuilder,
  composeInstructions,
  createInstructionBundle,
  InMemoryExperimentStore,
  PromptResolver,
} from '@weaveintel/prompts';

import type {
  PromptDefinition,
  PromptVersion,
  PromptVariable,
  PromptExperiment,
} from '@weaveintel/core';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function main() {

/* ── 1. Template engine ───────────────────────────────── */

header('1. Template Creation & Rendering');

const summaryTemplate = createTemplate({
  name: 'Document Summarizer',
  template: 'Summarize the following {{documentType}} in {{language}}.\n\nContent: {{content}}\n\nProvide a {{length}} summary.',
  variables: [
    { name: 'documentType', type: 'string', required: true },
    { name: 'language', type: 'string', required: true },
    { name: 'content', type: 'string', required: true },
    { name: 'length', type: 'string', required: false, defaultValue: 'concise' },
  ],
});

console.log(`  Template: "${summaryTemplate.name}"`);
console.log(`  Variables: ${summaryTemplate.variables.map(v => v.name).join(', ')}`);

const rendered = summaryTemplate.render({
  documentType: 'financial report',
  language: 'English',
  content: 'Q3 revenue increased 15% YoY to $2.3B...',
});
console.log(`  Rendered:\n    ${rendered.split('\n').join('\n    ')}`);

// Auto-detect variables from template string
const detectedVars = extractVariables('Hello {{name}}, welcome to {{organization}}!');
console.log(`\n  Auto-detected variables: ${detectedVars.join(', ')}`);

/* ── 2. Prompt Registry ───────────────────────────────── */

header('2. Prompt Registry — Versioning & Filtering');

const registry = new InMemoryPromptRegistry();

// Register prompts with versions
const summarizeDef: PromptDefinition = {
  id: 'summarize',
  name: 'Summarize',
  description: 'Summarization prompts',
  category: 'generation',
  tags: ['summarize', 'nlp'],
  currentVersion: '2.0',
};

const v1: PromptVersion = {
  id: 'sum-v1',
  promptId: 'summarize',
  version: '1.0',
  template: 'Summarize this: {{content}}',
  variables: [{ name: 'content', type: 'string', required: true }],
  changelog: 'Initial version',
  createdAt: new Date().toISOString(),
};

const v2: PromptVersion = {
  id: 'sum-v2',
  promptId: 'summarize',
  version: '2.0',
  template: 'You are a {{role}}. Summarize the following {{documentType}} concisely:\n\n{{content}}',
  variables: [
    { name: 'role', type: 'string', required: false, defaultValue: 'analyst' },
    { name: 'documentType', type: 'string', required: true },
    { name: 'content', type: 'string', required: true },
  ],
  changelog: 'Added role and documentType params',
  createdAt: new Date().toISOString(),
};

await registry.register(summarizeDef, v1);
await registry.register(summarizeDef, v2);

const classifyDef: PromptDefinition = {
  id: 'classify',
  name: 'Classify',
  description: 'Classification prompts',
  category: 'classification',
  tags: ['classify', 'nlp'],
  currentVersion: '1.0',
};

const classifyV1: PromptVersion = {
  id: 'cls-v1',
  promptId: 'classify',
  version: '1.0',
  template: 'Classify this text into categories [{{categories}}]:\n\n{{text}}',
  variables: [
    { name: 'categories', type: 'string', required: true },
    { name: 'text', type: 'string', required: true },
  ],
  createdAt: new Date().toISOString(),
};

await registry.register(classifyDef, classifyV1);

// List and filter
const allPrompts = await registry.list();
console.log(`  Total prompts: ${allPrompts.length}`);
for (const p of allPrompts) {
  console.log(`    - ${p.name} (category: ${p.category}, tags: ${p.tags?.join(', ')})`);
}

const nlpPrompts = await registry.list({ tags: ['nlp'] });
console.log(`  NLP tagged: ${nlpPrompts.length}`);

const genPrompts = await registry.list({ category: 'generation' });
console.log(`  Generation category: ${genPrompts.length}`);

// Resolve with variable substitution
const resolved = await registry.resolve('summarize', {
  role: 'data scientist',
  documentType: 'research paper',
  content: 'We present a novel approach to...',
});
console.log(`\n  Resolved (latest version):\n    ${resolved.split('\n').join('\n    ')}`);

// Get specific version
const oldVersion = await registry.get('summarize', '1.0');
console.log(`\n  Version 1.0 template: "${oldVersion?.template}"`);

/* ── 3. Instruction Bundles ───────────────────────────── */

header('3. Instruction Bundles — Layered Prompts');

const bundle = createInstructionBundle('assistant-v3', 'Research Assistant')
  .system('You are a highly capable research assistant with expertise in scientific literature.')
  .task('Analyze the provided research papers and produce a structured literature review.')
  .formatting('Use markdown with headers. Cite papers as [Author, Year]. Maximum 2000 words.')
  .guardrails('Never fabricate citations. If uncertain, say so. Do not speculate beyond the evidence.')
  .examples(
    'User: Analyze these 3 papers on transformer architectures.\nAssistant: ## Literature Review\n...',
    'User: Compare these two conflicting studies.\nAssistant: ## Comparative Analysis\n...',
  )
  .build();

console.log(`  Bundle: "${bundle.name}" (id: ${bundle.id})`);
console.log(`  Sections: system, task, formatting, guardrails, ${bundle.examples?.length ?? 0} examples`);

const composed = composeInstructions(bundle);
console.log(`\n  Composed system prompt (${composed.length} chars):`);
const lines = composed.split('\n');
for (const line of lines.slice(0, 8)) console.log(`    ${line}`);
if (lines.length > 8) console.log(`    ... (${lines.length - 8} more lines)`);

// Also test direct builder pattern
const simpleBundle = new InstructionBundleBuilder('simple', 'Simple')
  .system('You are a helpful assistant.')
  .guardrails('Be concise and accurate.')
  .build();
console.log(`\n  Simple bundle: "${simpleBundle.name}" — ${composeInstructions(simpleBundle).length} chars`);

/* ── 4. Prompt Experiments ────────────────────────────── */

header('4. A/B Testing — Prompt Experiments');

const experimentStore = new InMemoryExperimentStore();

const experiment: PromptExperiment = {
  id: 'exp-tone-test',
  name: 'Tone Test: Formal vs Casual',
  promptId: 'summarize',
  variants: [
    { id: 'formal', promptId: 'summarize', versionId: 'sum-v2', weight: 0.5, label: 'Formal Tone' },
    { id: 'casual', promptId: 'summarize', versionId: 'sum-v1', weight: 0.3, label: 'Casual Tone' },
    { id: 'neutral', promptId: 'summarize', versionId: 'sum-v2', weight: 0.2, label: 'Neutral Tone' },
  ],
  status: 'active',
  startedAt: new Date().toISOString(),
};

experimentStore.addExperiment(experiment);

// Simulate variant selection 20 times
const counts: Record<string, number> = {};
for (let i = 0; i < 20; i++) {
  const variant = await experimentStore.pickVariant('exp-tone-test');
  if (variant) {
    counts[variant.label] = (counts[variant.label] ?? 0) + 1;
    await experimentStore.recordImpression('exp-tone-test', variant.id);
    // Simulate scoring
    const score = 0.6 + Math.random() * 0.4; // 0.6-1.0
    await experimentStore.recordScore('exp-tone-test', variant.id, score);
  }
}

console.log('  Variant selections (20 runs):');
for (const [label, count] of Object.entries(counts)) {
  console.log(`    ${label}: ${count} times`);
}

const expData = await experimentStore.getExperiment('exp-tone-test');
if (expData?.results) {
  console.log('\n  Experiment results:');
  for (const [variantId, result] of Object.entries(expData.results)) {
    const variant = experiment.variants.find(v => v.id === variantId);
    console.log(`    ${variant?.label ?? variantId}: impressions=${result.impressions}, avg score=${result.score.toFixed(3)}`);
  }
}

/* ── 5. Prompt Resolver ───────────────────────────────── */

header('5. Prompt Resolver — Experiment-Aware');

// Create a version store adapter from the registry
const versionStore = {
  async getVersion(promptId: string, version?: string) {
    return registry.get(promptId, version);
  },
};

const resolver = new PromptResolver(versionStore, experimentStore);

// Without experiment — returns latest version
const defaultVersion = await resolver.resolve('summarize', {});
console.log(`  Default resolve: version "${defaultVersion.version}" (${defaultVersion.id})`);

// With experiment — picks variant
const experimentVersion = await resolver.resolve('summarize', { experimentId: 'exp-tone-test' });
console.log(`  Experiment resolve: version "${experimentVersion.version}" (${experimentVersion.id})`);

// Multiple resolves show the weighted distribution
const versionPicks: Record<string, number> = {};
for (let i = 0; i < 10; i++) {
  const v = await resolver.resolve('summarize', { experimentId: 'exp-tone-test' });
  versionPicks[v.version] = (versionPicks[v.version] ?? 0) + 1;
}
console.log(`  10 experiment resolves: ${JSON.stringify(versionPicks)}`);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Template creation with {{variable}} substitution and auto-detection');
console.log('✅ Prompt registry with versioning, categories, and tags');
console.log('✅ Instruction bundles for layered system prompts');
console.log('✅ A/B testing with weighted variant selection');
console.log('✅ Experiment-aware prompt resolution');
}

main().catch(console.error);
