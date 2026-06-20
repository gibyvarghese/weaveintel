/**
 * Example 148 — weaveAgent + weaveRuntime: full-stack end-to-end
 *
 * Boots a complete WeaveRuntime with every capability slot wired, runs
 * weaveAgent against a real OpenAI model, and exercises each slot in-turn
 * so you can confirm everything works in your environment.
 *
 * ── Capability slots covered ────────────────────────────────────────────────
 *   ✓ NetEgress      — hardened outbound HTTP (always on)
 *   ✓ Observability  — console tracer (always on)
 *   ✓ Secrets        — env-var resolver reads OPENAI_API_KEY (always on)
 *   ✓ Audit          — in-process audit logger (always on)
 *   ✓ Persistence    — in-memory KV store (RuntimeKvStore)
 *   ✓ Resilience     — signal bus + latency tracking
 *   ✓ Guardrails     — inline input / tool-call / output checks
 *   ✓ Encryption     — lazy-ref slot (no VAULT_KEY required to run)
 *   ✓ Routing        — ModelHealthTracker + supportsMultiModal
 *   ✓ Cost           — in-memory ledger, $10 budget gate
 *   ✓ Memory         — semantic + working memory backed by in-memory store
 *   ✓ Compliance     — durable consent / residency / deletion managers
 *   ✓ Identity       — RBAC resolve + access evaluate
 *   ✓ Cache          — shared response cache (RuntimeCacheSlot)
 *
 * ── Prerequisites ───────────────────────────────────────────────────────────
 *   cp .env.example .env
 *   # add:  OPENAI_API_KEY=sk-...
 *   npx tsx examples/148-weaveagent-full-runtime-e2e.ts
 */

import 'dotenv/config';

// ── Core ─────────────────────────────────────────────────────────────────────
import {
  weaveRuntime,
  weaveInMemoryPersistence,
  RuntimeCapabilities,
  describeRuntimeCapabilities,
  weaveAudit,
  weaveContext,
  weaveTool,
  weaveToolRegistry,
  type RuntimeGuardrailsSlot,
  type RuntimeEncryptionSlot,
  type ExecutionContext,
} from '@weaveintel/core';

// ── Model provider ────────────────────────────────────────────────────────────
import {
  weaveOpenAIModel,
  weaveOpenAIEmbeddingModel,
} from '@weaveintel/provider-openai';

// ── Agent ─────────────────────────────────────────────────────────────────────
import { weaveAgent } from '@weaveintel/agents';

// ── Slot adapters ─────────────────────────────────────────────────────────────
import {
  createResilienceSignalBus,
  setDefaultSignalBus,
  createRuntimeResilienceAdapter,
} from '@weaveintel/resilience';

import {
  ModelHealthTracker,
  createRuntimeRoutingAdapter,
} from '@weaveintel/routing';

import {
  createInMemoryCostLedger,
  createRuntimeCostAdapter,
} from '@weaveintel/cost-governor';

import {
  weaveMemoryStore,
  weaveSemanticMemory,
  weaveWorkingMemory,
  createRuntimeMemoryAdapter,
} from '@weaveintel/memory';

import { createRuntimeComplianceAdapter } from '@weaveintel/compliance';
import { createRuntimeIdentityAdapter } from '@weaveintel/identity';

import {
  weaveInMemoryCacheStore,
  createRuntimeCacheAdapter,
} from '@weaveintel/cache';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function section(title: string) {
  console.log(`\n${BOLD}${CYAN}━━━  ${title}  ━━━${RESET}`);
}

function check(label: string, value: boolean) {
  const icon = value ? `${GREEN}✓${RESET}` : `\x1b[31m✗${RESET}`;
  console.log(`  ${icon}  ${label}`);
}

