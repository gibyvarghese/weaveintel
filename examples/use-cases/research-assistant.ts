/**
 * Use Case: Resilient Research Assistant
 *
 * Demonstrates an AI research assistant that:
 *   1. Routes queries to the right model (cheap for summaries, powerful for analysis)
 *   2. Wraps LLM calls with resilience (retry + circuit breaker for provider failures)
 *   3. Stores research findings as typed artifacts with versioning
 *   4. Maintains a simple in-memory conversation history
 *
 * All LLM calls are simulated — no API keys needed. The resilience section
 * intentionally injects failures to show retry and circuit breaker behavior.
 *
 * ─── Packages used ──────────────────────────────────────────────────────────
 *   @weaveintel/routing
 *     • SmartModelRouter     — picks the best model given task type and cost policy
 *     • InMemoryDecisionStore — persists routing decisions for analysis/replay
 *     • ModelHealthTracker   — tracks model availability (via SmartModelRouter internals)
 *     • ModelScorer          — scores candidates by cost, quality, and capabilities
 *
 *   @weaveintel/resilience
 *     • createResilientCallable — wraps a function with retry + circuit breaker + rate limit
 *     • getOrCreateEndpointState — endpoint-level state (one circuit breaker per model)
 *     • createResilienceSignalBus — observe circuit state transitions
 *     • _resetEndpointRegistry  — reset between examples (test utility)
 *
 *   @weaveintel/artifacts
 *     • createArtifact           — create a typed artifact (json/markdown/code/csv)
 *     • createArtifactVersion    — create a new version of an existing artifact
 *     • createInMemoryArtifactStore — in-process artifact storage
 *     • createArtifactReference  — resolve artifact by ID or alias
 *     • formatReference          — human-readable reference string
 *
 * ─── Local helpers (NOT from any @weaveintel package) ───────────────────────
 *   simulateLlmCall()   — returns synthetic text and token counts. In production
 *                          this is your actual provider call (wrapModelWithCostLedger
 *                          + provider SDK). The "resilience" version injects random
 *                          failures to demonstrate retry behavior.
 *
 *   ResearchSession     — plain class tracking in-memory conversation history.
 *                          In production use weaveConversationMemory (from
 *                          @weaveintel/memory) backed by SQLite or Postgres.
 *
 *   RESEARCH_QUERIES    — fixture queries used as example inputs.
 *
 *   header() / section() / ok() / info() / warn() — console helpers.
 *
 * Run: npx tsx examples/use-cases/research-assistant.ts
 */

import assert from 'node:assert/strict';

/* ── Routing ─────────────────────────────────────────────────────────────── */
import {
  SmartModelRouter,
  InMemoryDecisionStore,
} from '@weaveintel/routing';

/* ── Resilience ──────────────────────────────────────────────────────────── */
import {
  createResilientCallable,
  createResilienceSignalBus,
  getOrCreateEndpointState,
  _resetEndpointRegistry,
} from '@weaveintel/resilience';
import { WeaveIntelError } from '@weaveintel/core';

/* ── Artifacts ───────────────────────────────────────────────────────────── */
import {
  createArtifact,
  createArtifactVersion,
  createInMemoryArtifactStore,
  createArtifactReference,
  resolveReference,
  formatReference,
} from '@weaveintel/artifacts';

/* ─── Console helpers (LOCAL) ────────────────────────────────────────────── */
const BOLD = '\x1b[1m'; const GREEN = '\x1b[32m'; const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m'; const DIM = '\x1b[2m'; const RESET = '\x1b[0m';

function header(t: string) {
  console.log(`\n${BOLD}${'═'.repeat(66)}${RESET}`);
  console.log(`${BOLD}  ${t}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(66)}${RESET}`);
}
function section(t: string) { console.log(`\n${CYAN}  ── ${t} ──${RESET}`); }
function ok(m: string)   { console.log(`${GREEN}  ✓${RESET} ${m}`); }
function info(m: string) { console.log(`${DIM}  ℹ ${m}${RESET}`); }
function warn(m: string) { console.log(`${YELLOW}  ⚠${RESET} ${m}`); }

/* ─── simulateLlmCall (LOCAL — not from any package) ────────────────────── */
// Pretends to call an LLM. In production this is your provider SDK call,
// wrapped with wrapModelWithCostLedger for cost tracking.
//
// The "flaky" variant injects transient failures to demonstrate resilience:
// WeaveIntelError with retryable=true is required — plain Error is classified
// as non-retryable by classifyError() inside createResilientCallable.

let _callCount = 0;

function simulateLlmCall(model: string, prompt: string, flaky = false): string {
  _callCount++;
  if (flaky && _callCount % 3 !== 0) {
    // Fail 2 out of every 3 calls — third call succeeds (demonstrates retry)
    throw new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: `Provider ${model} temporarily unavailable (simulated)`,
      retryable: true,
    });
  }
  const words = prompt.split(' ').length;
  return `[${model}] Research synthesis for query (${words} words): "${prompt.slice(0, 60)}…" → Found 3 key findings.`;
}

