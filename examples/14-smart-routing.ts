/**
 * Example 14 — Smart Model Routing
 *
 * Demonstrates:
 *  • SmartModelRouter with multiple model candidates
 *  • Health tracking — mark models up/down, latency tracking
 *  • Capability-based filtering (chat, streaming, tool_calling, vision)
 *  • Weighted scoring (cost vs quality vs latency)
 *  • Fallback chain selection when primary model is unhealthy
 *  • Explainable routing decisions stored in decision log
 *
 * No API keys needed — uses in-memory scoring and routing.
 *
 * Run: npx tsx examples/14-smart-routing.ts
 */

import {
  SmartModelRouter,
  ModelHealthTracker,
  ModelScorer,
  filterByConstraints,
  roundRobinSelect,
  fallbackCandidate,
  InMemoryDecisionStore,
  type ModelCandidate,
} from '@weaveintel/routing';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

/* ── 1. Define Model Candidates ───────────────────────── */

header('1. Model Candidates');

const candidates: ModelCandidate[] = [
  {
    id: 'gpt-4o',
    provider: 'openai',
    capabilities: new Set(['chat', 'streaming', 'tool_calling', 'vision', 'json_mode']),
    cost: { inputPer1k: 0.0025, outputPer1k: 0.01 },
    quality: { score: 0.95, benchmark: 'mmlu' },
    maxTokens: 128_000,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    capabilities: new Set(['chat', 'streaming', 'tool_calling', 'json_mode']),
    cost: { inputPer1k: 0.00015, outputPer1k: 0.0006 },
    quality: { score: 0.82, benchmark: 'mmlu' },
    maxTokens: 128_000,
  },
  {
    id: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    capabilities: new Set(['chat', 'streaming', 'tool_calling', 'vision', 'extended_thinking']),
    cost: { inputPer1k: 0.003, outputPer1k: 0.015 },
    quality: { score: 0.93, benchmark: 'mmlu' },
    maxTokens: 200_000,
  },
  {
    id: 'claude-haiku-4-20250414',
    provider: 'anthropic',
    capabilities: new Set(['chat', 'streaming', 'tool_calling']),
    cost: { inputPer1k: 0.0008, outputPer1k: 0.004 },
    quality: { score: 0.78, benchmark: 'mmlu' },
    maxTokens: 200_000,
  },
  {
    id: 'gpt-4.1-nano',
    provider: 'openai',
    capabilities: new Set(['chat', 'streaming']),
    cost: { inputPer1k: 0.0001, outputPer1k: 0.0004 },
    quality: { score: 0.70, benchmark: 'mmlu' },
    maxTokens: 128_000,
  },
];

for (const c of candidates) {
  console.log(`  ${c.provider}/${c.id} — quality: ${c.quality.score}, cost: $${c.cost.inputPer1k}/1k in, capabilities: [${[...c.capabilities].join(', ')}]`);
}

/* ── 2. Health Tracking ───────────────────────────────── */

header('2. Health Tracking');

const healthTracker = new ModelHealthTracker();

// Record some latencies and failures
healthTracker.recordSuccess('gpt-4o', 450);
healthTracker.recordSuccess('gpt-4o', 380);
healthTracker.recordSuccess('gpt-4o', 520);
healthTracker.recordSuccess('gpt-4o-mini', 120);
healthTracker.recordSuccess('gpt-4o-mini', 95);
healthTracker.recordSuccess('claude-sonnet-4-20250514', 600);
healthTracker.recordSuccess('claude-sonnet-4-20250514', 550);
healthTracker.recordFailure('claude-haiku-4-20250414'); // haiku having issues
healthTracker.recordFailure('claude-haiku-4-20250414');
healthTracker.recordSuccess('claude-haiku-4-20250414', 200);
healthTracker.recordSuccess('gpt-4.1-nano', 50);
healthTracker.recordSuccess('gpt-4.1-nano', 45);

for (const c of candidates) {
  const health = healthTracker.getHealth(c.id);
  const status = health.healthy ? '🟢' : '🔴';
  console.log(`  ${status} ${c.id} — avg latency: ${health.avgLatency.toFixed(0)}ms, success rate: ${(health.successRate * 100).toFixed(0)}%, requests: ${health.totalRequests}`);
}

/* ── 3. Capability Filtering ──────────────────────────── */

header('3. Filter by Capabilities');

const visionModels = filterByConstraints(candidates, {
  requiredCapabilities: new Set(['vision']),
});
console.log(`  Models with vision: ${visionModels.map(m => m.id).join(', ')}`);

const toolAndStreamModels = filterByConstraints(candidates, {
  requiredCapabilities: new Set(['tool_calling', 'streaming']),
});
console.log(`  Models with tool_calling + streaming: ${toolAndStreamModels.map(m => m.id).join(', ')}`);

const cheapModels = filterByConstraints(candidates, {
  maxCostPerInputToken: 0.001,
});
console.log(`  Budget models (< $0.001/1k input): ${cheapModels.map(m => m.id).join(', ')}`);

