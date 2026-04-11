/**
 * Example 17 — Prompt Management & A/B Testing
 *
 * Demonstrates:
 *  • Versioned prompt templates with variable extraction
 *  • Prompt registry with tag-based lookup
 *  • A/B experiments with weighted selection
 *  • Instruction bundles for composing agent personas
 *  • Scoped prompt resolution (project, model, user)
 *  • Agent using managed prompts for a customer-support scenario
 *
 * No API keys needed — all in-memory.
 *
 * Run: npx tsx examples/17-prompt-management.ts
 */

import {
  createTemplate,
  extractVariables,
  InMemoryPromptRegistry,
  PromptResolver,
  InMemoryExperimentStore,
  weightedSelect,
  InstructionBundleBuilder,
  composeInstructions,
  createInstructionBundle,
} from '@weaveintel/prompts';

import { weaveContext } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

/* ── 1. Template Creation & Variable Extraction ───────── */

header('1. Prompt Templates');

const supportTemplateV1 = createTemplate({
  id: 'support-system',
  name: 'Customer Support System Prompt',
  version: '1.0',
  tags: ['support', 'production'],
  template: `You are {{agent_name}}, a customer support agent for {{company}}.
Your role: {{role_description}}

Guidelines:
- Always greet the customer by name: {{customer_name}}
- Reference their plan: {{plan_type}}
- Escalation threshold: {{max_attempts}} failed attempts
- Language: {{language}}`,
});

const supportTemplateV2 = createTemplate({
  id: 'support-system',
  name: 'Customer Support System Prompt v2',
  version: '2.0',
  tags: ['support', 'experiment'],
  template: `You are {{agent_name}}, a friendly and empathetic support agent for {{company}}.

Core directive: Resolve the customer's issue in the fewest messages possible.
Customer context: {{customer_name}} on the {{plan_type}} plan.

Tone: Warm, professional, solution-focused.
Escalate after {{max_attempts}} unsuccessful attempts.
Respond in: {{language}}.`,
});

// Extract variables from template
const vars = extractVariables(supportTemplateV1.template);
console.log('Template v1 variables:', vars);
console.log(`  → ${vars.length} variables found: ${vars.join(', ')}`);

/* ── 2. Prompt Registry ───────────────────────────────── */

header('2. Prompt Registry (Versioned)');

const registry = new InMemoryPromptRegistry();

// Register both versions
registry.register(supportTemplateV1);
registry.register(supportTemplateV2);

// Register additional templates
registry.register(createTemplate({
  id: 'rag-system',
  name: 'RAG System Prompt',
  version: '1.0',
  tags: ['rag', 'production'],
  template: `You answer questions using ONLY the provided context.
Context: {{context}}
If the answer is not in the context, say "I don't have that information."`,
}));

registry.register(createTemplate({
  id: 'code-review',
  name: 'Code Review Prompt',
  version: '1.0',
  tags: ['engineering', 'production'],
  template: `Review the following {{language}} code for {{focus_areas}}.
Severity levels: critical, warning, suggestion.

Code:
\`\`\`{{language}}
{{code}}
\`\`\``,
}));

// List all templates
console.log('All registered templates:');
for (const t of registry.list()) {
  console.log(`  📝 ${t.name} (v${t.version}) [${t.tags.join(', ')}]`);
}

// Lookup by tag
const productionTemplates = registry.findByTag('production');
console.log(`\nProduction templates: ${productionTemplates.length}`);
for (const t of productionTemplates) {
  console.log(`  📌 ${t.name} v${t.version}`);
}

/* ── 3. A/B Experiments ───────────────────────────────── */

header('3. A/B Prompt Experiments');

const experimentStore = new InMemoryExperimentStore();

// Create an experiment
experimentStore.create({
  id: 'support-prompt-test',
  name: 'Support Prompt: Formal vs Empathetic',
  variants: [
    { id: 'control', templateId: 'support-system', version: '1.0', weight: 50 },
    { id: 'treatment', templateId: 'support-system', version: '2.0', weight: 50 },
  ],
  status: 'active',
  metrics: ['resolution_time', 'csat_score', 'escalation_rate'],
});

const experiment = experimentStore.get('support-prompt-test');
console.log(`Experiment: ${experiment!.name}`);
console.log(`Status: ${experiment!.status}`);
console.log('Variants:');
for (const v of experiment!.variants) {
  console.log(`  🧪 ${v.id}: template=${v.templateId} v${v.version} (weight=${v.weight}%)`);
}

// Simulate weighted selection over many requests
const selections = { control: 0, treatment: 0 };
for (let i = 0; i < 1000; i++) {
  const variant = weightedSelect(experiment!.variants);
  selections[variant.id as keyof typeof selections]++;
}
console.log('\nDistribution over 1000 selections:');
console.log(`  Control:   ${selections.control} (${(selections.control / 10).toFixed(1)}%)`);
console.log(`  Treatment: ${selections.treatment} (${(selections.treatment / 10).toFixed(1)}%)`);

/* ── 4. Instruction Bundles ───────────────────────────── */

header('4. Instruction Bundles (Agent Persona Composition)');

