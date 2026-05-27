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
 * WeaveIntel packages used:
 *   @weaveintel/routing — Intelligent model selection layer:
 *     • SmartModelRouter       — Picks the best model for a request based on a weighted
 *                                scoring algorithm (cost, quality, latency, reliability)
 *     • ModelHealthTracker     — Tracks per-model success/error rates and latency stats
 *     • ModelScorer            — Computes normalized scores for side-by-side comparison
 *     • InMemoryDecisionStore  — Logs every routing decision for auditing and learning
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
  DEFAULT_MODEL_PRICING,
  DEFAULT_ROUTING_POLICIES,
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

// Pull a representative subset from DEFAULT_MODEL_PRICING — the same values
// the DB seed inserts into model_pricing. Keeps example IDs and costs in sync.
const DEMO_MODELS = ['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-6', 'gemini-2.5-flash'];
const pricingSubset = DEFAULT_MODEL_PRICING.filter(p => DEMO_MODELS.includes(p.model_id));

const CAPABILITY_MAP: Record<string, string[]> = {
  openai:    ['chat', 'code', 'reasoning'],
  anthropic: ['chat', 'code', 'reasoning'],
  google:    ['chat', 'vision'],
};

const candidates = pricingSubset.map(p => ({
  modelId: p.model_id,
  providerId: p.provider,
  capabilities: CAPABILITY_MAP[p.provider] ?? ['chat'],
}));

const costs = pricingSubset.map(p => ({
  modelId: p.model_id,
  providerId: p.provider,
  inputCostPer1M: p.input_cost_per_1m,
  outputCostPer1M: p.output_cost_per_1m,
}));

const qualities = pricingSubset.map(p => ({
  modelId: p.model_id,
  providerId: p.provider,
  qualityScore: p.quality_score,
}));

for (const c of candidates) {
  const cost = costs.find(x => x.modelId === c.modelId);
  const quality = qualities.find(x => x.modelId === c.modelId);
  console.log(`  ${c.modelId} (${c.providerId}) — quality: ${quality?.qualityScore}, input: $${cost?.inputCostPer1M}/1M, output: $${cost?.outputCostPer1M}/1M`);
}

/* ── 2. Health Tracking ───────────────────────────────── */

header('2. Health Tracking');

// ModelHealthTracker accumulates per-model success/failure counts and
// latency statistics in a sliding window. .listHealth() returns all models
// with their error rate, average latency, and availability flag.
const healthTracker = new ModelHealthTracker({ windowSize: 100 });

// Simulate historical health data — model IDs match the seed / candidates above
const healthData = [
  { modelId: 'gpt-4o',           providerId: 'openai',    successes: 95, failures: 5,  avgLatency: 800 },
  { modelId: 'gpt-4o-mini',      providerId: 'openai',    successes: 99, failures: 1,  avgLatency: 200 },
  { modelId: 'claude-sonnet-4-6', providerId: 'anthropic', successes: 90, failures: 10, avgLatency: 1200 },
  { modelId: 'gemini-2.5-flash', providerId: 'google',    successes: 85, failures: 15, avgLatency: 600 },
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

// InMemoryDecisionStore logs every routing decision (model chosen, scores,
// alternatives, reason) for post-hoc analysis and learning.
const decisionStore = new InMemoryDecisionStore();

// SmartModelRouter combines candidates, cost data, quality scores, and health
// stats to pick the best model for a given request. Each routing call takes
// a policy that defines the strategy (cost-optimized, quality-optimized,
// balanced) and the weight of each scoring dimension.
const router = new SmartModelRouter({
  candidates,
  costs,
  qualities,
  decisionStore,
});

// Map DEFAULT_ROUTING_POLICIES (DB seed shape) to the SmartModelRouter runtime shape.
// strategy: seed uses 'cost' | 'quality' | 'balanced'; router expects 'cost-optimized' | 'quality-optimized' | 'balanced'.
const STRATEGY_MAP: Record<string, 'cost-optimized' | 'quality-optimized' | 'balanced'> = {
  cost: 'cost-optimized',
  quality: 'quality-optimized',
  balanced: 'balanced',
};

const policies = DEFAULT_ROUTING_POLICIES.map(p => ({
  id: p.id,
  name: p.name,
  strategy: STRATEGY_MAP[p.strategy] ?? 'balanced',
  enabled: p.enabled === 1,
  weights: { reliability: 0.05, ...JSON.parse(p.weights) },
}));

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