/* ─── ResearchSession (LOCAL — not from any package) ────────────────────── */
// Simple in-memory conversation history for the research session.
// In production use weaveConversationMemory (from @weaveintel/memory) backed
// by SQLite (weaveSqliteMemoryStore) or Postgres (weavePostgresMemoryStore).

class ResearchSession {
  readonly turns: Array<{ role: 'user' | 'assistant'; content: string; model?: string }> = [];

  addUserMessage(content: string) {
    this.turns.push({ role: 'user', content });
  }

  addAssistantMessage(content: string, model: string) {
    this.turns.push({ role: 'assistant', content, model });
  }

  get lastAssistantMessage(): string | undefined {
    return [...this.turns].reverse().find(t => t.role === 'assistant')?.content;
  }
}

/* ─── Fixture research queries (LOCAL) ──────────────────────────────────── */
const RESEARCH_QUERIES = [
  { query: 'What is the current state of quantum computing hardware?',    taskType: 'analysis' },
  { query: 'Summarize the key findings from recent AI safety research.',  taskType: 'summarization' },
  { query: 'Compare transformer and state-space model architectures.',    taskType: 'analysis' },
];

/* ══════════════════════════════════════════════════════════════════════════ */
/*  MAIN                                                                       */
/* ══════════════════════════════════════════════════════════════════════════ */

