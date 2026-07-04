/**
 * Example: Anthropic Agent with full WeaveIntel stack
 *
 * A single-turn research agent that uses a real Claude LLM call, wired
 * through model routing, resilience, artifact storage, and cost tracking.
 *
 * ─── Prerequisites ──────────────────────────────────────────────────────────
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *
 * Run: npx tsx examples/with-llm/anthropic-agent.ts
 *
 * ─── What this demonstrates ─────────────────────────────────────────────────
 * This is the same pipeline as the `use-cases/research-assistant.ts` example
 * but with a real LLM call instead of simulated responses.
 *
 *   1. SmartModelRouter selects the cheapest model that meets the task policy
 *   2. createResilientCallable wraps the live API call with retry + circuit breaker
 *   3. weaveAnthropic makes the actual API call (Anthropic Messages API)
 *   4. createInMemoryCostLedger tracks tokens and USD spend from the response
 *   5. createInMemoryArtifactStore stores the response as a markdown artifact
 *
 * ─── Packages used ──────────────────────────────────────────────────────────
 *   @weaveintel/provider-anthropic
 *     • weaveAnthropic        — Claude provider (Messages API)
 *
 *   @weaveintel/routing
 *     • SmartModelRouter      — task-aware model selection
 *
 *   @weaveintel/resilience
 *     • createResilientCallable — retry + circuit breaker around the API call
 *     • getOrCreateEndpointState — endpoint-level state registry
 *     • _resetEndpointRegistry  — reset for clean startup
 *
 *   @weaveintel/artifacts
 *     • createArtifact          — build a typed artifact
 *     • createInMemoryArtifactStore — persist artifacts in process
 *
 *   @weaveintel/cost-governor
 *     • createInMemoryCostLedger — accumulate cost entries per run
 *     • computeUsd               — calculate $ from token counts + pricing
 *
 * ─── Local helpers ───────────────────────────────────────────────────────────
 *   PRICING — per-model token pricing table (LOCAL). In production use the
 *     pricing tables from each provider's pricing page, loaded from config.
 *
 *   header() / section() / ok() / info() — console helpers (LOCAL).
 */

import assert from 'node:assert/strict';

/* ── Provider ────────────────────────────────────────────────────────────── */
import { weaveAnthropic } from '@weaveintel/provider-anthropic';

/* ── Routing ─────────────────────────────────────────────────────────────── */
import { SmartModelRouter } from '@weaveintel/routing';

/* ── Resilience ──────────────────────────────────────────────────────────── */
import {
  createResilientCallable,
  getOrCreateEndpointState,
  _resetEndpointRegistry,
} from '@weaveintel/resilience';

/* ── Artifacts ───────────────────────────────────────────────────────────── */
import {
  createArtifact,
  createInMemoryArtifactStore,
} from '@weaveintel/artifacts';

/* ── Cost Governor ───────────────────────────────────────────────────────── */
import {
  createInMemoryCostLedger,
  computeUsd,
} from '@weaveintel/cost-governor';

/* ─── Console helpers (LOCAL) ────────────────────────────────────────────── */
const BOLD = '\x1b[1m'; const GREEN = '\x1b[32m'; const CYAN = '\x1b[36m';
const DIM = '\x1b[2m'; const RESET = '\x1b[0m';
function header(t: string) {
  console.log(`\n${BOLD}${'═'.repeat(66)}${RESET}`);
  console.log(`${BOLD}  ${t}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(66)}${RESET}`);
}
function section(t: string) { console.log(`\n${CYAN}  ── ${t} ──${RESET}`); }
function ok(m: string)   { console.log(`${GREEN}  ✓${RESET} ${m}`); }
function info(m: string) { console.log(`${DIM}  ℹ ${m}${RESET}`); }

