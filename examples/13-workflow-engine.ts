/**
 * Example 13 — Workflow Engine with Guardrails
 *
 * Demonstrates:
 *  • Defining a multi-step workflow with conditional branching
 *  • Step execution with handler maps
 *  • Compensation (rollback) when a step fails
 *  • Checkpoint/resume for durability
 *  • Guardrail pipeline with risk classification and cost guards
 *  • Governance context with runtime policy evaluation
 *
 * No API keys needed — uses deterministic in-memory primitives.
 *
 * Run: npx tsx examples/13-workflow-engine.ts
 */

import {
  type WorkflowDefinition,
  type WorkflowStep,
  defineWorkflow,
  createWorkflowEngine,
  executeStep,
  InMemoryCheckpointStore,
  DefaultCompensationRegistry,
  InMemoryScheduler,
} from '@weaveintel/workflows';

import {
  createGuardrailPipeline,
  createRiskClassifier,
  createCostGuard,
  createGovernanceContext,
  evaluateRuntimePolicies,
  hasDeny,
  getDenyReason,
} from '@weaveintel/guardrails';

import { weaveContext, weaveEventBus } from '@weaveintel/core';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

/* ── 1. Define a multi-step content-publishing workflow ── */

header('1. Define Workflow — Content Publication Pipeline');

const steps: WorkflowStep[] = [
  {
    id: 'draft',
    name: 'Create Draft',
    type: 'action',
    handler: 'createDraft',
    next: 'review',
  },
  {
    id: 'review',
    name: 'Editorial Review',
    type: 'action',
    handler: 'editorialReview',
    next: 'gate',
  },
  {
    id: 'gate',
    name: 'Quality Gate',
    type: 'condition',
    handler: 'qualityGate',
    branches: {
      pass: 'publish',
      fail: 'revise',
    },
  },
  {
    id: 'revise',
    name: 'Revise Content',
    type: 'action',
    handler: 'reviseContent',
    next: 'review',     // loops back
  },
  {
    id: 'publish',
    name: 'Publish Content',
    type: 'action',
    handler: 'publishContent',
    next: 'notify',
  },
  {
    id: 'notify',
    name: 'Send Notifications',
    type: 'action',
    handler: 'sendNotifications',
    next: null,           // terminal
  },
];

const workflow = defineWorkflow({
  id: 'content-publish',
  name: 'Content Publication Pipeline',
  version: '1.0.0',
  entryStepId: 'draft',
  steps,
});

console.log(`Workflow "${workflow.name}" v${workflow.version}`);
console.log(`Steps: ${workflow.steps.map(s => s.name).join(' → ')}`);

/* ── 2. Step handlers — simulate real work ────────────── */

header('2. Execute Workflow Steps');

const ctx = weaveContext({ userId: 'editor-1', timeout: 30_000 });
const bus = weaveEventBus();

// Track events
const events: string[] = [];
bus.subscribe('*', (e) => events.push(`[${e.type}] ${JSON.stringify(e.payload).slice(0, 80)}`));

// Handlers simulate content operations
const handlers: Record<string, (input: Record<string, unknown>) => Promise<Record<string, unknown>>> = {
  async createDraft(input) {
    console.log('  📝 Creating draft for:', input['topic'] || 'AI in Healthcare');
    return { draft: 'Draft content about AI in healthcare...', wordCount: 1200, topic: input['topic'] || 'AI in Healthcare' };
  },
  async editorialReview(input) {
    const wc = (input['wordCount'] as number) || 0;
    const score = wc > 500 ? 0.85 : 0.4;
    console.log(`  🔍 Editorial review — score: ${(score * 100).toFixed(0)}%, word count: ${wc}`);
    return { ...input, reviewScore: score, reviewNotes: score > 0.7 ? 'Approved' : 'Needs revision' };
  },
  async qualityGate(input) {
    const score = (input['reviewScore'] as number) || 0;
    const decision = score >= 0.7 ? 'pass' : 'fail';
    console.log(`  🚦 Quality gate: ${decision} (score ${(score * 100).toFixed(0)}%)`);
    return { ...input, gateDecision: decision };
  },
  async reviseContent(input) {
    console.log('  ✏️  Revising based on feedback:', input['reviewNotes']);
    return { ...input, wordCount: ((input['wordCount'] as number) || 0) + 300, revised: true };
  },
  async publishContent(input) {
    const id = `pub-${Date.now()}`;
    console.log(`  🚀 Published as ${id}: "${input['topic']}"`);
    return { ...input, publishedId: id, publishedAt: new Date().toISOString() };
  },
  async sendNotifications(input) {
    console.log(`  📨 Notifications sent for ${input['publishedId']}`);
    return { ...input, notified: true };
  },
};

// Execute a few steps manually to show the flow
let state: Record<string, unknown> = { topic: 'AI in Healthcare' };

for (const stepId of ['draft', 'review', 'gate', 'publish', 'notify']) {
  const step = workflow.steps.find(s => s.id === stepId);
  if (!step) break;
  const result = await executeStep(step, state, { handlers: handlers as any });
  state = { ...state, ...result };
  if (stepId === 'gate' && state['gateDecision'] === 'fail') {
    console.log('  ↩️  Looping back to revision...');
    break;
  }
}

/* ── 3. Checkpoint & Resume ───────────────────────────── */

header('3. Checkpoint & Resume');

const checkpointStore = new InMemoryCheckpointStore();