function info(label: string, value: unknown) {
  console.log(`  ${DIM}${label}:${RESET} ${YELLOW}${String(value)}${RESET}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. API key guard
// ─────────────────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];
if (!OPENAI_API_KEY || OPENAI_API_KEY.startsWith('sk-your-')) {
  console.error(
    '\n❌  OPENAI_API_KEY not set.\n' +
    '    Copy .env.example → .env and add your key, then re-run.\n',
  );
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Build runtime slot by slot
// ─────────────────────────────────────────────────────────────────────────────

section('1. Persistence slot (in-memory KV)');

const persistence = weaveInMemoryPersistence();
info('kind', persistence.kind);

// We need a base runtime so the compliance adapter can reach the KV store.
// Pattern: create a lightweight base runtime first, build compliance from it,
// then construct the full runtime with all slots.
const baseRuntime = weaveRuntime({
  persistence,
  installDefaultTracer: false,
  tlsFloor: false,       // allow http:// in development / tests
});
info('persistence.kv.set', typeof baseRuntime.persistence?.kv.set);

// ─────────────────────────────────────────────────────────────────────────────

section('2. Resilience slot (signal bus + adapter)');

const signalBus = createResilienceSignalBus();
setDefaultSignalBus(signalBus);
const resilienceAdapter = createRuntimeResilienceAdapter(signalBus);

// Listen for any signal emission so we can see it in the output.
signalBus.on('http_call', (sig) => {
  info('  resilience signal received', `${sig.kind} @ ${sig.endpoint}`);
});

info('emit fn type', typeof resilienceAdapter.emit);

// ─────────────────────────────────────────────────────────────────────────────

section('3. Guardrails slot (inline policy)');

let blockedInputs = 0;
let blockedToolCalls = 0;
let scannedOutputs = 0;

const guardrailsSlot: RuntimeGuardrailsSlot = {
  async checkInput(_ctx, input) {
    // Block any message containing the literal string "BLOCKED_WORD"
    if (input.includes('BLOCKED_WORD')) {
      blockedInputs++;
      return { allow: false, reason: 'input blocked by guardrail demo' };
    }
    return { allow: true };
  },

  async checkToolCall(_ctx, schema, _args) {
    // Demo: allow everything except tools explicitly tagged dangerous
    if ((schema.riskLevel ?? '') === 'high') {
      blockedToolCalls++;
      return { allow: false, reason: `tool "${schema.name}" is high-risk` };
    }
    return { allow: true };
  },

  async checkOutput(_ctx, text) {
    scannedOutputs++;
    // Redact any occurrence of "REDACT_THIS" in model output
    const redacted = text.replaceAll('REDACT_THIS', '[REDACTED]');
    return { allow: true, redactedText: redacted !== text ? redacted : undefined };
  },
};

info('checkInput type', typeof guardrailsSlot.checkInput);

// ─────────────────────────────────────────────────────────────────────────────

section('4. Encryption slot (lazy-ref stub)');

// The full TenantKeyManager requires a database and VAULT_KEY.
// For this example we wire a no-op slot so the capability is advertised
// without requiring VAULT_KEY to be set.
const encryptionSlot: RuntimeEncryptionSlot = {
  kind: 'demo-stub',
  getManager() { return null; },
  isActive() { return false; },
};

info('kind', encryptionSlot.kind);
info('isActive', encryptionSlot.isActive());

// ─────────────────────────────────────────────────────────────────────────────

section('5. Routing slot (ModelHealthTracker + multiModal)');

const healthTracker = new ModelHealthTracker();
const routingAdapter = createRuntimeRoutingAdapter(healthTracker, { multiModal: true });

info('supportsMultiModal', routingAdapter.supportsMultiModal?.());
info('listHealth (empty at boot)', JSON.stringify(routingAdapter.listHealth()));

// ─────────────────────────────────────────────────────────────────────────────

section('6. Cost slot (in-memory ledger, $10 budget)');

const costLedger = createInMemoryCostLedger();
const costAdapter = createRuntimeCostAdapter({
  ledger: costLedger,
  globalLimitUsd: 10.00,   // $10 hard ceiling for this demo run
});

const gateBefore = await costAdapter.gate({ userId: 'demo-user', tenantId: null });
info('gate before any spend', gateBefore.allowed);

// ─────────────────────────────────────────────────────────────────────────────

section('7. Memory slot (semantic + working, in-memory store)');

// A real embedding model is needed for semantic memory recall —
// use text-embedding-3-small (cheapest, ~$0.00002 / 1k tokens).
const embeddingModel = weaveOpenAIEmbeddingModel('text-embedding-3-small', {
  apiKey: OPENAI_API_KEY,
});
const memStore = weaveMemoryStore();             // in-memory MemoryStore
const semanticMem = weaveSemanticMemory(embeddingModel, memStore);
const workingMem = weaveWorkingMemory();

const memoryAdapter = createRuntimeMemoryAdapter({
  semantic: semanticMem,
  working: workingMem,
  store: memStore,
  consolidate: async (userId) => {
    console.log(`  [memory] consolidating episodic → semantic for user: ${userId}`);
  },
});

info('semantic type', typeof memoryAdapter.semantic.store);
info('working type', typeof memoryAdapter.working.patch);

// ─────────────────────────────────────────────────────────────────────────────

section('8. Compliance slot (durable managers via base runtime)');

const complianceAdapter = createRuntimeComplianceAdapter({
  runtime: baseRuntime,
  defaultErasureCategories: ['pii', 'session-data'],
});

// Seed a consent grant so we can demonstrate isAllowed later.
await complianceAdapter.consent.grant('demo-user', 'analytics', 'e2e-example');
const isAllowedBefore = await complianceAdapter.isAllowed('demo-user', 'analytics');
info('consent granted + isAllowed', isAllowedBefore);

// ─────────────────────────────────────────────────────────────────────────────

section('9. Identity slot (RBAC — default policy)');

const identityAdapter = createRuntimeIdentityAdapter();

const identCtx = identityAdapter.resolve('demo-user', 'tenant-acme', {
  roles: ['tenant_user'],
});
info('resolved identity.id', identCtx.identity.id);
info('resolved identity.roles', (identCtx.identity.roles ?? []).join(', '));

// ─────────────────────────────────────────────────────────────────────────────

section('10. Cache slot (in-process shared response cache)');

const cacheStore = weaveInMemoryCacheStore();
const cacheAdapter = createRuntimeCacheAdapter(cacheStore);

await cacheAdapter.set('warm-greeting', 'Hello from the cache!', 60_000);
const cacheHit = await cacheAdapter.get('warm-greeting');
info('cache hit', String(cacheHit));

// ─────────────────────────────────────────────────────────────────────────────
// 2. Build the full runtime with all slots
// ─────────────────────────────────────────────────────────────────────────────

section('Building full WeaveRuntime');

const runtime = weaveRuntime({
  // ── Secrets ───────────────────────────────────────────────────────────────
  // envSecretResolver is the default — process.env is searched automatically.
  // Uncomment to add a hardcoded fallback layer:
  // secrets: chainSecretResolvers(inMemorySecretResolver({ OPENAI_API_KEY }), envSecretResolver()),

  // ── Persistence ──────────────────────────────────────────────────────────
  persistence,

  // ── Resilience ────────────────────────────────────────────────────────────
  resilience: resilienceAdapter,

  // ── Guardrails ────────────────────────────────────────────────────────────
  guardrails: guardrailsSlot,

  // ── Encryption ────────────────────────────────────────────────────────────
  encryption: encryptionSlot,

  // ── Routing ───────────────────────────────────────────────────────────────
  routing: routingAdapter,

  // ── Cost ──────────────────────────────────────────────────────────────────
  cost: costAdapter,

  // ── Memory ────────────────────────────────────────────────────────────────
  memory: memoryAdapter,

  // ── Compliance ────────────────────────────────────────────────────────────
  compliance: complianceAdapter,

  // ── Identity ──────────────────────────────────────────────────────────────
  identity: identityAdapter,

  // ── Cache ─────────────────────────────────────────────────────────────────
  cache: cacheAdapter,

  // ── Tracer ────────────────────────────────────────────────────────────────
  installDefaultTracer: true,   // installs console tracer as process default
  tlsFloor: false,              // allow http:// targets in dev
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Capability audit — verify all slots are advertised
// ─────────────────────────────────────────────────────────────────────────────

section('Capability audit');

const caps = describeRuntimeCapabilities(runtime);
info('total capabilities', caps.length);
console.log();

const EXPECTED: Array<[string, (typeof RuntimeCapabilities)[keyof typeof RuntimeCapabilities]]> = [
  ['NetEgress',    RuntimeCapabilities.NetEgress],
  ['Observability',RuntimeCapabilities.Observability],
  ['Secrets',      RuntimeCapabilities.Secrets],
  ['Audit',        RuntimeCapabilities.Audit],
  ['Persistence',  RuntimeCapabilities.Persistence],
  ['Resilience',   RuntimeCapabilities.Resilience],
  ['Guardrails',   RuntimeCapabilities.Guardrails],
  ['Encryption',   RuntimeCapabilities.Encryption],
  ['Routing',      RuntimeCapabilities.Routing],
  ['Cost',         RuntimeCapabilities.Cost],
  ['Memory',       RuntimeCapabilities.Memory],
  ['Compliance',   RuntimeCapabilities.Compliance],
  ['Identity',     RuntimeCapabilities.Identity],
  ['Cache',        RuntimeCapabilities.Cache],
];

let allPresent = true;
for (const [name, cap] of EXPECTED) {
  const present = runtime.has(cap);
  check(`${name.padEnd(14)} (${cap})`, present);
  if (!present) allPresent = false;
}

console.log();
if (!allPresent) {
  console.error(`\x1b[31m✗  One or more capabilities missing — check slot wiring above.\x1b[0m`);
  process.exit(1);
}
console.log(`${GREEN}${BOLD}All 14 capabilities present.${RESET}`);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Build an ExecutionContext that carries the runtime
// ─────────────────────────────────────────────────────────────────────────────

section('ExecutionContext');

const ctx: ExecutionContext = weaveContext({
  runtime,
  userId: 'demo-user',
  tenantId: 'tenant-acme',
  executionId: 'e2e-example-run-1',
});

info('ctx.userId',      ctx.userId);
info('ctx.tenantId',    ctx.tenantId);
info('ctx.executionId', ctx.executionId);
info('ctx.runtime?.has(Audit)', ctx.runtime?.has(RuntimeCapabilities.Audit));

// ─────────────────────────────────────────────────────────────────────────────
// 5. Emit an audit entry through the runtime (Audit slot)
// ─────────────────────────────────────────────────────────────────────────────

section('Audit slot');

await weaveAudit(ctx, {
  action: 'e2e.example.start',
  outcome: 'success',
  resource: 'example-148',
  details: { capabilities: caps.length },
});
info('weaveAudit()', 'emitted — no error thrown');

// ─────────────────────────────────────────────────────────────────────────────
// 6. Seed semantic memory with a fact (Memory slot — store path)
// ─────────────────────────────────────────────────────────────────────────────

section('Memory slot — semantic store');

await runtime.memory!.semantic.store(
  ctx,
  'WeaveIntel is an AI orchestration platform built for enterprise.',
  { source: 'e2e-example', confidence: 1.0 },
);
info('semantic.store()', 'stored successfully');

// ─────────────────────────────────────────────────────────────────────────────
// 7. Pre-check: gate the user before any spend (Cost slot)
// ─────────────────────────────────────────────────────────────────────────────

section('Cost slot — pre-run gate');

const gate = await runtime.cost!.gate({ userId: ctx.userId!, tenantId: ctx.tenantId! });
check(`gate allowed (budget: $10)`, gate.allowed);
if (!gate.allowed) {
  console.error('Cost gate denied — aborting.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Identity slot — resolve + evaluate
// ─────────────────────────────────────────────────────────────────────────────

section('Identity slot — RBAC');

const resolvedId = runtime.identity!.resolve(ctx.userId!, ctx.tenantId!);
info('resolved roles', (resolvedId.identity.roles ?? []).join(', '));
info('effectivePermissions', resolvedId.effectivePermissions.slice(0, 4).join(', ') + '...');

const chatSendDecision = runtime.identity!.evaluate(resolvedId, 'chat', 'send');
check('tenant_user can chat:send', chatSendDecision.result === 'allow');

// ─────────────────────────────────────────────────────────────────────────────
// 9. Compliance slot — consent + residency
// ─────────────────────────────────────────────────────────────────────────────

section('Compliance slot');

const analyticsOk = await runtime.compliance!.isAllowed(ctx.userId!, 'analytics');
check('isAllowed(analytics) — consent granted', analyticsOk);

const canProcess = await runtime.compliance!.canProcess(ctx.tenantId!, 'pii', 'eu-west-1');
// No residency rules seeded → fail-open (true)
check('canProcess(pii, eu-west-1) — fail-open', canProcess);

// ─────────────────────────────────────────────────────────────────────────────
// 10. Routing slot — record a fake outcome + check health
// ─────────────────────────────────────────────────────────────────────────────

section('Routing slot');

runtime.routing!.recordOutcome('gpt-4o', 'openai', 210, true);
runtime.routing!.recordOutcome('gpt-4o', 'openai', 180, true);
runtime.routing!.recordOutcome('gpt-4o-mini', 'openai', 95,  true);

const healthList = runtime.routing!.listHealth();
info('health records', healthList.length);
for (const h of healthList) {
  info(`  ${h.modelId}`, `p50=${h.latencyP50?.toFixed(0) ?? '—'}ms  healthy=${h.healthy}`);
}
check('supportsMultiModal', runtime.routing!.supportsMultiModal?.() === true);

// ─────────────────────────────────────────────────────────────────────────────
// 11. Cache slot — warm-up and hit
// ─────────────────────────────────────────────────────────────────────────────

section('Cache slot');

const CACHE_KEY = 'demo:greeting';
await runtime.cache!.set(CACHE_KEY, '👋 Cached greeting from weaveRuntime!');
const hit = await runtime.cache!.get(CACHE_KEY);
check('cache.set → get round-trips', hit === '👋 Cached greeting from weaveRuntime!');
info('cached value', String(hit));

await runtime.cache!.invalidate(CACHE_KEY);
const afterInvalidate = await runtime.cache!.get(CACHE_KEY);
check('cache.invalidate clears entry', afterInvalidate == null);

// ─────────────────────────────────────────────────────────────────────────────
// 12. Build the agent with a tool that exercises the runtime via ctx
// ─────────────────────────────────────────────────────────────────────────────

section('12. weaveAgent — build');

// A custom tool that reads from the runtime's cache and writes an audit entry.
const runtimeInspectTool = weaveTool({
  name: 'runtime_inspect',
  description:
    'Reads a value from the shared runtime cache and reports the active ' +
    'capability count. Use this to verify the runtime is wired correctly.',
  parameters: {
    type: 'object' as const,
    properties: {
      cacheKey: {
        type: 'string',
        description: 'Key to look up in the runtime cache.',
      },
    },
    required: [],
  },
  execute: async (args: { cacheKey?: string }, toolCtx: ExecutionContext) => {
    const key = args.cacheKey ?? 'demo:greeting';
    const cached = await toolCtx.runtime?.cache?.get(key);
    const capCount = toolCtx.runtime ? describeRuntimeCapabilities(toolCtx.runtime).length : 0;

    await weaveAudit(toolCtx, {
      action: 'tool.runtime_inspect.called',
      outcome: 'success',
      resource: key,
      details: { capCount, cacheHit: cached != null },
    });

    return JSON.stringify({
      cacheKey: key,
      cachedValue: cached ?? null,
      capabilityCount: capCount,
      supportsMultiModal: toolCtx.runtime?.routing?.supportsMultiModal?.() ?? false,
    });
  },
});

const tools = weaveToolRegistry({ tools: [runtimeInspectTool] });

// gpt-4o is used here because gpt-4o-mini sometimes describes tool calls
// as text rather than invoking them. For a production scenario where
// cost matters, gpt-4o-mini works fine when guardrail output scanning
// ensures the response doesn't mention tool-call syntax without executing it.
const chatModel = weaveOpenAIModel('gpt-4o', { apiKey: OPENAI_API_KEY });

const agent = weaveAgent({
  model: chatModel,
  tools,
  name: 'runtime-demo-agent',
  // Be explicit: the model must call the tool in the first step,
  // then report what the tool returned. gpt-4o-mini without explicit
  // instruction sometimes describes what it would do rather than doing it.
  systemPrompt:
    'You are a runtime inspector. You MUST immediately call the runtime_inspect ' +
    'tool to answer any question. Do not guess or describe — call the tool first, ' +
    'then report the exact values the tool returned.',
  maxSteps: 5,
});

info('agent type', typeof agent.run);

// ─────────────────────────────────────────────────────────────────────────────
// 13. Pre-seed the cache so the tool can find a value
// ─────────────────────────────────────────────────────────────────────────────

await runtime.cache!.set('demo:greeting', 'Hello from the shared runtime cache!');

// ─────────────────────────────────────────────────────────────────────────────
// 14. Run the agent — real LLM call
// ─────────────────────────────────────────────────────────────────────────────

section('14. weaveAgent — run (real LLM call)');
console.log(`  ${DIM}Model: gpt-4o | Key: ${OPENAI_API_KEY.slice(0, 8)}...${RESET}`);
console.log();

const agentResult = await agent.run(ctx, {
  messages: [
    {
      role: 'user',
      content:
        'Please call runtime_inspect with cacheKey="demo:greeting" and tell me: ' +
        '(1) what the cached value is, (2) how many capabilities are wired, ' +
        '(3) whether multi-modal routing is supported.',
    },
  ],
});

console.log();
section('Agent result');
info('status',          agentResult.status);
info('steps',           agentResult.steps?.length ?? 0);
info('promptTokens',    agentResult.usage?.promptTokens);
info('completionTokens',agentResult.usage?.completionTokens);
info('toolCalls',       agentResult.usage?.toolCalls);
console.log();
console.log(`  ${BOLD}Final response:${RESET}`);
// agentResult.output is the final text string from the agent
console.log(`  ${YELLOW}${agentResult.output}${RESET}`);

// ─────────────────────────────────────────────────────────────────────────────
// 15. Record token cost in the cost ledger (Cost slot — record path)
// ─────────────────────────────────────────────────────────────────────────────

section('15. Cost slot — record spend after run');

if (agentResult.usage) {
  const { promptTokens = 0, completionTokens = 0 } = agentResult.usage;
  // gpt-4o pricing: $2.50/1M input, $10.00/1M output (as of 2025)
  const costUsd = (promptTokens * 0.0000025) + (completionTokens * 0.00001);

  await runtime.cost!.record({
    userId: ctx.userId!,
    tenantId: ctx.tenantId ?? null,
    model: 'gpt-4o',
    provider: 'openai',
    promptTokens,
    completionTokens,
    costUsd,
  });

  // entityKey mirrors the adapter's logic: tenantId takes priority over userId
  const entityKey = ctx.tenantId ?? ctx.userId!;
  const budget = await runtime.cost!.getBudgetStatus(entityKey);
  info('spend recorded (USD)', costUsd.toFixed(6));
  info('total used (USD)',     budget.used.toFixed(6));
  info('limit (USD)',          budget.limit?.toFixed(2) ?? 'none');
  check('within $10 limit', budget.used < 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. Recall from semantic memory (Memory slot — recall path)
// ─────────────────────────────────────────────────────────────────────────────

section('16. Memory slot — semantic recall');

const recalled = await runtime.memory!.semantic.recall(ctx, 'AI orchestration platform', 3);
info('entries recalled', recalled.length);
for (const entry of recalled) {
  info(`  content`, entry.content.slice(0, 80));
}
check('semantic recall found the seeded fact', recalled.length > 0);

// ─────────────────────────────────────────────────────────────────────────────
// 17. Working memory (Memory slot — patch / checkpoint / restore)
// ─────────────────────────────────────────────────────────────────────────────

section('17. Memory slot — working memory');

const AGENT_ID = ctx.executionId ?? 'demo-agent';
await runtime.memory!.working.patch(ctx, AGENT_ID, [
  { op: 'set', key: 'lastAgentStatus', value: agentResult.status },
  { op: 'set', key: 'promptTokens',    value: agentResult.usage?.promptTokens ?? 0 },
]);
const snapshot = await runtime.memory!.working.checkpoint(ctx, AGENT_ID);
info('checkpoint agentId', snapshot.agentId);
info('checkpoint content keys', Object.keys(snapshot.content).join(', '));
check('working memory patch → checkpoint', snapshot.content['lastAgentStatus'] === agentResult.status);

// ─────────────────────────────────────────────────────────────────────────────
// 18. Guardrails slot — exercise checkInput / checkOutput
// ─────────────────────────────────────────────────────────────────────────────

section('18. Guardrails slot — manual exercise');

const inputCheck = await runtime.guardrails!.checkInput!(ctx, 'tell me something safe');
check('safe input → allow', inputCheck.allow);

const blockedCheck = await runtime.guardrails!.checkInput!(ctx, 'say BLOCKED_WORD now');
check('blocked input → deny', !blockedCheck.allow);
info('block reason', blockedCheck.reason ?? '—');

const outputCheck = await runtime.guardrails!.checkOutput!(ctx, 'Normal text REDACT_THIS more text');
check('output scan ran', scannedOutputs > 0);
check('output redacted', outputCheck.redactedText?.includes('[REDACTED]') === true);
info('redacted text', outputCheck.redactedText ?? '—');

// ─────────────────────────────────────────────────────────────────────────────
// 19. Resilience slot — emit a latency signal
// ─────────────────────────────────────────────────────────────────────────────

section('19. Resilience slot — emit signal');

runtime.resilience!.emit({
  kind: 'http_call',
  endpoint: 'openai.api',
  meta: { latencyMs: 234, status: 200 },
});
info('signal emitted', 'kind=http_call endpoint=openai.api');

// ─────────────────────────────────────────────────────────────────────────────
// 20. Encryption slot — inspect state
// ─────────────────────────────────────────────────────────────────────────────

section('20. Encryption slot — inspect');

check('slot kind is set', runtime.encryption!.kind === 'demo-stub');
// Not active because no VAULT_KEY — expected in this demo
check('isActive false (no VAULT_KEY in demo)', !runtime.encryption!.isActive());
info(
  'note',
  'wire geneweaveEncryptionSlot() + TenantKeyManager with VAULT_KEY for production',
);

// ─────────────────────────────────────────────────────────────────────────────
// 21. Persistence slot — raw KV round-trip
// ─────────────────────────────────────────────────────────────────────────────

section('21. Persistence slot — raw KV');

await runtime.persistence!.kv.set('e2e:ping', 'pong', { ttlMs: 60_000 });
const kvVal = await runtime.persistence!.kv.get('e2e:ping');
check('kv.set → get round-trips', kvVal === 'pong');
info('kv value', kvVal ?? '—');

// ─────────────────────────────────────────────────────────────────────────────
// 22. Compliance slot — requestErasure
// ─────────────────────────────────────────────────────────────────────────────

section('22. Compliance slot — erasure request');

const erasure = await runtime.compliance!.requestErasure(
  ctx.userId!,
  ctx.userId!,
  'user requested account deletion via e2e example',
);
info('erasure id',     erasure.id);
info('erasure status', erasure.status);
check('erasure created', typeof erasure.id === 'string');

// ─────────────────────────────────────────────────────────────────────────────
// 23. Final capability re-check
// ─────────────────────────────────────────────────────────────────────────────

section('Final capability re-check');
let passing = 0;
for (const [name, cap] of EXPECTED) {
  if (runtime.has(cap)) passing++;
  check(name, runtime.has(cap));
}

console.log();
if (passing === EXPECTED.length) {
  console.log(`${GREEN}${BOLD}✓  All ${passing} / ${EXPECTED.length} capabilities exercised end-to-end.${RESET}`);
} else {
  console.error(`\x1b[31m✗  Only ${passing} / ${EXPECTED.length} capabilities confirmed.\x1b[0m`);
  process.exit(1);
}

console.log(`\n${DIM}Guardrail counters — blockedInputs=${blockedInputs}  blockedToolCalls=${blockedToolCalls}  scannedOutputs=${scannedOutputs}${RESET}`);
console.log(`\n${GREEN}Example 148 complete.${RESET}\n`);
