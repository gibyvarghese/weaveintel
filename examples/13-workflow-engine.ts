/**
 * Example 13 — Workflow Engine with Guardrails
 *
 * Demonstrates:
 *  • Defining a multi-step workflow with the fluent WorkflowBuilder
 *  • Running workflows with the DefaultWorkflowEngine
 *  • Checkpoint/resume for durability
 *  • Compensation (rollback) when a step fails
 *  • Guardrail pipeline with risk classification and cost guards
 *  • Governance context with runtime policy evaluation
 *
 * WeaveIntel packages used:
 *   @weaveintel/workflows  — Declarative workflow definition & execution:
 *     • defineWorkflow()             — Fluent builder API to define steps, conditions, and transitions
 *     • createWorkflowEngine()       — Engine that executes steps, calls handlers, and manages state
 *     • InMemoryCheckpointStore      — Persists workflow state for crash recovery / resume
 *     • DefaultCompensationRegistry  — Registers rollback functions for each step
 *     • runCompensations()           — Executes rollbacks in reverse order on failure
 *   @weaveintel/guardrails — Safety and governance layer:
 *     • createRiskClassifier()       — Pattern-based risk level assignment (low/medium/critical)
 *     • createCostGuard()            — Enforces token/cost/rate budgets before each request
 *     • createGovernanceContext()    — Tenant/user-scoped policy rules (deny/warn/allow)
 *     • evaluateRuntimePolicies()    — Checks cost/token/rate policies against current usage
 *   @weaveintel/core       — ExecutionContext and EventBus
 *
 * No API keys needed — uses deterministic in-memory primitives.
 *
 * Run: npx tsx examples/13-workflow-engine.ts
 */

import {
  defineWorkflow,
  createWorkflowEngine,
  InMemoryCheckpointStore,
  DefaultCompensationRegistry,
  runCompensations,
} from '@weaveintel/workflows';