/* ─── Pricing table (LOCAL — not from any package) ──────────────────────── */
// In production load from a config file or the provider's pricing API.
const PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.80,  outputPerMillion: 4.00 },
  'claude-sonnet-4-6':         { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-opus-4-7':           { inputPerMillion: 15.00, outputPerMillion: 75.00 },
};

/* ══════════════════════════════════════════════════════════════════════════ */

async function main() {
  // Guard: require API key before making any API calls
  if (!process.env['ANTHROPIC_API_KEY']) {
    console.error('\n  ERROR: ANTHROPIC_API_KEY environment variable not set.');
    console.error('  Set it first: export ANTHROPIC_API_KEY=sk-ant-...\n');
    process.exit(1);
  }

  header('WeaveIntel — Anthropic Agent (live LLM call)');

  /* ────────────────────────────────────────────────────────────────────────
   * 1. Model routing — pick the cheapest model that can handle the task
   * ────────────────────────────────────────────────────────────────────────*/
  section('1 — Model routing');

  const router = new SmartModelRouter({
    candidates: [
      { modelId: 'claude-haiku-4-5-20251001', providerId: 'anthropic', capabilities: ['summarization', 'analysis'] },
      { modelId: 'claude-sonnet-4-6',         providerId: 'anthropic', capabilities: ['summarization', 'analysis', 'reasoning'] },
    ],
    costs: [
      { modelId: 'claude-haiku-4-5-20251001', providerId: 'anthropic', inputCostPer1M: 0.80, outputCostPer1M: 4.00 },
      { modelId: 'claude-sonnet-4-6',         providerId: 'anthropic', inputCostPer1M: 3.00, outputCostPer1M: 15.00 },
    ],
    qualities: [
      { modelId: 'claude-haiku-4-5-20251001', providerId: 'anthropic', qualityScore: 0.65 },
      { modelId: 'claude-sonnet-4-6',         providerId: 'anthropic', qualityScore: 0.85 },
    ],
  });

  const USER_QUERY = 'Explain the key differences between transformer and state-space model architectures in 3 bullet points.';

  // Cost-optimized policy picks haiku for a summarization task
  const decision = await router.route(
    { prompt: USER_QUERY },
    {
      id:       'policy-cost-optimized',
      name:     'cost-optimized-summarization',
      strategy: 'cost-optimized',
      enabled:  true,
      constraints: { requiredCapabilities: ['summarization'] },
    },
  );
  const selectedModelId = decision.modelId;
  ok(`Router selected: ${selectedModelId} (${decision.reason})`);

  /* ────────────────────────────────────────────────────────────────────────
   * 2. Resilient LLM call — wraps the Anthropic API with retry
   *
   * getOrCreateEndpointState registers the endpoint in the shared registry
   * so all callers in the process share the same circuit breaker state.
   *
   * createResilientCallable wraps the actual API call function so retries
   * and circuit breaker logic apply transparently.
   * ────────────────────────────────────────────────────────────────────────*/
  section('2 — Resilient Anthropic API call');

  _resetEndpointRegistry();
  getOrCreateEndpointState(`anthropic:${selectedModelId}`, {
    rateLimit:   { capacity: 20, refillPerSec: 10 },
    circuit:     { failureThreshold: 5, cooldownMs: 10_000 },
    concurrency: { maxConcurrent: 5 },
  });

  // weaveAnthropic creates a Model that wraps the Anthropic Messages API.
  // It reads ANTHROPIC_API_KEY from the environment automatically.
  const model = weaveAnthropic(selectedModelId);

  const resilientGenerate = createResilientCallable(
    async (userMessage: string) => {
      // model.generate makes the live API call
      return model.generate(
        { executionId: 'demo-run-001', metadata: {} },
        {
          messages: [{ role: 'user', content: userMessage }],
          maxTokens: 512,
          temperature: 0.7,
        },
      );
    },
    {
      endpoint: `anthropic:${selectedModelId}`,
      retry: {
        maxAttempts:  3,
        baseDelayMs:  1000,
        maxDelayMs:   10_000,
        jitter:       true,
      },
    },
  );

  console.log(`\n  Calling ${selectedModelId}…`);
  const response = await resilientGenerate(USER_QUERY);

  assert.ok(response.content, 'should get a non-empty response');
  assert.equal(response.finishReason, 'stop', 'should finish normally');

  ok(`Response received (${response.usage.totalTokens} tokens)`);
  info(`Finish reason: ${response.finishReason}`);
  console.log(`\n  ${'─'.repeat(60)}`);
  console.log(`  ${response.content.replace(/\n/g, '\n  ')}`);
  console.log(`  ${'─'.repeat(60)}`);

  /* ────────────────────────────────────────────────────────────────────────
   * 3. Cost tracking — record actual token spend
   * ────────────────────────────────────────────────────────────────────────*/
  section('3 — Cost tracking');

  const ledger = createInMemoryCostLedger();
  const pricing = PRICING[selectedModelId]!;

  const costUsd = computeUsd(
    { modelId: selectedModelId, inputTokens: response.usage.promptTokens, outputTokens: response.usage.completionTokens },
    { inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion },
  );

  await ledger.record({
    id:           'entry-001',
    runId:        'demo-run-001',
    source:       'model',
    lever:        'model',
    subject:      selectedModelId,
    provider:     'anthropic',
    inputTokens:  response.usage.promptTokens,
    outputTokens: response.usage.completionTokens,
    costUsd,
    observedAt:   Date.now(),
  });

  const breakdown = await ledger.breakdown('demo-run-001');
  ok(`Input tokens:  ${response.usage.promptTokens}`);
  ok(`Output tokens: ${response.usage.completionTokens}`);
  ok(`Total cost:    $${costUsd.toFixed(6)} USD`);
  info(`Lever breakdown: model=$${breakdown.byLever.model.toFixed(6)}`);

  /* ────────────────────────────────────────────────────────────────────────
   * 4. Artifact storage — persist the response as a markdown artifact
   * ────────────────────────────────────────────────────────────────────────*/
  section('4 — Artifact storage');

  const artifactStore = createInMemoryArtifactStore();

  const artifactInput = createArtifact({
    name:     `Research: ${USER_QUERY.slice(0, 50)}`,
    type:     'markdown',
    mimeType: 'text/markdown',
    data:     `## Query\n${USER_QUERY}\n\n## Response\n${response.content}\n\n---\n_Model: ${selectedModelId} | Tokens: ${response.usage.totalTokens} | Cost: $${costUsd.toFixed(6)}_`,
    tags:     ['research', 'ai-architecture'],
    metadata: {
      model:     selectedModelId,
      runId:     'demo-run-001',
      costUsd,
      promptTokens:     response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
    },
  });
  const saved = await artifactStore.save(artifactInput);

  assert.ok(saved.id, 'artifact should have an ID');
  ok(`Artifact saved: id=${saved.id.slice(0, 8)}… name="${saved.name}"`);

  const all = await artifactStore.list();
  ok(`Artifact store now contains ${all.length} artifact(s)`);

  /* ─── Summary ──────────────────────────────────────────────────────────── */
  header('Done');
  console.log(`
  What just happened:
    1.  SmartModelRouter selected ${selectedModelId}
    2.  createResilientCallable wrapped the API call with retry
    3.  weaveAnthropic made a live Anthropic Messages API call
    4.  Response stored as a markdown artifact
    5.  Cost recorded: $${costUsd.toFixed(6)} USD

  Next steps:
    • Replace InMemoryArtifactStore with a DB-backed store
    • Add @weaveintel/memory for multi-turn conversation history
    • Add @weaveintel/tenancy for per-tenant model and budget control
    • Add @weaveintel/encryption to encrypt stored messages at rest
  `);
}

main().catch(err => { console.error(err); process.exit(1); });
