/**
 * Use Case: Multi-Tenant SaaS Platform
 *
 * Demonstrates how a multi-tenant AI platform enforces per-tenant:
 *   • Feature entitlements  (which capabilities each tier can access)
 *   • Budget limits         (daily token / cost ceilings)
 *   • Configuration         (per-tenant model settings and overrides)
 *   • PII encryption        (each tenant's messages encrypted with their own key)
 *   • Cost tracking         (per-tenant spend ledger)
 *
 * This is the pattern used when you build an AI product on top of WeaveIntel
 * and need to isolate tenants from each other at the data, cost, and policy
 * layer simultaneously.
 *
 * ─── Packages used ──────────────────────────────────────────────────────────
 *   @weaveintel/tenancy
 *     • createConfigResolver    — 4-layer config override (global→org→tenant→user)
 *     • createOverrideLayer     — one layer in the config stack
 *     • createGlobalScope       — scope for global defaults
 *     • createTenantScope       — scope for per-tenant overrides
 *     • createEntitlementStore  — which features each tenant is entitled to
 *     • createEntitlementPolicy — PolicyRule that gates feature/model access
 *     • createBudgetEnforcer    — daily/monthly token + cost budget enforcement
 *
 *   @weaveintel/encryption
 *     • LocalKmsProvider        — in-process AES-256-GCM key wrapping
 *     • weaveTenantKeyManager   — per-tenant key hierarchy (KEK → DEK)
 *     • maybeEncryptField       — encrypt PII columns on write
 *     • maybeDecryptField       — decrypt PII columns on read
 *     • DEFAULT_FIELD_POLICY    — which columns are PII by default
 *     • isEncrypted             — detect enc:v1: sentinel
 *
 *   @weaveintel/cost-governor
 *     • createInMemoryCostLedger — per-tenant spend tracking
 *     • computeUsd               — calculate cost from token usage + pricing rate
 *
 * ─── Local helpers (NOT from any @weaveintel package) ───────────────────────
 *   InMemoryEncryptionStore — implements EncryptionStore for the example.
 *     In production this is geneweave's SQLite adapter.
 *
 *   simulateAgentRun() — stub that pretends to run an LLM and produce tokens.
 *     In production this is your actual LLM call, wired through a provider.
 *
 *   TENANT_CONFIGS / TIER_ENTITLEMENTS — fixture data describing the three
 *     tenants and their tier settings. In production these come from your
 *     database / admin UI.
 *
 *   header() / section() / ok() / info() / warn() — console helpers.
 *
 * Run: npx tsx examples/use-cases/multi-tenant-saas.ts
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

/* ── Tenancy ─────────────────────────────────────────────────────────────── */
import {
  createConfigResolver,
  createOverrideLayer,
  createGlobalScope,
  createTenantScope,
  createEntitlementStore,
  createEntitlementPolicy,
  createBudgetEnforcer,
} from '@weaveintel/identity/tenancy';

/* ── Encryption ──────────────────────────────────────────────────────────── */
import {
  LocalKmsProvider,
  weaveTenantKeyManager,
  noopAuditEmitter,
  DEFAULT_FIELD_POLICY,
  maybeEncryptField,
  maybeDecryptField,
  isEncrypted,
  type EncryptionStore,
  type TenantPolicyRecord,
  type KekRecord,
  type DekRecord,
  type BikRecord,
  type KeyStatus,
  type TenantEncryptionState,
} from '@weaveintel/encryption';

/* ── Cost Governor ───────────────────────────────────────────────────────── */
import {
  createInMemoryCostLedger,
  computeUsd,
} from '@weaveintel/cost-governor';

/* ─── Console helpers (LOCAL) ────────────────────────────────────────────── */
const BOLD  = '\x1b[1m';
const GREEN = '\x1b[32m';
const CYAN  = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED   = '\x1b[31m';
const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';