import {
  evaluateGuardrail,
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

async function main() {

/* ── 1. Define a multi-step content-publishing workflow ── */

header('1. Define Workflow — Content Publication Pipeline');

// defineWorkflow() returns a fluent WorkflowBuilder.
// .deterministic() adds a step that always runs its handler and goes to `next`.
// .condition() adds a branching step (trueBranch / falseBranch based on handler return).
// .build() finalizes the definition into an immutable WorkflowDefinition object.
const definition = defineWorkflow('Content Publication Pipeline')
  .deterministic('draft', 'Create Draft', { handler: 'createDraft', next: 'review' })
  .deterministic('review', 'Editorial Review', { handler: 'editorialReview', next: 'gate' })
  .condition('gate', 'Quality Gate', {
    handler: 'qualityGate',
    trueBranch: 'publish',
    falseBranch: 'revise',
  })
  .deterministic('revise', 'Revise Content', { handler: 'reviseContent', next: 'review' })
  .deterministic('publish', 'Publish Content', { handler: 'publishContent', next: 'notify' })
  .deterministic('notify', 'Send Notifications', { handler: 'sendNotifications' })
  .build();

console.log(`Workflow "${definition.name}"`);
console.log(`Steps: ${definition.steps.map(s => s.name).join(' → ')}`);

/* ── 2. Run the workflow with DefaultWorkflowEngine ───── */

header('2. Execute Workflow with Engine');

const bus = weaveEventBus();

// Track events
const events: string[] = [];
bus.onAll((e) => events.push(`[${e.type}]`));

// createWorkflowEngine() creates the execution runtime. It:
//   1. Accepts a checkpoint store (for durability) and an event bus (for observability)
//   2. Lets you register handler functions by name (matching step handler IDs)
//   3. Runs workflows step-by-step, checkpointing after each step completes
const checkpointStore = new InMemoryCheckpointStore();
const engine = createWorkflowEngine({ checkpointStore, bus });

// Register step handlers
engine.registerHandler('createDraft', async (variables) => {
  const topic = variables['topic'] || 'AI in Healthcare';
  console.log('  Creating draft for:', topic);
  return { draft: `Draft about ${topic}...`, wordCount: 1200, topic };
});

engine.registerHandler('editorialReview', async (variables) => {
  console.log('  Editorial review — score: 85%, approved');
  return { reviewScore: 0.85, reviewNotes: 'Approved' };
});

engine.registerHandler('qualityGate', async (_variables) => {
  console.log('  Quality gate: PASS');
  return true;
});

engine.registerHandler('reviseContent', async (variables) => {
  console.log('  Revising based on feedback:', variables['reviewNotes']);
  return { wordCount: ((variables['wordCount'] as number) || 0) + 300, revised: true };
});

engine.registerHandler('publishContent', async (variables) => {
  const id = `pub-${Date.now()}`;
  console.log(`  Published as ${id}: "${variables['topic']}"`);
  return { publishedId: id, publishedAt: new Date().toISOString() };
});

engine.registerHandler('sendNotifications', async (variables) => {
  console.log(`  Notifications sent for ${variables['publishedId']}`);
  return { notified: true };
});

// Create and start workflow
await engine.createDefinition(definition);
const run = await engine.startRun(definition.id, { topic: 'AI in Healthcare' });
console.log(`\nWorkflow run: ${run.id}, status: ${run.status}`);

/* ── 3. Checkpoint & Resume ───────────────────────────── */

header('3. Checkpoint & Resume');

// Checkpoint store already used by engine; let's also demo manual save/load
const manualCpRunId = 'manual-run-1';
const testState = { currentStepId: 'publish', variables: { topic: 'AI' }, history: [], checkpointId: undefined };
await checkpointStore.save(manualCpRunId, 'publish', testState);
console.log(`Checkpoint saved for run: ${manualCpRunId}`);

const loaded = await checkpointStore.load(manualCpRunId, 'publish');
console.log(`Checkpoint loaded: step=publish, variables: ${JSON.stringify(loaded?.variables || {})}`);

/* ── 4. Compensation (Rollback) ───────────────────────── */

header('4. Compensation — Rollback on Failure');

// DefaultCompensationRegistry stores rollback functions keyed by stepId.
// When a workflow fails, runCompensations() walks the completed steps in
// reverse order and calls each registered compensation handler — similar
// to the Saga pattern in distributed systems.
const compensations = new DefaultCompensationRegistry();

compensations.register(
  { stepId: 'publish', handlerName: 'publishContent', description: 'Unpublish content' },
  async (stepId, _result, variables) => {
    console.log(`  Rollback: Unpublishing content from step ${stepId}`);
  },
);

compensations.register(
  { stepId: 'notify', handlerName: 'sendNotifications', description: 'Retract notifications' },
  async (stepId, _result, variables) => {
    console.log(`  Rollback: Retracting notifications from step ${stepId}`);
  },
);

// Simulate running compensations for completed steps
const completedSteps = [
  { stepId: 'publish', status: 'completed' as const, output: { publishedId: 'pub-123' }, startedAt: Date.now(), completedAt: Date.now() },
  { stepId: 'notify', status: 'completed' as const, output: { notified: true }, startedAt: Date.now(), completedAt: Date.now() },
];
const compResult = await runCompensations(compensations, completedSteps, { topic: 'AI' });
console.log(`Compensated ${compResult.compensated.length} steps, errors: ${compResult.errors.length}`);

/* ── 5. Guardrail Pipeline ────────────────────────────── */

header('5. Guardrail Pipeline — Risk Classification');

// createRiskClassifier() builds a pattern-matching engine that scans text
// for keywords and assigns a risk level (low/medium/critical). Used to
// gate dangerous actions before they reach the LLM or workflow engine.
const riskClassifier = createRiskClassifier([
  { pattern: 'delete|drop|truncate', level: 'critical', explanation: 'Destructive operation detected' },
  { pattern: 'publish|deploy', level: 'medium', explanation: 'Publication action' },
  { pattern: 'read|list|get', level: 'low', explanation: 'Read-only operation' },
]);

const testActions = [
  'Read user profile data',
  'Publish article to production',
  'Delete all user records from database',
  'List recent chat messages',
];

for (const action of testActions) {
  const classification = await riskClassifier.classify(action);
  const emoji = classification.level === 'critical' ? '🔴' : classification.level === 'medium' ? '🟡' : '🟢';
  console.log(`  ${emoji} "${action}" → ${classification.level}: ${classification.explanation}`);
}

/* ── 6. Cost Guard ────────────────────────────────────── */

header('6. Cost Guard — Budget Enforcement');

// createCostGuard() enforces three budget dimensions:
//   • maxTokensTotal        — hard cap on cumulative token usage
//   • maxCostUsd            — hard cap on cumulative dollar spend
//   • maxRequestsPerMinute  — rate limit within a sliding window
// .check() returns an array of guardrail results; .record() tracks usage.
const costGuard = createCostGuard({
  maxTokensTotal: 30_000,
  maxCostUsd: 1.00,
  maxRequestsPerMinute: 10,
});

const requests = [
  { tokens: 2000, cost: 0.10, label: 'Short summary' },
  { tokens: 8000, cost: 0.40, label: 'Detailed analysis' },
  { tokens: 15000, cost: 0.45, label: 'Full document generation' },
  { tokens: 3000, cost: 0.15, label: 'Quick Q&A' },
];

for (const req of requests) {
  const results = costGuard.check(req.tokens);
  const denied = results.some(r => r.decision === 'deny');
  const status = denied ? '🚫' : '✅';
  const reason = results.find(r => r.decision === 'deny')?.explanation ?? '';
  console.log(`  ${status} ${req.label} (${req.tokens} tokens, $${req.cost.toFixed(2)})${denied ? ' — BLOCKED: ' + reason : ''}`);
  if (!denied) costGuard.record(req.tokens, req.cost);
}

/* ── 7. Governance Context ────────────────────────────── */

header('7. Governance — Runtime Policy Evaluation');

// createGovernanceContext() creates a tenant/user/agent-scoped policy engine.
// Each rule has: id, name, condition (human-readable), action (deny/warn/allow),
// and priority. .evaluate() runs all enabled rules and returns results.
const governance = createGovernanceContext({
  tenantId: 'tenant-1',
  userId: 'user-1',
  agentId: 'content-agent',
  rules: [
    {
      id: 'no-pii',
      name: 'No PII in Logs',
      condition: 'content must not contain SSN patterns',
      action: 'deny' as const,
      enabled: true,
      priority: 1,
    },
    {
      id: 'max-length',
      name: 'Max Output Length',
      condition: 'output length must be under 5000',
      action: 'warn' as const,
      enabled: true,
      priority: 2,
    },
  ],
});

// Evaluate governance rules
const govResults = await governance.evaluate({ content: 'Summary of Q3 results', model: 'gpt-4o' });
console.log(`Governance evaluation: ${govResults.length} results`);
for (const r of govResults) {
  const emoji = r.decision === 'deny' ? '🚫' : r.decision === 'warn' ? '⚠️' : '✅';
  console.log(`  ${emoji} ${r.guardrailId}: ${r.decision}${r.explanation ? ' — ' + r.explanation : ''}`);
}

// Runtime policy evaluation
const policies = [
  {
    id: 'cost-limit',
    name: 'Cost Ceiling',
    type: 'cost-ceiling' as const,
    config: { maxCostUsd: 5.0 },
    enabled: true,
  },
  {
    id: 'token-limit',
    name: 'Token Limit',
    type: 'token-limit' as const,
    config: { maxTokens: 50000 },
    enabled: true,
  },
  {
    id: 'rate-limit',
    name: 'Rate Limit',
    type: 'rate-limit' as const,
    config: { maxRequestsPerMinute: 20 },
    enabled: true,
  },
];

const policyResults = evaluateRuntimePolicies(policies, {
  tokensUsed: 45000,
  costUsd: 3.50,
  requestsInWindow: 15,
});

console.log('\nRuntime policy evaluation:');
for (const r of policyResults) {
  const emoji = r.decision === 'deny' ? '🚫' : r.decision === 'warn' ? '⚠️' : '✅';
  console.log(`  ${emoji} ${r.guardrailId}: ${r.decision}${r.explanation ? ' — ' + r.explanation : ''}`);
}

/* ── 8. Guardrail Pipeline Demo ───────────────────────── */

header('8. Guardrail Pipeline — Content Filtering');

const pipeline = createGuardrailPipeline(
  [
    {
      id: 'blocklist',
      name: 'Blocked Words',
      type: 'blocklist',
      stage: 'pre-execution',
      enabled: true,
      config: { words: ['hack', 'exploit', 'bypass'], action: 'deny' },
    },
    {
      id: 'length-check',
      name: 'Max Length',
      type: 'length',
      stage: 'pre-execution',
      enabled: true,
      config: { maxLength: 200, action: 'warn' },
    },
    {
      id: 'pattern-check',
      name: 'PII Pattern',
      type: 'regex',
      stage: 'pre-execution',
      enabled: true,
      config: { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'deny' },
    },
  ],
  { shortCircuitOnDeny: true },
);

const testInputs = [
  'Summarize this article about AI safety',
  'Tell me how to hack a server',
  'My SSN is 123-45-6789',
  'A'.repeat(250),
];

for (const input of testInputs) {
  const results = await pipeline.evaluate(input, 'pre-execution');
  const denied = hasDeny(results);
  const reason = getDenyReason(results);
  const label = input.length > 50 ? input.slice(0, 50) + '...' : input;
  console.log(`  ${denied ? '🚫' : '✅'} "${label}"${denied ? ' — ' + reason : ''}`);
}

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Workflow definition with fluent WorkflowBuilder');
console.log('✅ Engine-driven execution with step handlers');
console.log('✅ Checkpoint save/load for durability');
console.log('✅ Compensation registry for rollback');
console.log('✅ Risk classification (low/medium/critical)');
console.log('✅ Cost guard with budget enforcement');
console.log('✅ Governance context with rule evaluation');
console.log('✅ Guardrail pipeline with blocklist, length, and regex checks');
console.log('✅ Runtime policy evaluation');
console.log(`\nEvents captured: ${events.length}`);
}

main().catch(console.error);