// Save checkpoint
const cpId = `cp-${Date.now()}`;
await checkpointStore.save({
  id: cpId,
  workflowId: workflow.id,
  stepId: 'publish',
  state,
  createdAt: new Date().toISOString(),
});
console.log(`Checkpoint saved: ${cpId}`);

// Load checkpoint
const loaded = await checkpointStore.load(cpId);
console.log(`Checkpoint loaded: step=${loaded?.stepId}, state keys: ${Object.keys(loaded?.state || {}).join(', ')}`);

/* ── 4. Compensation (Rollback) ───────────────────────── */

header('4. Compensation — Rollback on Failure');

const compensations = new DefaultCompensationRegistry();

compensations.register('publishContent', async (input) => {
  console.log(`  🔄 Rollback: Unpublishing ${input['publishedId']}`);
  return { ...input, unpublished: true };
});

compensations.register('sendNotifications', async (input) => {
  console.log(`  🔄 Rollback: Retracting notification for ${input['publishedId']}`);
  return { ...input, retracted: true };
});

// Simulate running compensations for the last two steps
const compensated = await compensations.run('sendNotifications', state);
const compensated2 = await compensations.run('publishContent', { ...state, ...compensated });
console.log(`Rollback complete: unpublished=${compensated2['unpublished']}, retracted=${compensated['retracted']}`);

/* ── 5. Guardrail Pipeline ────────────────────────────── */

header('5. Guardrail Pipeline — Risk Classification');

const riskClassifier = createRiskClassifier({
  rules: [
    { pattern: /delete|drop|truncate/i, risk: 'high', reason: 'Destructive operation detected' },
    { pattern: /publish|deploy/i, risk: 'medium', reason: 'Publication action' },
    { pattern: /read|list|get/i, risk: 'low', reason: 'Read-only operation' },
  ],
});

const testActions = [
  'Read user profile data',
  'Publish article to production',
  'Delete all user records from database',
  'List recent chat messages',
];

for (const action of testActions) {
  const classification = riskClassifier.classify(action);
  const emoji = classification.risk === 'high' ? '🔴' : classification.risk === 'medium' ? '🟡' : '🟢';
  console.log(`  ${emoji} "${action}" → ${classification.risk}: ${classification.reason}`);
}

/* ── 6. Cost Guard ────────────────────────────────────── */

header('6. Cost Guard — Budget Enforcement');

const costGuard = createCostGuard({
  maxCostPerRequest: 0.50,
  maxCostPerMinute: 2.00,
  maxTokensPerRequest: 10_000,
  alertThreshold: 0.8,
});

const requests = [
  { tokens: 2000, cost: 0.10, label: 'Short summary' },
  { tokens: 8000, cost: 0.40, label: 'Detailed analysis' },
  { tokens: 15000, cost: 0.75, label: 'Full document generation' },
  { tokens: 3000, cost: 0.15, label: 'Quick Q&A' },
];

for (const req of requests) {
  const check = costGuard.check({ tokens: req.tokens, estimatedCost: req.cost });
  const status = check.allowed ? '✅' : '🚫';
  console.log(`  ${status} ${req.label} (${req.tokens} tokens, $${req.cost.toFixed(2)})${check.warning ? ' ⚠️ ' + check.warning : ''}${!check.allowed ? ' — BLOCKED: ' + check.reason : ''}`);
  if (check.allowed) costGuard.record({ tokens: req.tokens, cost: req.cost });
}

/* ── 7. Governance Context ────────────────────────────── */

header('7. Governance — Runtime Policy Evaluation');

const governance = createGovernanceContext({
  policies: [
    {
      id: 'no-pii-in-logs',
      name: 'No PII in Logs',
      check: (ctx) => {
        const hasPII = /\b\d{3}-\d{2}-\d{4}\b/.test(String(ctx['content'] || ''));
        return { allowed: !hasPII, reason: hasPII ? 'SSN pattern detected in content' : undefined };
      },
    },
    {
      id: 'max-output-length',
      name: 'Max Output Length',
      check: (ctx) => {
        const len = String(ctx['content'] || '').length;
        return { allowed: len < 5000, reason: len >= 5000 ? `Output too long: ${len} chars` : undefined };
      },
    },
    {
      id: 'approved-models-only',
      name: 'Approved Models Only',
      check: (ctx) => {
        const approved = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-20250514'];
        const model = String(ctx['model'] || '');
        return { allowed: approved.includes(model), reason: !approved.includes(model) ? `Model "${model}" not approved` : undefined };
      },
    },
  ],
});

const policyTests = [
  { content: 'User profile for John, SSN 123-45-6789', model: 'gpt-4o' },
  { content: 'Summary of Q3 results', model: 'gpt-4o' },
  { content: 'Quick answer', model: 'llama-3-70b' },
];

for (const test of policyTests) {
  const results = evaluateRuntimePolicies(governance, test);
  const denied = results.filter(r => !r.allowed);
  if (denied.length) {
    console.log(`  🚫 "${test.content.slice(0, 40)}..." — DENIED:`);
    denied.forEach(d => console.log(`      • ${d.policyId}: ${d.reason}`));
  } else {
    console.log(`  ✅ "${test.content.slice(0, 40)}..." — all policies passed`);
  }
}

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Workflow definition with conditional branching');
console.log('✅ Step execution with handler dispatch');
console.log('✅ Checkpoint save/load for durability');
console.log('✅ Compensation registry for rollback');
console.log('✅ Risk classification (low/medium/high)');
console.log('✅ Cost guard with budget enforcement');
console.log('✅ Governance context with 3 runtime policies');
console.log(`\nEvents captured: ${events.length}`);