async function main() {
  header('Use Case: Resilient Research Assistant');

  /* ────────────────────────────────────────────────────────────────────────
   * 1. Model routing — pick the best model for the task
   *
   * SmartModelRouter evaluates a pool of model candidates against a routing
   * policy and returns the best match. Policy constraints let you:
   *   • Gate models by required capabilities (e.g. 'long-context', 'code')
   *   • Set a cost ceiling (maxCostPerMToken) to cap spend
   *   • Allow fallback chains when the preferred model is unavailable
   *
   * For a research assistant we want:
   *   • Summarization queries → cheapest model (haiku)
   *   • Analysis queries      → most capable model (opus)
   * ────────────────────────────────────────────────────────────────────────*/
  section('1 — SmartModelRouter: task-aware model selection');

  const decisionStore = new InMemoryDecisionStore();

  // Define the pool of available models. In production these come from the
  // model registry (your DB or the @weaveintel/routing admin API).
  const router = new SmartModelRouter({
    candidates: [
      { modelId: 'claude-haiku-4-5-20251001', providerId: 'anthropic', capabilities: ['summarization', 'classification'] },
      { modelId: 'claude-sonnet-4-6',         providerId: 'anthropic', capabilities: ['summarization', 'analysis', 'reasoning'] },
      { modelId: 'claude-opus-4-7',           providerId: 'anthropic', capabilities: ['summarization', 'analysis', 'reasoning', 'long-context'] },
    ],
    // Cost per million tokens (used by the scorer to rank candidates)
    costs: [
      { modelId: 'claude-haiku-4-5-20251001',  providerId: 'anthropic', inputPerMToken: 0.80,  outputPerMToken: 4.00 },
      { modelId: 'claude-sonnet-4-6',          providerId: 'anthropic', inputPerMToken: 3.00,  outputPerMToken: 15.00 },
      { modelId: 'claude-opus-4-7',            providerId: 'anthropic', inputPerMToken: 15.00, outputPerMToken: 75.00 },
    ],
    // Quality scores (0–1) influence model preference alongside cost
    qualities: [
      { modelId: 'claude-haiku-4-5-20251001',  providerId: 'anthropic', qualityScore: 0.65 },
      { modelId: 'claude-sonnet-4-6',          providerId: 'anthropic', qualityScore: 0.85 },
      { modelId: 'claude-opus-4-7',            providerId: 'anthropic', qualityScore: 0.98 },
    ],
    decisionStore,
  });

  // Route a summarization query — cost constraint narrows to haiku
  // RoutingPolicy requires: id, name, strategy, enabled (plus optional constraints)
  const summarizationDecision = await router.route(
    { prompt: RESEARCH_QUERIES[1]!.query },
    {
      id:       'policy-summarization',
      name:     'research-summarization',
      strategy: 'cost-optimized',
      enabled:  true,
      constraints: {
        requiredCapabilities: ['summarization'],
        maxCostPerRequest: 0.01,  // caps per-request cost; excludes expensive models
      },
    },
  );
  assert.ok(summarizationDecision.modelId, 'should select a model');
  ok(`Summarization query → model: ${summarizationDecision.modelId}`);
  info(`Reason: ${summarizationDecision.reason}`);

  // Route an analysis query — no cost constraint, picks by quality score
  const analysisDecision = await router.route(
    { prompt: RESEARCH_QUERIES[0]!.query },
    {
      id:       'policy-analysis',
      name:     'research-analysis',
      strategy: 'quality-optimized',
      enabled:  true,
      constraints: {
        requiredCapabilities: ['analysis', 'reasoning'],
      },
    },
  );
  assert.ok(analysisDecision.modelId, 'should select a model for analysis');
  ok(`Analysis query → model: ${analysisDecision.modelId}`);
  info(`Reason: ${analysisDecision.reason}`);

  // Decisions are stored — useful for audit, replay, and routing analytics
  const decisions = await decisionStore.list();
  assert.equal(decisions.length, 2, 'should have stored 2 routing decisions');
  ok(`${decisions.length} routing decisions persisted in InMemoryDecisionStore`);

  /* ────────────────────────────────────────────────────────────────────────
   * 2. Resilience — wrap LLM call with retry + circuit breaker
   *
   * createResilientCallable wraps any async function with:
   *   • Token bucket (rate limiter) — prevents bursts
   *   • Circuit breaker — trips after repeated failures, half-opens after cooldown
   *   • Retry policy   — re-attempts transient errors with jitter backoff
   *   • Concurrency limiter — caps simultaneous in-flight calls
   *
   * Key: only WeaveIntelError with retryable=true is retried. Plain Error
   * and errors from non-retryable codes are passed through immediately.
   *
   * This makes the research assistant resilient to temporary provider outages
   * without needing any changes to the LLM call code itself.
   * ────────────────────────────────────────────────────────────────────────*/
  section('2 — Resilient LLM call (retry + circuit breaker)');

  _resetEndpointRegistry();

  // One endpoint state per model — shared across all callers in the process
  const endpointKey = 'anthropic:claude-sonnet-4-6';
  const ep = getOrCreateEndpointState(endpointKey, {
    rateLimit:   { capacity: 10, refillRate: 5 },   // 10 req burst, 5 req/sec steady
    circuit:     { threshold: 3, cooldownMs: 500 },  // open after 3 failures, cool for 500ms
    concurrency: { maxConcurrent: 5 },
  });

  // Signal bus lets you observe circuit state changes for dashboards / alerts
  const bus = createResilienceSignalBus();
  bus.on(signal => {
    if (signal.type === 'circuit_opened') {
      warn(`Circuit OPENED for ${endpointKey} — consecutive failures: ${signal.consecutiveFailures}`);
    }
    if (signal.type === 'circuit_half_opened') {
      info(`Circuit HALF-OPEN for ${endpointKey} — testing one probe request`);
    }
    if (signal.type === 'circuit_closed') {
      ok(`Circuit CLOSED for ${endpointKey} — endpoint recovered`);
    }
  });

  // createResilientCallable binds the endpoint state to a specific call function.
  // The wrapped function is called instead of the raw LLM call everywhere in the app.
  const resilientCall = createResilientCallable(
    async (model: string, prompt: string) => simulateLlmCall(model, prompt, true /* flaky */),
    {
      endpointId: endpointKey,
      retry: {
        maxAttempts:    3,
        initialDelayMs: 50,
        maxDelayMs:     500,
        jitterFactor:   0.3,
      },
      signalBus: bus,
    },
  );

  // Reset the flaky call counter so we hit the pattern reliably
  _callCount = 0;

  // The first successful call should retry internally (simulateLlmCall fails 2/3 times)
  const resilientResult = await resilientCall('claude-sonnet-4-6', RESEARCH_QUERIES[0]!.query);
  assert.ok(typeof resilientResult === 'string', 'should get a result despite transient failures');
  ok(`Resilient call succeeded: "${resilientResult.slice(0, 60)}…"`);
  info('Internally retried up to 3 times before succeeding');

  /* ────────────────────────────────────────────────────────────────────────
   * 3. Artifacts — store research findings with versioning
   *
   * @weaveintel/artifacts provides typed, versioned storage for any output
   * the research assistant produces: summaries, analysis reports, code
   * snippets, citation lists.
   *
   * Each artifact has:
   *   • type:    'json' | 'markdown' | 'code' | 'csv' | 'text'
   *   • content: the actual data
   *   • version: 1, 2, 3… (immutable history)
   *   • metadata: tags, source, timestamp, etc.
   *
   * In production these are persisted to the artifacts table in your DB.
   * Here we use createInMemoryArtifactStore() for the example.
   * ────────────────────────────────────────────────────────────────────────*/
  section('3 — Artifacts: store and version research findings');

  const artifactStore = createInMemoryArtifactStore();

  // createArtifact builds an Artifact object; store.save() persists it and
  // returns the stored copy with its final assigned ID.
  // Field mapping: name (not title), data (not content), mimeType is required.

  // Create an initial research summary artifact (markdown)
  const summaryInput = createArtifact({
    name:     'Quantum Computing Hardware Survey',
    type:     'markdown',
    mimeType: 'text/markdown',
    data:     `# Quantum Computing Hardware — 2025 Survey\n\n${resilientResult}\n\n## Key Findings\n1. Superconducting qubits remain dominant\n2. Photonic approaches gaining traction\n3. Error correction still the critical bottleneck`,
    tags:     ['quantum', 'hardware', 'survey'],
    metadata: {
      source: 'research-assistant',
      query:  RESEARCH_QUERIES[0]!.query,
      model:  analysisDecision.modelId,
    },
  });
  // save() persists and returns the stored artifact with its final ID
  const summary = await artifactStore.save(summaryInput);
  ok(`Created artifact: "${summary.name}" (v${summary.version}, type=${summary.type})`);

  // Create a JSON artifact for structured citation data
  const citationsInput = createArtifact({
    name:     'Research Citations',
    type:     'json',
    mimeType: 'application/json',
    data:     {
      query:     RESEARCH_QUERIES[0]!.query,
      sources:   ['arXiv:2301.xxxxx', 'Nature Quantum 2024', 'IEEE QC Report 2025'],
      retrieved: new Date().toISOString(),
    },
    tags: ['citations', 'quantum'],
  });
  const citations = await artifactStore.save(citationsInput);
  ok(`Created artifact: "${citations.name}" (v${citations.version}, type=${citations.type})`);

  // createArtifactVersion builds a version record; save() persists it.
  // After versioning, retrieve the latest with store.get(id).
  const v2Data = `${String(summaryInput.data)}\n\n## Updated Analysis\nRecent breakthroughs in topological qubits added.`;
  const summaryV2 = createArtifactVersion(summary.id, 2, v2Data, 'Added topological qubit section');
  // Store the updated artifact (save overwrites with same logical content + new version)
  const updatedArtifact = await artifactStore.save({ ...summaryInput, version: 2, data: v2Data });
  ok(`Updated artifact to v${updatedArtifact.version}: "${updatedArtifact.name}"`);
  info(`Version record id: ${summaryV2.id.slice(0, 8)}… (changelog: "${summaryV2.changelog}")`);

  // Retrieve by the stored ID
  const saved = await artifactStore.get(summary.id);
  assert.ok(saved, 'artifact should exist in store');
  ok(`Retrieved from store: "${saved!.name}" v${saved!.version}`);

  // List all artifacts in the store
  const all = await artifactStore.list();
  assert.ok(all.length >= 2, 'store should contain at least 2 artifacts');
  ok(`Artifact store has ${all.length} entries`);

  // createArtifactReference creates a typed pointer to an artifact by ID
  // resolveReference(store, ref) looks it up — NOT store.resolve(ref)
  const ref      = createArtifactReference(summary.id, undefined, 'quantum-survey');
  const resolved = await resolveReference(artifactStore, ref);
  assert.ok(resolved, 'reference should resolve');
  ok(`Reference resolved: ${formatReference(ref)} → "${resolved!.name}"`);

  /* ────────────────────────────────────────────────────────────────────────
   * 4. Full research session — routing + resilience + artifacts together
   *
   * This section shows what a complete query → response → store cycle looks
   * like when all three packages work together. Each query is:
   *   1. Routed to the best model (SmartModelRouter)
   *   2. Executed with resilience (createResilientCallable)
   *   3. Stored as an artifact (createInMemoryArtifactStore)
   *   4. Logged to the session history (ResearchSession)
   * ────────────────────────────────────────────────────────────────────────*/
  section('4 — Full research session (routing + resilience + artifacts)');

  const session  = new ResearchSession();

  // Reset call counter and registry for a clean demo
  _callCount = 0;
  _resetEndpointRegistry();

  for (const { query, taskType } of RESEARCH_QUERIES) {
    session.addUserMessage(query);

    // Step 1: Route to best model for this task type
    const decision = await router.route(
      { prompt: query },
      {
        id:       `policy-${taskType}`,
        name:     `research-${taskType}`,
        strategy: taskType === 'summarization' ? 'cost-optimized' : 'quality-optimized',
        enabled:  true,
        constraints: taskType === 'summarization'
          ? { requiredCapabilities: ['summarization'], maxCostPerRequest: 0.01 }
          : { requiredCapabilities: ['analysis', 'reasoning'] },
      },
    );
    const model = decision.modelId;

    // Step 2: Execute with resilience — non-flaky here for a clean demo
    const ep2 = getOrCreateEndpointState(`anthropic:${model}`, {
      rateLimit:   { capacity: 20, refillRate: 10 },
      circuit:     { threshold: 5, cooldownMs: 1000 },
      concurrency: { maxConcurrent: 10 },
    });

    const reliableCall = createResilientCallable(
      async (m: string, p: string) => simulateLlmCall(m, p, false /* stable */),
      { endpointId: `anthropic:${model}`, retry: { maxAttempts: 2, initialDelayMs: 50, maxDelayMs: 200, jitterFactor: 0.2 } },
    );

    const response = await reliableCall(model, query);
    session.addAssistantMessage(response, model);

    // Step 3: Store as artifact
    const artifactInput = createArtifact({
      name:     `Research: ${query.slice(0, 50)}`,
      type:     'markdown',
      mimeType: 'text/markdown',
      data:     `## Query\n${query}\n\n## Response\n${response}`,
      metadata: { model, taskType, query, sessionTurn: session.turns.length },
    });
    const savedArtifact = await artifactStore.save(artifactInput);

    ok(`[${taskType.padEnd(14)}] model=${model.slice(-10)}  artifact=${savedArtifact.id.slice(0, 8)}…`);
  }

  // Session history and artifact count
  assert.equal(session.turns.length, RESEARCH_QUERIES.length * 2, 'should have 2 turns per query');
  const finalAll = await artifactStore.list();
  ok(`Session complete: ${session.turns.length} turns, ${finalAll.length} artifacts stored`);
  info(`Last response: "${session.lastAssistantMessage?.slice(0, 70)}…"`);

  /* ─── Summary ──────────────────────────────────────────────────────────── */
  header('All checks passed');
  console.log(`
  What this use case showed:
    1.  SmartModelRouter      — task-aware routing: cheap model for summarization,
                                capable model for analysis
    2.  createResilientCallable — LLM calls wrapped with retry (transient errors)
                                and circuit breaker (cascading failure protection)
    3.  Artifacts             — typed research findings stored with full version
                                history (markdown summaries, JSON citations)
    4.  Full pipeline         — routing → resilient LLM call → artifact storage
                                → session history in a single request cycle

  Packages: @weaveintel/routing · @weaveintel/resilience · @weaveintel/artifacts
  `);
}

main().catch(err => { console.error(err); process.exit(1); });