function header(t: string) {
  console.log(`\n${BOLD}${'═'.repeat(66)}${RESET}`);
  console.log(`${BOLD}  ${t}${RESET}`);
  console.log(`${BOLD}${'═'.repeat(66)}${RESET}`);
}
function section(t: string) { console.log(`\n${CYAN}  ── ${t} ──${RESET}`); }
function ok(m: string)   { console.log(`${GREEN}  ✓${RESET} ${m}`); }
function info(m: string) { console.log(`${DIM}  ℹ ${m}${RESET}`); }
function warn(m: string) { console.log(`${YELLOW}  ⚠${RESET} ${m}`); }

/* ─── InMemoryEncryptionStore (LOCAL — not from any package) ────────────── */
// The package defines EncryptionStore but doesn't ship a bundled impl.
// In production this is geneweave's SQLite adapter.

class InMemoryEncryptionStore implements EncryptionStore {
  policy: TenantPolicyRecord | null = null;
  keks: KekRecord[] = [];
  deks: DekRecord[] = [];
  biks: BikRecord[] = [];
  async getPolicy(_t: string) { return this.policy; }
  async upsertPolicy(p: TenantPolicyRecord) { this.policy = p; }
  async listKeks() { return [...this.keks]; }
  async insertKek(k: KekRecord) { this.keks.push(k); }
  async updateKekStatus(id: string, s: KeyStatus, ts: number) {
    this.keks = this.keks.map(k => k.id === id ? { ...k, status: s, rotatedAt: s === 'previous' ? ts : k.rotatedAt, revokedAt: s === 'revoked' ? ts : k.revokedAt } : k);
  }
  async listDeks() { return [...this.deks]; }
  async insertDek(d: DekRecord) { this.deks.push(d); }
  async updateDekStatus(id: string, s: KeyStatus, ts: number) {
    this.deks = this.deks.map(d => d.id === id ? { ...d, status: s, rotatedAt: s === 'previous' ? ts : d.rotatedAt, revokedAt: s === 'revoked' ? ts : d.revokedAt } : d);
  }
  async listBiks() { return [...this.biks]; }
  async insertBik(b: BikRecord) { this.biks.push(b); }
  async updateBikStatus(id: string, s: KeyStatus, ts: number) {
    this.biks = this.biks.map(b => b.id === id ? { ...b, status: s, revokedAt: s === 'revoked' ? ts : b.revokedAt } : b);
  }
  async deletePolicy() { this.policy = null; }
  async deleteAllWrappedMaterial() {
    const counts = { keks: this.keks.length, deks: this.deks.length, biks: this.biks.length };
    this.keks = []; this.deks = []; this.biks = [];
    return counts;
  }
}

/* ─── Fixture tenant definitions (LOCAL) ────────────────────────────────── */
// In production these come from your database / admin UI / Stripe webhook.

const TENANTS = {
  'starter-corp': { tier: 'starter', orgId: 'org-1' },
  'pro-corp':     { tier: 'pro',     orgId: 'org-2' },
  'enterprise-corp': { tier: 'enterprise', orgId: 'org-3' },
} as const;

type TenantId = keyof typeof TENANTS;

// Tier entitlements: which features are available per tier
const TIER_ENTITLEMENTS: Record<string, { features: string[]; allowedModels: string[] }> = {
  starter:    { features: ['chat', 'basic-rag'],                         allowedModels: ['claude-haiku-4-5-20251001'] },
  pro:        { features: ['chat', 'basic-rag', 'advanced-rag', 'skills'], allowedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'] },
  enterprise: { features: ['chat', 'basic-rag', 'advanced-rag', 'skills', 'workflows', 'live-agents'], allowedModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'] },
};

// Budget limits per tier (daily)
const TIER_BUDGETS: Record<string, { maxTokens: number; maxCostUsd: number }> = {
  starter:    { maxTokens: 100_000,   maxCostUsd: 1.00 },
  pro:        { maxTokens: 1_000_000, maxCostUsd: 10.00 },
  enterprise: { maxTokens: 10_000_000, maxCostUsd: 200.00 },
};

// Anthropic pricing (dollars per million tokens, simplified)
// In production use the actual pricing tables from each provider.
const PRICING: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.80,  outputPerMillion: 4.00 },
  'claude-sonnet-4-6':         { inputPerMillion: 3.00,  outputPerMillion: 15.00 },
  'claude-opus-4-7':           { inputPerMillion: 15.00, outputPerMillion: 75.00 },
};