const bundle = new InstructionBundleBuilder()
  .setId('enterprise-support-agent')
  .setName('Enterprise Support Agent')
  .addInstruction({
    id: 'base-persona',
    priority: 1,
    scope: 'global',
    content: 'You are a professional customer support agent. Be concise, accurate, and helpful.',
  })
  .addInstruction({
    id: 'tone-guide',
    priority: 2,
    scope: 'global',
    content: 'Use a warm, empathetic tone. Mirror the customer\'s energy level.',
  })
  .addInstruction({
    id: 'knowledge-boundaries',
    priority: 3,
    scope: 'global',
    content: 'Only answer questions about our products and services. For anything else, politely redirect.',
  })
  .addInstruction({
    id: 'enterprise-specifics',
    priority: 4,
    scope: 'project',
    content: 'Enterprise customers get priority escalation. Always check SLA status first.',
  })
  .addInstruction({
    id: 'compliance-notes',
    priority: 5,
    scope: 'project',
    content: 'Never share customer data across accounts. Verify identity before account changes.',
  })
  .build();

console.log(`Bundle: ${bundle.name} (${bundle.instructions.length} instructions)`);
for (const inst of bundle.instructions) {
  console.log(`  [${inst.scope}] P${inst.priority}: ${inst.content.slice(0, 70)}...`);
}

// Compose into a single system prompt
const composedPrompt = composeInstructions(bundle);
console.log('\nComposed system prompt:');
console.log('─'.repeat(50));
console.log(composedPrompt);
console.log('─'.repeat(50));

/* ── 5. Scoped Resolution ─────────────────────────────── */

header('5. Scoped Prompt Resolution');

const resolver = new PromptResolver(registry);

// Resolve with variable substitution
const resolved = resolver.resolve('support-system', '1.0', {
  agent_name: 'Alex',
  company: 'WeaveIntel',
  role_description: 'helping customers with API integration, billing, and account issues',
  customer_name: 'Sarah Chen',
  plan_type: 'Enterprise',
  max_attempts: '3',
  language: 'English',
});

console.log('Resolved system prompt:');
console.log('─'.repeat(50));
console.log(resolved);
console.log('─'.repeat(50));

/* ── 6. Agent Using Managed Prompts ───────────────────── */

header('6. Agent Using Managed Prompts');

const ctx = weaveContext({ userId: 'prompt-demo', timeout: 30_000 });

// Select variant for this "request"
const selectedVariant = weightedSelect(experiment!.variants);
const resolvedPrompt = resolver.resolve(
  selectedVariant.templateId,
  selectedVariant.version,
  {
    agent_name: 'Aria',
    company: 'WeaveIntel',
    role_description: 'resolving technical issues',
    customer_name: 'Marcus Lee',
    plan_type: 'Professional',
    max_attempts: '3',
    language: 'English',
  },
);

console.log(`Selected variant: ${selectedVariant.id} (v${selectedVariant.version})`);

const model = weaveFakeModel({
  responses: [
    `Hi Marcus! I'm Aria from WeaveIntel support. I can see you're on our Professional plan.

I'd be happy to help you with the API rate-limiting issue you're experiencing. Let me look into your account right away.

Based on your Professional plan, you have a limit of 10,000 requests/minute. I can see from your recent usage that you've been hitting ~12,000 requests/minute during peak hours.

**Here are your options:**

1. **Upgrade to Enterprise** — 100,000 req/min, priority support, dedicated endpoint
2. **Request a temporary limit increase** — I can approve a 48-hour bump to 15,000 req/min
3. **Implement request batching** — Our SDK supports batch mode which can reduce your call count by ~60%

Would you like me to proceed with any of these options? I'd recommend option 3 as a quick fix while we evaluate if an upgrade makes sense for your usage patterns.`,
  ],
});

const agent = weaveAgent({
  model,
  systemPrompt: resolvedPrompt,
  maxSteps: 2,
});

const result = await agent.run(
  { messages: [{ role: 'user', content: 'I keep getting rate-limited on the API. This is affecting our production service.' }] },
  ctx,
);

console.log(`\nAgent response (using ${selectedVariant.id} prompt):`);
console.log(result.content);

/* ── 7. Creating Instruction Bundle Inline ────────────── */

header('7. Quick Instruction Bundle');

const quickBundle = createInstructionBundle({
  id: 'code-assistant',
  name: 'Code Review Assistant',
  instructions: [
    { id: 'role', priority: 1, scope: 'global', content: 'You are a senior code reviewer.' },
    { id: 'focus', priority: 2, scope: 'project', content: 'Focus on security, performance, and readability.' },
    { id: 'format', priority: 3, scope: 'user', content: 'Output findings as a markdown table with severity, file, line, and suggestion.' },
  ],
});

const quickComposed = composeInstructions(quickBundle);
console.log(`Bundle "${quickBundle.name}" composed into ${quickComposed.length} chars`);
console.log(quickComposed);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Versioned prompt templates with {{variable}} extraction');
console.log('✅ In-memory prompt registry with tag-based lookup');
console.log('✅ A/B experiments with weighted variant selection');
console.log('✅ Instruction bundle builder for persona composition');
console.log('✅ Scoped prompt resolution with variable substitution');
console.log('✅ Agent using experiment-selected prompts');
console.log('✅ Full prompt management lifecycle demonstrated');
