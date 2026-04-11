/**
 * Example 14 — Smart Model Routing
 *
 * Demonstrates:
 *  • SmartModelRouter with multiple model candidates
 *  • Cost and quality scoring
 *  • Health tracking with latency and error metrics
 *  • Routing policies (cost-optimized, quality-optimized, balanced)
 *  • Decision store for audit trail
 *
 * No API keys needed — uses in-memory routing simulation.
 *
 * Run: npx tsx examples/14-smart-routing.ts
 */

import {
  SmartModelRouter,
  ModelHealthTracker,
  ModelScorer,
  InMemoryDecisionStore,
} from '@weaveintel/routing';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function main() {

/* ── 1. Set up model candidates ──────────────────────── */

header('1. Model Candidates & Cost/Quality Info');

const candidates = [
  { modelId: 'gpt-4o', providerId: 'openai', capabilities: ['chat', 'code', 'reasoning'] },
  { modelId: 'gpt-4o-mini', providerId: 'openai', capabilities: ['chat', 'code'] },
  { modelId: 'claude-sonnet-4-20250514', providerId: 'anthropic', capabilities: ['chat', 'code', 'reasoning'] },
  { modelId: 'gemini-pro', providerId: 'google', capabilities: ['chat'] },
];

const costs = [
  { modelId: 'gpt-4o', providerId: 'openai', inputCostPer1M: 2.50, outputCostPer1M: 10.00 },
  { modelId: 'gpt-4o-mini', providerId: 'openai', inputCostPer1M: 0.15, outputCostPer1M: 0.60 },
  { modelId: 'claude-sonnet-4-20250514', providerId: 'anthropic', inputCostPer1M: 3.00, outputCostPer1M: 15.00 },
  { modelId: 'gemini-pro', providerId: 'google', inputCostPer1M: 0.50, outputCostPer1M: 1.50 },
];

const qualities = [
  { modelId: 'gpt-4o', providerId: 'openai', qualityScore: 0.95 },
  { modelId: 'gpt-4o-mini', providerId: 'openai', qualityScore: 0.75 },
  { modelId: 'claude-sonnet-4-20250514', providerId: 'anthropic', qualityScore: 0.93 },
  { modelId: 'gemini-pro', providerId: 'google', qualityScore: 0.80 },
];

for (const c of candidates) {
  const cost = costs.find(x => x.modelId === c.modelId);
  const quality = qualities.find(x => x.modelId === c.modelId);
  console.log(`  ${c.modelId} (${c.providerId}) — quality: ${quality?.qualityScore}, input: $${cost?.inputCostPer1M}/1M, output: $${cost?.outputCostPer1M}/1M`);
}

/* ── 2. Health Tracking ───────────────────────────────── */

header('2. Health Tracking');

const healthTracker = new ModelHealthTracker({ windowSize: 100 });

// Simulate historical health data
const healthData = [
  { modelId: 'gpt-4o', providerId: 'openai', successes: 95, failures: 5, avgLatency: 800 },
  { modelId: 'gpt-4o-mini', providerId: 'openai', successes: 99, failures: 1, avgLatency: 200 },
  { modelId: 'claude-sonnet-4-20250514', providerId: 'anthropic', successes: 90, failures: 10, avgLatency: 1200 },
  { modelId: 'gemini-pro', providerId: 'google', successes: 85, failures: 15, avgLatency: 600 },
];

for (const h of healthData) {
  for (let i = 0; i < h.successes; i++) {
    healthTracker.record(h.modelId, h.providerId, { latencyMs: h.avgLatency + Math.random() * 200 - 100, success: true });
  }
  for (let i = 0; i < h.failures; i++) {
    healthTracker.record(h.modelId, h.providerId, { latencyMs: h.avgLatency * 3, success: false });
  }
}

const allHealth = healthTracker.listHealth();
for (const h of allHealth) {
  const successRate = ((1 - h.errorRate) * 100).toFixed(0);
  console.log(`  ${h.modelId} (${h.providerId}): success=${successRate}%, avg latency=${h.avgLatencyMs}ms, available=${h.available}`);
}

/* ── 3. Smart Routing with Different Policies ─────────── */

header('3. Smart Routing — Policy Comparison');

const decisionStore = new InMemoryDecisionStore();

const router = new SmartModelRouter({
  candidates,
  costs,
  qualities,
  decisionStore,
});

const policies = [
  {
    id: 'cost-opt', name: 'Cost Optimized', strategy: 'cost-optimized' as const, enabled: true,
    weights: { cost: 0.7, latency: 0.1, quality: 0.1, reliability: 0.1 },
  },
  {
    id: 'quality-first', name: 'Quality First', strategy: 'quality-optimized' as const, enabled: true,
    weights: { cost: 0.1, latency: 0.1, quality: 0.7, reliability: 0.1 },
  },
  {
    id: 'balanced', name: 'Balanced', strategy: 'balanced' as const, enabled: true,
    weights: { cost: 0.25, latency: 0.25, quality: 0.25, reliability: 0.25 },
  },
];

for (const policy of policies) {
  const decision = await router.route(
    { prompt: 'Explain quantum computing in detail', context: { taskType: 'reasoning' } },
    policy,
  );
  const key = `${decision.providerId}:${decision.modelId}`;
  const score = decision.scores[key] ?? 0;
  console.log(`  [${policy.name}] → ${decision.modelId} (${decision.providerId}), score: ${score.toFixed(3)}`);
  if (decision.alternatives.length > 0) {
    console.log(`    Alternatives: ${decision.alternatives.map(a => `${a.modelId}(${a.score.toFixed(3)})`).join(', ')}`);
  }
}

/* ── 4. Routing with Constraints ──────────────────────── */

header('4. Routing with Constraints');

// Route with capability requirement
const codeDecision = await router.route(
  { prompt: 'Debug this Python script' },
  {
    id: 'code-quality', name: 'Code Quality', strategy: 'quality-optimized', enabled: true,
    weights: { quality: 0.8, cost: 0.1, latency: 0.1 },
    constraints: { requiredCapabilities: ['code'] },
  },
);
console.log(`  Capability constraint (code) → ${codeDecision.modelId} (${codeDecision.providerId})`);

// Route with cost limit
const cheapDecision = await router.route(
  { prompt: 'Simple greeting' },
  {
    id: 'cheap', name: 'Budget', strategy: 'cost-optimized', enabled: true,
    weights: { cost: 0.9, latency: 0.05, quality: 0.05 },
  },
);
console.log(`  Cost-optimized → ${cheapDecision.modelId} (${cheapDecision.providerId})`);

/* ── 5. Record Outcomes for Learning ──────────────────── */

header('5. Decision Store — Audit Trail');

// Record outcomes for the decisions
await router.recordOutcome(codeDecision, { latencyMs: 450, success: true, cost: 0.003 });
await router.recordOutcome(cheapDecision, { latencyMs: 180, success: true, cost: 0.001 });

const decisions = await decisionStore.list({ limit: 10 });
console.log(`  Total routing decisions recorded: ${decisions.length}`);
for (const d of decisions.slice(0, 5)) {
  const key = `${d.providerId}:${d.modelId}`;
  console.log(`    ${d.modelId} (${d.providerId}) — score: ${(d.scores[key] ?? 0).toFixed(3)}, reason: ${d.reason.slice(0, 60)}`);
}

/* ── 6. Model Scoring ─────────────────────────────────── */

header('6. Model Scoring — Side-by-Side Comparison');

const scorer = new ModelScorer();
const scores = scorer.score(
  candidates,
  allHealth,
  costs,
  qualities,
  { id: 'compare', name: 'Compare', strategy: 'balanced', enabled: true },
);

for (const s of scores) {
  console.log(`  ${s.modelId} (${s.providerId}): overall=${s.overallScore.toFixed(3)}, cost=${s.costScore.toFixed(2)}, latency=${s.latencyScore.toFixed(2)}, quality=${s.qualityScore.toFixed(2)}, reliability=${s.reliabilityScore.toFixed(2)}`);
}

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Model candidates with cost and quality metadata');
console.log('✅ Health tracking with latency and error rates');
console.log('✅ Smart routing with cost-optimized, quality-first, and balanced policies');
console.log('✅ Routing with capability constraints');
console.log('✅ Decision store for audit trail');
console.log('✅ Model scoring for side-by-side comparison');
}

main().catch(console.error);