/* ─── simulateAgentRun (LOCAL — not from any package) ───────────────────── */
// Pretends to call an LLM and returns synthetic token counts.
// In production this is your provider call (wrapModelWithCostLedger wraps it).

function simulateAgentRun(model: string, inputMsg: string): {
  response: string;
  inputTokens: number;
  outputTokens: number;
} {
  // Rough approximation: 1 token ≈ 4 characters
  const inputTokens  = Math.ceil(inputMsg.length / 4);
  const outputTokens = Math.ceil(inputMsg.length / 8); // shorter response
  return {
    response:    `[${model}] Processed: "${inputMsg.slice(0, 30)}…"`,
    inputTokens,
    outputTokens,
  };
}

/* ══════════════════════════════════════════════════════════════════════════ */
/*  MAIN                                                                       */
/* ══════════════════════════════════════════════════════════════════════════ */

async function main() {
  header('Use Case: Multi-Tenant SaaS Platform');

  /* ────────────────────────────────────────────────────────────────────────
   * 1. Tenancy — Config resolver with 4-layer override
   *
   * The config stack resolves settings from most-specific (user) to least
   * (global). This lets platform operators set global defaults while tenants
   * override specific keys and end-users override their own settings.
   *
   *   global    → platform-wide defaults (max_tokens, temperature, …)
   *   org       → organization-level overrides (compliance settings, …)
   *   tenant    → per-tenant overrides (custom model, custom persona, …)
   *   user      → per-user preferences (language, response style, …)
   * ────────────────────────────────────────────────────────────────────────*/
  section('1 — Config resolver (4-layer override)');

  const config = createConfigResolver();

  // Global defaults — apply to all tenants and users
  const globalScope = createGlobalScope();
  config.addLayer(createOverrideLayer(globalScope, {
    'model':          'claude-haiku-4-5-20251001',  // cheapest by default
    'temperature':    0.7,
    'max_tokens':     2048,
    'stream':         true,
    'system_prompt':  'You are a helpful AI assistant.',
  }));

  // Enterprise tenant overrides — they pay for the flagship model
  const entScopeForConfig = createTenantScope('enterprise-corp', 'org-3');
  config.addLayer(createOverrideLayer(entScopeForConfig, {
    'model':          'claude-opus-4-7',
    'max_tokens':     8192,
    'system_prompt':  'You are an expert enterprise AI assistant with extended context.',
  }));

  // Starter tenant stays at global defaults — no override needed

  // Resolve effective config for each tenant
  const starterConfig  = config.getEffectiveConfig(createTenantScope('starter-corp',     'org-1'));
  const entConfig      = config.getEffectiveConfig(createTenantScope('enterprise-corp',  'org-3'));

  assert.equal(starterConfig['model'],    'claude-haiku-4-5-20251001', 'starter uses default model');
  assert.equal(entConfig['model'],        'claude-opus-4-7',           'enterprise has model override');
  assert.equal(starterConfig['temperature'], 0.7, 'global defaults propagate to all tenants');

  ok(`starter-corp  model: ${starterConfig['model']}`);
  ok(`enterprise-corp model: ${entConfig['model']}`);
  ok(`Both see global temperature: ${entConfig['temperature']}`);
  info('Tenant overrides win, global defaults fill in missing keys');

  /* ────────────────────────────────────────────────────────────────────────
   * 2. Tenancy — Entitlement store + policy (feature gating)
   *
   * Each tenant has a set of entitlements that determine which features and
   * models they can access. This is enforced by the EntitlementPolicy — a
   * PolicyRule that hooks into the platform's policy evaluation pipeline.
   *
   * In production you evaluate this policy on every agent tick or API call.
   * ────────────────────────────────────────────────────────────────────────*/
  section('2 — Entitlement store and feature gating');

  const entitlements = createEntitlementStore();

  // Seed entitlements for each tenant from tier definitions
  for (const [tenantId, t] of Object.entries(TENANTS)) {
    const tier = TIER_ENTITLEMENTS[t.tier]!;
    entitlements.set({
      tenantId,
      features:      new Set(tier.features),
      allowedModels: tier.allowedModels,
    });
  }

  // createEntitlementPolicy returns a PolicyRule that can be added to any
  // policy evaluator in the platform.
  const entitlementPolicy = createEntitlementPolicy(entitlements);
  ok(`Entitlement policy created: "${entitlementPolicy.name}"`);

  // Simulate policy checks for each tenant
  type PolicyCtx = Parameters<typeof entitlementPolicy.evaluate>[0];
  type PolicyInput = Parameters<typeof entitlementPolicy.evaluate>[1];

  async function checkFeature(tenantId: string, feature: string) {
    const ctx: PolicyCtx = { tenantId } as unknown as PolicyCtx;
    const input: PolicyInput = { action: 'use_feature', resource: feature } as unknown as PolicyInput;
    return entitlementPolicy.evaluate(ctx, input);
  }

  async function checkModel(tenantId: string, model: string) {
    const ctx: PolicyCtx = { tenantId } as unknown as PolicyCtx;
    const input: PolicyInput = { action: 'use_model', resource: model } as unknown as PolicyInput;
    return entitlementPolicy.evaluate(ctx, input);
  }

  // Starter — can use 'chat' but not 'workflows'
  const starterChat      = await checkFeature('starter-corp', 'chat');
  const starterWorkflows = await checkFeature('starter-corp', 'workflows');
  assert.ok(starterChat.allowed,      'starter can use chat');
  assert.ok(!starterWorkflows.allowed, 'starter cannot use workflows (enterprise only)');
  ok(`starter-corp  chat=✓  workflows=✗  (${starterWorkflows.reason})`);

  // Enterprise — can use all features
  const entWorkflows = await checkFeature('enterprise-corp', 'workflows');
  const entAgents    = await checkFeature('enterprise-corp', 'live-agents');
  assert.ok(entWorkflows.allowed, 'enterprise can use workflows');
  assert.ok(entAgents.allowed,    'enterprise can use live-agents');
  ok(`enterprise-corp  workflows=✓  live-agents=✓`);

  // Model access control — pro cannot use claude-opus
  const proSonnet = await checkModel('pro-corp', 'claude-sonnet-4-6');
  const proOpus   = await checkModel('pro-corp', 'claude-opus-4-7');
  assert.ok(proSonnet.allowed,  'pro can use sonnet');
  assert.ok(!proOpus.allowed,   'pro cannot use opus');
  ok(`pro-corp  sonnet=✓  opus=✗  (${proOpus.reason})`);

  /* ────────────────────────────────────────────────────────────────────────
   * 3. Tenancy — Budget enforcer
   *
   * BudgetEnforcer tracks token usage and USD cost per tenant per period
   * (daily / monthly). Before each run, call checkBudget() — if it returns
   * allowed=false, reject the request with an HTTP 429.
   *
   * After each run, call recordUsage() with the actual token counts.
   * ────────────────────────────────────────────────────────────────────────*/
  section('3 — Budget enforcer');

  const budget = createBudgetEnforcer();

  // Set daily budgets for each tenant based on tier
  for (const [tenantId, t] of Object.entries(TENANTS)) {
    const limits = TIER_BUDGETS[t.tier]!;
    budget.setBudget({
      tenantId,
      daily:   { maxTokens: limits.maxTokens,       maxCostUsd: limits.maxCostUsd, maxSteps: 1000, maxRuns: 100 },
      monthly: { maxTokens: limits.maxTokens * 30,  maxCostUsd: limits.maxCostUsd * 30, maxSteps: 30_000, maxRuns: 3_000 },
    });
  }

  // Simulate a run for starter-corp and check the budget passes
  const starterBefore = budget.checkBudget('starter-corp');
  assert.ok(starterBefore.allowed, 'starter should start with budget available');
  ok(`starter-corp pre-run budget check: allowed=${starterBefore.allowed}`);

  // Record some usage (100K tokens would exhaust the starter daily budget)
  budget.recordUsage('starter-corp', 99_000, 0.08, 5);
  const starterAfter = budget.checkBudget('starter-corp');
  assert.ok(starterAfter.allowed, 'starter still under daily token limit at 99k/100k');
  ok(`After 99k tokens: starter still allowed (99k/100k used)`);

  // One more run that pushes past the daily limit
  budget.recordUsage('starter-corp', 5_000, 0.004, 1);
  const starterExceeded = budget.checkBudget('starter-corp');
  assert.ok(!starterExceeded.allowed, 'starter should now be over budget');
  warn(`starter-corp BLOCKED: ${starterExceeded.reason}`);

  // Enterprise has much higher limits — not affected
  const entBudget = budget.checkBudget('enterprise-corp');
  assert.ok(entBudget.allowed, 'enterprise still has plenty of budget');
  ok(`enterprise-corp: still allowed (${TIER_BUDGETS['enterprise']!.maxTokens.toLocaleString()} token daily cap)`);

  /* ────────────────────────────────────────────────────────────────────────
   * 4. Encryption — Per-tenant PII encryption
   *
   * Each tenant's messages are encrypted with their own DEK (derived from a
   * shared master key but cryptographically isolated). A compromised DB dump
   * exposes only opaque ciphertext — the master key is required to decrypt.
   *
   * This section shows the complete write-then-read cycle for a user message.
   * ────────────────────────────────────────────────────────────────────────*/
  section('4 — Per-tenant PII encryption');

  // One LocalKmsProvider serves all tenants — the key hierarchy isolates them.
  // Each tenant gets its own KEK and DEK; they cannot decrypt each other's data.
  const masterKey = randomBytes(32);
  const kms       = new LocalKmsProvider({ masterKey });

  // Each tenant needs its own EncryptionStore (or separate policy rows in a shared one).
  // Here we use a store per tenant for clarity.
  const encStores: Record<string, InMemoryEncryptionStore> = {};
  const km = weaveTenantKeyManager({ kms, store: new InMemoryEncryptionStore(), audit: noopAuditEmitter });

  for (const tenantId of Object.keys(TENANTS) as TenantId[]) {
    const store = new InMemoryEncryptionStore();
    encStores[tenantId] = store;
    // Each tenant gets its own key manager backed by its own store.
    // In production all tenants share one store (differentiated by tenantId rows).
    const tenantKm = weaveTenantKeyManager({ kms, store, audit: noopAuditEmitter });
    await tenantKm.bootstrapTenant({ tenantId, enable: true });
    ok(`Bootstrapped encryption for ${tenantId}`);
  }

  // Write a user message for pro-corp — encrypt the content field
  const PRO_TENANT = 'pro-corp';
  const proStore   = encStores[PRO_TENANT]!;
  const proKm      = weaveTenantKeyManager({ kms, store: proStore, audit: noopAuditEmitter });
  await proKm.bootstrapTenant({ tenantId: PRO_TENANT, enable: true }); // idempotent

  const messageContent = 'Please summarize my credit card bill for 4111-1111-1111-1111';
  const rowId          = 'msg-001';

  const proPolicyRecord = await proStore.getPolicy(PRO_TENANT);
  const proState: TenantEncryptionState = {
    manager:  proKm,
    tenantId: PRO_TENANT,
    enabled:  proPolicyRecord?.enabled ?? false,
    policy:   DEFAULT_FIELD_POLICY,
  };

  // Encrypt on write — messages.content is in DEFAULT_FIELD_POLICY
  const encryptedContent = await maybeEncryptField(
    proState,
    { table: 'messages', column: 'content', rowId },
    messageContent,
  );
  assert.ok(isEncrypted(encryptedContent!), 'message content should be encrypted');
  ok(`pro-corp message encrypted: ${encryptedContent!.slice(0, 40)}…`);
  info('Credit card number is unreadable in the DB — only enc:v1: sentinel visible');

  // Decrypt on read — only pro-corp's keys can decrypt this
  const decryptedContent = await maybeDecryptField(
    proState,
    { table: 'messages', column: 'content', rowId },
    encryptedContent!,
  );
  assert.equal(decryptedContent, messageContent, 'should decrypt back to original');
  ok(`pro-corp message decrypted: "${decryptedContent!.slice(0, 50)}"`);

  // Prove isolation: enterprise-corp's key manager cannot decrypt pro-corp's data
  const entStore = encStores['enterprise-corp']!;
  const entKm    = weaveTenantKeyManager({ kms, store: entStore, audit: noopAuditEmitter });
  await entKm.bootstrapTenant({ tenantId: 'enterprise-corp', enable: true });

  let crossTenantFailed = false;
  try {
    // enterprise-corp's manager sees a different DEK — AAD mismatch will cause decryption failure
    await entKm.decrypt({
      tenantId: 'enterprise-corp',
      table: 'messages', column: 'content', rowId,
      value: encryptedContent!,
    });
  } catch {
    crossTenantFailed = true;
  }
  assert.ok(crossTenantFailed, 'cross-tenant decryption must fail');
  ok(`Cross-tenant isolation verified: enterprise-corp cannot decrypt pro-corp's data`);

  /* ────────────────────────────────────────────────────────────────────────
   * 5. Cost Governor — Per-tenant spend tracking
   *
   * createInMemoryCostLedger() accumulates per-run cost entries. Each entry
   * records: runId, source ('model' | 'tool'), model name, token counts, and
   * USD cost. The breakdown() method rolls up spend by lever, model, and agent.
   *
   * In production, use weaveCostLedger with a DB sink so entries survive
   * restarts and can be queried for billing.
   * ────────────────────────────────────────────────────────────────────────*/
  section('5 — Cost tracking with the cost ledger');

  // One shared ledger accumulates all tenants' runs. The runId carries the
  // tenant context; breakdown() scopes to a specific runId.
  const ledger = createInMemoryCostLedger();

  // Simulate three agent runs — one per tenant, different models
  for (const [tenantId, t] of Object.entries(TENANTS)) {
    const model    = TIER_ENTITLEMENTS[t.tier]!.allowedModels.at(-1)!; // use highest model
    const pricing  = PRICING[model]!;
    const userMsg  = `Analyze the latest market data for ${tenantId} and produce a summary.`;
    const runId    = `run-${tenantId}-001`;

    // simulateAgentRun is LOCAL — in production this is your LLM provider call
    const result = simulateAgentRun(model, userMsg);

    // computeUsd calculates cost from token counts and pricing rates
    const costUsd = computeUsd(
      { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      { inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion },
    );

    // Record the cost entry in the ledger
    await ledger.record({
      id:           `entry-${tenantId}-001`,
      runId,
      source:       'model',
      lever:        'model',
      subject:      model,
      inputTokens:  result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd,
      observedAt:   Date.now(),
      metadata:     { tenantId },
    });

    const total = await ledger.total(runId);
    ok(`${tenantId.padEnd(20)} model=${model.slice(-10)}  tokens=${result.inputTokens + result.outputTokens}  cost=$${costUsd.toFixed(4)}`);
  }

  // Get a breakdown for one run to see the per-lever rollup
  const runId      = 'run-enterprise-corp-001';
  const breakdown  = await ledger.breakdown(runId);
  assert.ok(breakdown.totalUsd > 0, 'breakdown should have a positive cost');

  ok(`enterprise-corp run breakdown: total=$${breakdown.totalUsd.toFixed(4)}`);
  ok(`  by lever: model=$${breakdown.byLever.model.toFixed(4)} tool=$${breakdown.byLever.tool.toFixed(4)}`);
  ok(`  input tokens: ${breakdown.tokens.input}  output tokens: ${breakdown.tokens.output}`);

  /* ────────────────────────────────────────────────────────────────────────
   * 6. Full request pipeline — all pieces together
   *
   * This section shows what a real tenant request looks like when all four
   * layers are applied in sequence:
   *   1. Check entitlement   — can this tenant use the requested feature?
   *   2. Check budget        — does the tenant have tokens left today?
   *   3. Encrypt message     — PII encrypted before DB write
   *   4. Run LLM             — (simulated here; real in with-llm/ examples)
   *   5. Record cost         — track spend against the ledger
   *   6. Decrypt response    — PII decrypted for API response
   * ────────────────────────────────────────────────────────────────────────*/
  section('6 — Full request pipeline (all layers combined)');

  async function handleRequest(tenantId: TenantId, feature: string, userMessage: string, runId: string) {
    const tier  = TENANTS[tenantId].tier;
    const model = TIER_ENTITLEMENTS[tier]!.allowedModels.at(-1)!;

    // Step 1: entitlement check
    const ctx   = { tenantId } as unknown as Parameters<typeof entitlementPolicy.evaluate>[0];
    const input = { action: 'use_feature', resource: feature } as unknown as Parameters<typeof entitlementPolicy.evaluate>[1];
    const entResult = await entitlementPolicy.evaluate(ctx, input);
    if (!entResult.allowed) {
      warn(`[${tenantId}] DENIED feature="${feature}": ${entResult.reason}`);
      return null;
    }

    // Step 2: budget check
    const budgetResult = budget.checkBudget(tenantId);
    if (!budgetResult.allowed) {
      warn(`[${tenantId}] BUDGET EXCEEDED: ${budgetResult.reason}`);
      return null;
    }

    // Step 3: encrypt user message before DB write
    const tStore   = encStores[tenantId] ?? new InMemoryEncryptionStore();
    const tPolicy  = await tStore.getPolicy(tenantId);
    const tKm      = weaveTenantKeyManager({ kms, store: tStore, audit: noopAuditEmitter });
    const tState: TenantEncryptionState = {
      manager: tKm, tenantId,
      enabled: tPolicy?.enabled ?? false,
      policy:  DEFAULT_FIELD_POLICY,
    };

    const encMsg = await maybeEncryptField(tState, { table: 'messages', column: 'content', rowId: runId }, userMessage);

    // Step 4: "call LLM" (simulated — real provider call in with-llm/ examples)
    const result = simulateAgentRun(model, userMessage);

    // Step 5: record cost
    const pricing = PRICING[model]!;
    const costUsd = computeUsd(
      { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      { inputPerMillion: pricing.inputPerMillion, outputPerMillion: pricing.outputPerMillion },
    );
    await ledger.record({
      id: `entry-${tenantId}-pipeline`, runId, source: 'model', lever: 'model',
      subject: model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      costUsd, observedAt: Date.now(),
    });
    budget.recordUsage(tenantId, result.inputTokens + result.outputTokens, costUsd, 1);

    // Step 6: the response content would also be encrypted at rest in production
    return { response: result.response, model, costUsd, encryptedAtRest: isEncrypted(encMsg!) };
  }

  // pro-corp runs a RAG request (entitled) — should succeed
  const proResult = await handleRequest('pro-corp', 'advanced-rag', 'What is our Q4 revenue?', 'run-pro-pipeline-001');
  assert.ok(proResult, 'pro-corp request should succeed');
  ok(`pro-corp advanced-rag: success  model=${proResult!.model}  cost=$${proResult!.costUsd.toFixed(4)}  encrypted=${proResult!.encryptedAtRest}`);

  // starter-corp requests 'workflows' — denied by entitlement policy
  const starterResult = await handleRequest('starter-corp', 'workflows', 'Build a pipeline', 'run-starter-pipeline-001');
  assert.equal(starterResult, null, 'starter should be denied workflows feature');

  // starter-corp requests 'chat' — but they exceeded their budget in step 3
  const starterChat2 = await handleRequest('starter-corp', 'chat', 'Hello!', 'run-starter-chat-002');
  assert.equal(starterChat2, null, 'starter should be blocked by budget');

  /* ─── Summary ──────────────────────────────────────────────────────────── */
  header('All checks passed');
  console.log(`
  What this use case showed:
    1.  Config resolver   — 4-layer override (global → org → tenant → user)
    2.  Entitlement store — per-tier feature and model access control
    3.  Budget enforcer   — daily token + cost ceilings per tenant
    4.  Encryption        — per-tenant PII encryption, cross-tenant isolation
    5.  Cost ledger       — per-run spend tracking with per-lever breakdown
    6.  Full pipeline     — entitlement → budget → encrypt → LLM → cost → decrypt

  Packages: @weaveintel/tenancy · @weaveintel/encryption · @weaveintel/cost-governor
  `);
}

main().catch(err => { console.error(err); process.exit(1); });
