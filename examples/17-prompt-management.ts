/**
 * Example 17 — Prompt Management, A/B Testing & Phase 2 Capabilities
 *
 * Demonstrates:
 *  • Template creation with {{variable}} substitution
 *  • Prompt registry with versioning and filtering
 *  • Instruction bundles for layered system prompts
 *  • Prompt experiments (A/B testing) with weighted variants
 *  • Prompt resolver with experiment-aware selection
 *  • Phase 2: Fragment registry — reusable {{>key}} block inclusions
 *  • Phase 2: Framework registry — named ordered section structures
 *  • Phase 2: Lint — static analysis with typed diagnostics
 *  • Phase 2: Provider adapters — OpenAI / Anthropic wire formats
 *  • Phase 2: renderWithOptions() — unified entry point
 *  • Phase 4: Strategy runtime — executePromptRecord() with DB-backed strategy overlays
 *  • Phase 4: InMemoryPromptStrategyRegistry + strategyFromRecord() integration
 *  • Phase 8: Shared capability telemetry — prompt execution emits one reusable observability shape
 *
 * WeaveIntel packages used:
 *   @weaveintel/prompts — Full prompt lifecycle management
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
    executePromptRecord,
    InMemoryPromptStrategyRegistry,
    defaultPromptStrategyRegistry,
    strategyFromRecord,
  renderPromptVersion,
  // Phase 2 exports
  InMemoryFragmentRegistry,
  InMemoryFrameworkRegistry,
  renderFramework,
  defaultFrameworkRegistry,
  resolveFragments,
  extractFragmentKeys,
  lintPromptTemplate,
  hasLintErrors,
  topLintSeverity,
  formatLintResults,
  renderWithOptions,
  openAIAdapter,
  anthropicAdapter,
  textAdapter,
  resolveAdapter,
  createPromptCapabilityTelemetry,
} from '@weaveintel/prompts';
import {
  weaveInMemoryTracer,
  annotateSpanWithCapabilityTelemetry,
} from '@weaveintel/observability';
import { weaveContext } from '@weaveintel/core';

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

// createTemplate() builds a renderable prompt template. Variables use
// {{name}} syntax. Each variable can be required or optional (with a
// defaultValue). .render() substitutes all slots and returns the final string.
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
// extractVariables() scans a raw template string and returns all
// {{variable}} names without needing a formal template definition.
const detectedVars = extractVariables('Hello {{name}}, welcome to {{organization}}!');
console.log(`\n  Auto-detected variables: ${detectedVars.join(', ')}`);

/* ── 2. Prompt Registry ───────────────────────────────── */

header('2. Prompt Registry — Versioning & Filtering');

// InMemoryPromptRegistry stores PromptDefinitions with multiple
// PromptVersions. register() adds/updates; list() supports filtering
// by category and tags; resolve() renders the latest version with variables;
// get(id, version) retrieves a specific historical version.
const registry = new InMemoryPromptRegistry();

// Register prompts with versions
const summarizeDef: PromptDefinition = {
  id: 'summarize',
  key: 'summarize',
  name: 'Summarize',
  description: 'Summarization prompts',
  category: 'generation',
  tags: ['summarize', 'nlp'],
  kind: 'template',
  status: 'published',
  currentVersion: '2.0',
};

const v1: PromptVersion = {
  id: 'sum-v1',
  promptId: 'summarize',
  version: '1.0',
  kind: 'template',
  template: 'Summarize this: {{content}}',
  variables: [{ name: 'content', type: 'string', required: true }],
  changelog: 'Initial version',
  createdAt: new Date().toISOString(),
};

const v2: PromptVersion = {
  id: 'sum-v2',
  promptId: 'summarize',
  version: '2.0',
  kind: 'template',
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
  key: 'classify',
  name: 'Classify',
  description: 'Classification prompts',
  category: 'classification',
  tags: ['classify', 'nlp'],
  kind: 'template',
  status: 'published',
  currentVersion: '1.0',
};