/* ── 4. Scoring & Ranking ─────────────────────────────── */

header('4. Weighted Scoring');

const scorer = new ModelScorer();

// Scenario A: Prioritize quality (complex reasoning task)
const qualityRanked = scorer.rank(candidates, {
  weights: { quality: 0.7, cost: 0.1, latency: 0.2 },
  healthTracker,
});
console.log('  Quality-first ranking (complex reasoning):');
qualityRanked.forEach((r, i) => {
  console.log(`    ${i + 1}. ${r.candidate.id} — score: ${r.score.toFixed(3)} (q=${r.breakdown.quality.toFixed(2)}, c=${r.breakdown.cost.toFixed(2)}, l=${r.breakdown.latency.toFixed(2)})`);
});

// Scenario B: Prioritize cost (high-volume batch)
const costRanked = scorer.rank(candidates, {
  weights: { quality: 0.2, cost: 0.6, latency: 0.2 },
  healthTracker,
});
console.log('\n  Cost-first ranking (batch processing):');
costRanked.forEach((r, i) => {
  console.log(`    ${i + 1}. ${r.candidate.id} — score: ${r.score.toFixed(3)}`);
});

// Scenario C: Prioritize latency (real-time chat)
const latencyRanked = scorer.rank(candidates, {
  weights: { quality: 0.2, cost: 0.2, latency: 0.6 },
  healthTracker,
});
console.log('\n  Latency-first ranking (real-time chat):');
latencyRanked.forEach((r, i) => {
  console.log(`    ${i + 1}. ${r.candidate.id} — score: ${r.score.toFixed(3)}`);
});

/* ── 5. Router with Fallback ──────────────────────────── */

header('5. Smart Router with Fallback');

const decisionStore = new InMemoryDecisionStore();

const router = new SmartModelRouter({
  candidates,
  healthTracker,
  decisionStore,
  defaultWeights: { quality: 0.4, cost: 0.3, latency: 0.3 },
});

// Route a complex task
const complexRoute = router.route({
  requiredCapabilities: new Set(['tool_calling', 'vision']),
  taskComplexity: 'high',
});
console.log(`  Complex task (tool_calling + vision):`);
console.log(`    Selected: ${complexRoute.selected.id} (score: ${complexRoute.score.toFixed(3)})`);
console.log(`    Fallback: ${complexRoute.fallbacks.map(f => f.id).join(', ')}`);

// Route a simple task
const simpleRoute = router.route({
  requiredCapabilities: new Set(['chat']),
  taskComplexity: 'low',
  preferCost: true,
});
console.log(`\n  Simple task (chat, prefer cheap):`);
console.log(`    Selected: ${simpleRoute.selected.id} (score: ${simpleRoute.score.toFixed(3)})`);
console.log(`    Fallback: ${simpleRoute.fallbacks.map(f => f.id).join(', ')}`);

// Simulate primary going unhealthy
console.log(`\n  Simulating ${complexRoute.selected.id} going down...`);
for (let i = 0; i < 5; i++) healthTracker.recordFailure(complexRoute.selected.id);

const failoverRoute = router.route({
  requiredCapabilities: new Set(['tool_calling', 'vision']),
  taskComplexity: 'high',
});
console.log(`    Failover selected: ${failoverRoute.selected.id}`);

/* ── 6. Round-Robin Selection ─────────────────────────── */

header('6. Round-Robin Load Balancing');

const rrCandidates = filterByConstraints(candidates, {
  requiredCapabilities: new Set(['chat', 'streaming']),
});
const selections: string[] = [];
for (let i = 0; i < 8; i++) {
  const selected = roundRobinSelect(rrCandidates, i);
  selections.push(selected.id);
}
console.log(`  8 round-robin selections: ${selections.join(' → ')}`);

/* ── 7. Fallback Candidate ────────────────────────────── */

header('7. Explicit Fallback Chain');

const primary = candidates.find(c => c.id === 'gpt-4o')!;
const fb = fallbackCandidate(candidates, primary, healthTracker);
console.log(`  Primary: ${primary.id}`);
console.log(`  Fallback: ${fb?.id || 'none'}`);

/* ── 8. Decision Log ──────────────────────────────────── */

header('8. Explainable Routing Decisions');

const decisions = decisionStore.list();
console.log(`  ${decisions.length} routing decisions logged:`);
decisions.slice(0, 5).forEach((d, i) => {
  console.log(`    ${i + 1}. selected=${d.selectedModelId}, task=${d.taskComplexity}, reason: ${d.reason}`);
});

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ 5 model candidates across 2 providers');
console.log('✅ Health tracking with latency and failure rates');
console.log('✅ Capability-based filtering (vision, tool_calling, etc.)');
console.log('✅ Weighted scoring (quality vs cost vs latency)');
console.log('✅ Smart router with automatic fallback on failure');
console.log('✅ Round-robin load balancing');
console.log('✅ Explainable decision logs');