const classifyV1: PromptVersion = {
  id: 'cls-v1',
  promptId: 'classify',
  version: '1.0',
  kind: 'template',
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

// renderPromptVersion() is the package-level runtime helper that apps like
// geneWeave can call after loading a typed prompt version from a DB adapter.
if (oldVersion) {
  console.log(`  Re-render via shared runtime helper: ${renderPromptVersion(oldVersion, { content: 'Example content' })}`);
}

// End-to-end DB-backed runtime execution with strategy + hook/eval support.
// This mirrors how GeneWeave loads prompt rows, resolves execution strategy,
// and emits structured metadata for observability.
const runtimeRow = {
  id: 'db-prompt-support',
  key: 'support.reply',
  name: 'Support Reply Prompt',
  description: 'Craft a clear, empathetic support response grounded in the ticket details and requested tone.',
  prompt_type: 'template',
  template: 'Reply to {{customer}} with a {{tone}} update.',
  variables: JSON.stringify([
    { name: 'customer', type: 'string', required: true },
    { name: 'tone', type: 'string', required: true, defaultValue: 'friendly' },
  ]),
  version: '1.0',
  status: 'published',
  execution_defaults: JSON.stringify({ strategy: 'db-strategy-support-quality' }),
};

const dbStrategyRow = {
  id: 'strategy-db-support-quality',
  key: 'db-strategy-support-quality',
  name: 'Support Quality Strategy',
  description: 'Adds support-quality checks before final output generation.',
  instruction_prefix: 'You are handling a customer support escalation. Prioritize factual accuracy and empathy.',
  instruction_suffix: 'Before finalizing: ensure the response includes next steps, owner, and ETA.',
  config: JSON.stringify({ delimiter: '\n\n' }),
};

const strategyRegistry = new InMemoryPromptStrategyRegistry(defaultPromptStrategyRegistry.list());
strategyRegistry.register(strategyFromRecord(dbStrategyRow));

const runtimeRendered = executePromptRecord(runtimeRow, { customer: 'Acme Ltd', tone: 'professional' }, {
  strategyRegistry,
  evaluations: [
    {
      id: 'non_empty',
      description: 'Rendered prompt should not be empty.',
      evaluate: ({ content }) => ({ passed: content.trim().length > 0, score: 1 }),
    },
  ],
});

console.log(`  Strategy requested: ${runtimeRendered.strategy.requestedKey}`);
console.log(`  Strategy resolved: ${runtimeRendered.strategy.resolvedKey} (fallback=${runtimeRendered.strategy.usedFallback})`);
console.log(`  DB-backed runtime output: ${runtimeRendered.content}`);
console.log(`  Runtime evaluations passed: ${runtimeRendered.evaluations.filter((e) => e.passed).length}/${runtimeRendered.evaluations.length}`);

// Phase 8 uses one shared telemetry schema for prompts, skills, agents, and
// tools. The prompt package builds the prompt-specific summary; the
// observability package writes it to spans.
const promptTelemetry = createPromptCapabilityTelemetry(runtimeRendered, {
  source: 'db',
  selectedBy: 'execution_defaults',
  metadata: { example: '17-prompt-management' },
});

const tracer = weaveInMemoryTracer();
await tracer.withSpan(
  weaveContext({ userId: 'example-user', deadline: Date.now() + 5_000 }),
  'example.prompt.runtime',
  async (span) => {
    annotateSpanWithCapabilityTelemetry(span, promptTelemetry);
  },
);

console.log(`  Phase 8 telemetry captured: ${tracer.spans[0]?.attributes['capability.kind']} -> ${tracer.spans[0]?.attributes['capability.key']}`);

/* ── 3. Instruction Bundles ───────────────────────────── */

header('3. Instruction Bundles — Layered Prompts');

// createInstructionBundle() + fluent builder creates layered system prompts.
// Each layer (system, task, formatting, guardrails, examples) is composed
// into a single string by composeInstructions(). This separates concerns
// and lets you swap individual layers without rewriting the entire prompt.
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

// InMemoryExperimentStore tracks A/B experiments. Each experiment has
// weighted variants pointing to different prompt versions. pickVariant()
// selects according to weights; recordImpression() and recordScore()
// track usage and quality metrics for winner determination.
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

// PromptResolver wraps the registry and experiment store together.
// resolve(promptId, { experimentId? }) either picks a variant from an
// active experiment or falls back to the latest version from the registry.
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

/* ── 6. Phase 2: Fragment Registry ───────────────────── */

header('6. Phase 2 — Fragment Registry ({{>key}} Inclusions)');

// Fragments are reusable text blocks stored in a registry and included
// in templates via {{>fragmentKey}} syntax. They are expanded before
// variable interpolation so they can themselves contain {{variables}}.
//
// Build a registry with two reusable fragments:
const fragmentRegistry = new InMemoryFragmentRegistry();
fragmentRegistry.register({
  key: 'safety_notice',
  name: 'Safety Notice',
  description: 'Standard safety disclaimer appended to agent system prompts.',
  content: 'SAFETY: Never produce harmful, hateful, or illegal content. Decline politely and explain why.',
});
fragmentRegistry.register({
  key: 'json_contract',
  name: 'JSON Output Contract',
  description: 'Instructs the model to respond with valid JSON only.',
  content: 'OUTPUT FORMAT: Respond with valid JSON only. No markdown fences or prose outside the JSON object.',
});
fragmentRegistry.register({
  key: 'cot',
  name: 'Chain-of-Thought',
  description: 'Ask the model to think step by step.',
  content: 'Think step-by-step before giving your final answer. Show your reasoning explicitly.',
});

// Resolve a template that embeds two fragments
const fragmentTemplate = 'You are a {{role}}.\n\n{{>safety_notice}}\n\n{{>cot}}\n\nTask: {{task}}';
console.log(`  Template keys referenced: ${extractFragmentKeys(fragmentTemplate).join(', ')}`);

const expanded = resolveFragments(fragmentTemplate, fragmentRegistry);
console.log(`\n  Expanded template:\n${expanded.split('\n').map(l => `    ${l}`).join('\n')}`);

// Unresolvable keys are left in place (non-strict) so lint can catch them
const badTemplate = 'Hello {{>missing_key}} world';
const partiallyExpanded = resolveFragments(badTemplate, fragmentRegistry);
console.log(`\n  Unresolvable marker left intact: "${partiallyExpanded}"`);

/* ── 7. Phase 2: Framework Registry ──────────────────── */

header('7. Phase 2 — Framework Registry (Named Section Structures)');

// Frameworks define ordered, named sections (role/task/context/expectations).
// renderFramework() assembles them in renderOrder, skipping empty optional ones.
// defaultFrameworkRegistry has 4 built-ins: rtce, full, critique, judge.
const rtce = defaultFrameworkRegistry.get('rtce');
if (rtce) {
  console.log(`  Framework: "${rtce.name}"`);
  console.log(`  Sections: ${rtce.sections.map(s => `${s.key}(${s.required ? 'required' : 'optional'})`).join(' → ')}`);

  const result = renderFramework(rtce, {
    role: 'You are a senior data analyst specialising in financial datasets.',
    task: 'Identify the top 3 anomalies in the provided Q3 revenue data.',
    context: 'The data covers 12 months across 5 product lines. Highlight outliers by percentage deviation.',
    expectations: 'Return a bullet list: anomaly description, affected line, % deviation. No prose.',
  });
  console.log(`\n  Rendered framework output (${result.text.length} chars):`);
  console.log(result.text.split('\n').map(l => `    ${l}`).join('\n'));
  console.log(`\n  Rendered sections: ${result.renderedSections.join(', ')}`);
}

// Custom framework built in-memory
const customFrameworkRegistry = new InMemoryFrameworkRegistry();
customFrameworkRegistry.register({
  key: 'qa',
  name: 'QA Framework',
  description: 'Question-and-answer structured prompt.',
  sections: [
    { key: 'question', label: 'Question', renderOrder: 0, required: true },
    { key: 'context', label: 'Context', renderOrder: 1, required: false },
    { key: 'format', label: 'Answer Format', renderOrder: 2, required: false },
  ],
  sectionSeparator: '\n\n',
});

const qaResult = renderFramework(customFrameworkRegistry.get('qa')!, {
  question: 'What is the capital of France?',
  format: 'Answer in one sentence.',
});
console.log(`\n  Custom QA framework:\n${qaResult.text.split('\n').map(l => `    ${l}`).join('\n')}`);

/* ── 8. Phase 2: Lint / Static Analysis ──────────────── */

header('8. Phase 2 — Lint & Static Analysis');

// lintPromptTemplate() runs 9 rule checks and returns typed PromptLintResult[].
// Rules cover: missing required variables, undefined variables, empty templates,
// excessive size, unresolved fragments, circular references, missing descriptions.
const variables = [
  { name: 'role', required: true },
  { name: 'task', required: true },
  { name: 'context', required: false },
];

// Case 1: all good
const cleanTemplate = 'You are a {{role}}. {{>safety_notice}}\n\nTask: {{task}}';
const cleanResults = lintPromptTemplate(
  resolveFragments(cleanTemplate, fragmentRegistry),
  variables,
  { role: 'analyst', task: 'analyse data' },
  { fragmentRegistry },
);
console.log(`  Clean template — lint errors: ${hasLintErrors(cleanResults)}, top severity: ${topLintSeverity(cleanResults) ?? 'none'}`);

// Case 2: missing required variable + unresolved fragment
const badTemplateLint = '{{>missing_fragment}}\n\nTask: {{task}}';
const lintResults = lintPromptTemplate(
  badTemplateLint,
  variables,
  { task: 'do something' }, // role is missing
  { fragmentRegistry, description: '' },
);
console.log(`\n  Problematic template — has errors: ${hasLintErrors(lintResults)}, top severity: "${topLintSeverity(lintResults)}"`);
console.log(`  Lint report:\n${formatLintResults(lintResults, 'my-prompt').split('\n').map(l => `    ${l}`).join('\n')}`);

/* ── 9. Phase 2: renderWithOptions() & Provider Adapters ─ */

header('9. Phase 2 — renderWithOptions() & Provider Adapters');

// renderWithOptions() is the unified Phase 2 entry point:
// it fragments-expands → (optionally) lints → variable-interpolates in one call.
const unifiedResult = renderWithOptions(
  'You are a {{role}}.\n\n{{>safety_notice}}\n\nTask: {{task}}',
  [
    { name: 'role', type: 'string', required: true },
    { name: 'task', type: 'string', required: true },
  ],
  { role: 'data analyst', task: 'explain the trend in Q3 revenue' },
  { fragmentRegistry, runLint: true },
);
console.log(`  renderWithOptions() output (${unifiedResult.text.length} chars):`);
console.log(unifiedResult.text.split('\n').map(l => `    ${l}`).join('\n'));
console.log(`  Lint results: ${unifiedResult.lintResults.length} issues (${topLintSeverity(unifiedResult.lintResults) ?? 'none'})`);

// Provider adapters convert rendered text to provider-native wire format.
// openAIAdapter() → { role: 'system' | 'user', content: string }[]
// anthropicAdapter() → { system: string | null, messages: [] } via adaptForAnthropic()
// textAdapter() → single plain string via toText()
const systemHint = 'You are a data analyst.';
const userText = 'Explain the Q3 revenue trend.';

const oaiAdapter = openAIAdapter();
const oaiMessages = oaiAdapter.adaptText(userText, systemHint);
console.log(`\n  OpenAI adapter messages:`);
for (const m of oaiMessages) console.log(`    [${m.role}] ${m.content}`);

const anthropicAdapterInst = anthropicAdapter();
const { system, messages } = anthropicAdapterInst.adaptForAnthropic(userText, systemHint);
console.log(`\n  Anthropic adapter — system: "${system?.slice(0, 40)}..."`);
console.log(`  Anthropic messages: ${messages.length} message(s)`);

const textAdapterInst = textAdapter();
const plainText = textAdapterInst.toText(userText, systemHint);
console.log(`\n  Text adapter — plain: "${plainText.slice(0, 60)}..."`);

// resolveAdapter() factory: pick adapter by provider name at runtime
const dynamicAdapter = resolveAdapter('openai');
const dynamicMsgs = dynamicAdapter.adaptText('Hello!', 'You are helpful.');
console.log(`\n  Dynamic adapter (openai) — ${dynamicMsgs.length} messages, first role: "${dynamicMsgs[0]?.role}"`);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Template creation with {{variable}} substitution and auto-detection');
console.log('✅ Prompt registry with versioning, categories, and tags');
console.log('✅ Instruction bundles for layered system prompts');
console.log('✅ A/B testing with weighted variant selection');
console.log('✅ Experiment-aware prompt resolution');
console.log('✅ Phase 2: Fragment registry with {{>key}} inclusion and circular detection');
console.log('✅ Phase 2: Framework registry with named ordered section structures');
console.log('✅ Phase 2: Lint with 9 rules, typed severity, and formatted reports');
console.log('✅ Phase 2: renderWithOptions() — unified fragment + lint + interpolation');
console.log('✅ Phase 2: Provider adapters — OpenAI, Anthropic, text, system-as-user');
}

main().catch(console.error);
