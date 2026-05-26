/**
 * Example 112 — Multi-Tenant Configuration, Entitlements, Capability Maps & Budgets
 *
 * Runs entirely in-memory. No API keys, no external services, no LLM calls.
 *
 * The problem @weaveintel/tenancy solves
 * ──────────────────────────────────────
 * When an AI platform serves many customers (tenants) from a single codebase,
 * you need principled answers to several distinct questions:
 *
 *   1. CONFIGURATION — how do different customers get different settings?
 *      e.g. org A uses GPT-4o while org B uses Claude Sonnet; a specific
 *      user inside org B overrides back to GPT-4o for their own requests.
 *      Solution: a layered config resolver with global → org → tenant → user
 *      precedence, so each layer can override the one above it.
 *
 *   2. ENTITLEMENTS — which features and models is a tenant allowed to use?
 *      e.g. a free-tier tenant can run "summarise" but not "image-gen"; a
 *      premium tenant can use claude-opus but a free tenant cannot.
 *      Solution: an EntitlementStore + PolicyRule that plugs into any policy
 *      evaluation chain.
 *
 *   3. CAPABILITY MAPS — a fast lookup table of allowed models & tools per
 *      tenant that is checked on every run dispatch, without hitting the DB.
 *      Solution: an in-process TenantCapabilityMap with O(1) lookups.
 *
 *   4. BUDGETS — guard against runaway costs. Set daily/monthly token and
 *      dollar ceilings; record every run's consumption; block new runs when
 *      limits are hit; reset at period boundaries.
 *      Solution: a TenantBudgetEnforcer with cumulative usage tracking.
 *
 * Packages used:
 *   @weaveintel/tenancy — createConfigResolver, createOverrideLayer,
 *     createGlobalScope, createTenantScope, createUserScope,
 *     createEntitlementStore, createEntitlementPolicy,
 *     createCapabilityMap, createBudgetEnforcer
 *
 * No API keys needed — all logic runs in-process.
 *
 * Run: npx tsx examples/112-tenancy.ts
 */

import {
  // Config resolution
  createConfigResolver,
  createOverrideLayer,
  createGlobalScope,
  createTenantScope,
  createUserScope,
  // Entitlements
  createEntitlementStore,
  createEntitlementPolicy,
  // Capability maps
  createCapabilityMap,
  // Budget enforcement
  createBudgetEnforcer,
  // Types (imported as types only — no runtime cost)
  type TenantEntitlement,
} from '@weaveintel/tenancy';

// weaveContext (re-exported as that alias from @weaveintel/core) is needed to
// build the ExecutionContext that EntitlementPolicy.evaluate() receives —
// it reads ctx.tenantId to look up the right TenantEntitlement.
import { weaveContext } from '@weaveintel/core';

/* ─── Section header helper ──────────────────────────────────────────────── */

function header(title: string): void {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(64));
}

function ok(msg: string): void   { console.log(`  ✓ ${msg}`); }
function info(msg: string): void { console.log(`  ℹ ${msg}`); }
function fail(msg: string): void { console.log(`  ✗ ${msg}`); }

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 1 — Config resolver: layered overrides with scope precedence
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateConfigResolver(): Promise<void> {
  header('1. Config Resolver — Layered Scope Overrides');

  // createConfigResolver() holds an ordered list of OverrideLayers.
  // When you call resolve(key, scope) it walks layers from the broadest
  // (global) to the narrowest (user) and returns the last match,
  // giving the most-specific scope the highest precedence.
  const resolver = createConfigResolver();

  // --- 1a. Build scopes -------------------------------------------------
  // createGlobalScope() produces {level:'global', id:'global'}.
  // These scope objects are used both as keys when adding layers and as
  // context when resolving — the resolver filters layers to those that
  // are applicable to the requested scope's ancestry.
  const globalScope = createGlobalScope();

  // createTenantScope(tenantId, orgId?) places this layer at 'tenant' level.
  // The optional orgId becomes parentId, allowing org-level layers to be
  // inherited by tenants in that org.
  const tenantAcmeScope = createTenantScope('tenant-acme', 'org-northstar');
  const tenantBetaScope = createTenantScope('tenant-beta');

  // createUserScope(userId, tenantId) places a layer at 'user' level,
  // inheriting from the named tenant.
  const userAliceScope = createUserScope('user-alice', 'tenant-acme');

  // --- 1b. Register layers in the resolver ------------------------------
  // createOverrideLayer(scope, entries) wraps a plain object as an
  // immutable ReadonlyMap keyed on the scope. The resolver uses entries
  // to look up individual config keys.

  // Global defaults — the fallback for every tenant and user.
  resolver.addLayer(createOverrideLayer(globalScope, {
    'model':           'claude-haiku-3',   // cheapest model by default
    'max_tokens':      1024,
    'temperature':     0.7,
    'streaming':       false,
    'log_level':       'warn',
  }));

  // Tenant-Acme overrides — Acme pays for a better model and more tokens.
  resolver.addLayer(createOverrideLayer(tenantAcmeScope, {
    'model':           'claude-sonnet-4',
    'max_tokens':      4096,
    'log_level':       'info',
  }));

  // Tenant-Beta overrides — Beta just changes the log level.
  resolver.addLayer(createOverrideLayer(tenantBetaScope, {
    'log_level':       'debug',
  }));

  // User-Alice override — Alice is a power user who forces Opus + streaming.
  resolver.addLayer(createOverrideLayer(userAliceScope, {
    'model':           'claude-opus-4',
    'streaming':       true,
    'temperature':     0.2,
  }));

  // --- 1c. resolve() for a user-scoped request --------------------------
  // When Alice makes a request, we resolve her config.
  // Precedence: user > tenant > global (higher-specificity wins).
  const aliceModel       = resolver.resolve<string>('model',       userAliceScope);
  const aliceMaxTokens   = resolver.resolve<number>('max_tokens',  userAliceScope);
  const aliceStreaming   = resolver.resolve<boolean>('streaming',  userAliceScope);
  const aliceTemp        = resolver.resolve<number>('temperature', userAliceScope);
  const aliceLog         = resolver.resolve<string>('log_level',  userAliceScope);

  info(`Alice — model:       ${aliceModel}    (user override beats tenant's claude-sonnet-4)`);
  info(`Alice — max_tokens:  ${aliceMaxTokens}     (inherited from tenant-acme, not global 1024)`);
  info(`Alice — streaming:   ${aliceStreaming}       (user override beats global false)`);
  info(`Alice — temperature: ${aliceTemp}       (user override beats global 0.7)`);
  info(`Alice — log_level:   ${aliceLog}        (inherited from tenant-acme)`);

  if (aliceModel !== 'claude-opus-4') throw new Error('Expected user override to win for model');
  if (aliceMaxTokens !== 4096) throw new Error('Expected tenant override to be inherited for max_tokens');
  ok('User scope correctly shadows tenant and global values');

  // --- 1d. getEffectiveConfig() for a tenant ----------------------------
  // getEffectiveConfig() returns every key visible from a given scope as a
  // plain object — useful for serialising tenant settings to a UI or audit log.
  const acmeConfig = resolver.getEffectiveConfig(tenantAcmeScope);
  info(`Acme effective config keys: ${Object.keys(acmeConfig).join(', ')}`);
  if (acmeConfig['model'] !== 'claude-sonnet-4') throw new Error('Unexpected acme model');
  ok('getEffectiveConfig() returns merged view for tenant-acme');

  // Beta never set a model, so it inherits from global.
  const betaConfig = resolver.getEffectiveConfig(tenantBetaScope);
  if (betaConfig['model'] !== 'claude-haiku-3') throw new Error('Beta should inherit global model');
  ok('Tenant-beta inherits global model (no tenant override present)');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 2 — Entitlement store + policy: feature & model gating
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateEntitlements(): Promise<void> {
  header('2. Entitlement Store + Policy — Feature & Model Gating');

  // createEntitlementStore() is a simple in-memory Map keyed by tenantId.
  // Each TenantEntitlement defines which features and models a tenant may use.
  const store = createEntitlementStore();

  // Free-tier tenant: limited to "summarise" feature; only haiku model allowed.
  const freeTier: TenantEntitlement = {
    tenantId:      'tenant-free',
    features:      new Set(['summarise', 'search']),
    allowedModels: ['claude-haiku-3'],
    maxModels:     1,
  };

  // Premium tenant: a richer feature set; a denied-models list instead of
  // an allowlist, so everything is allowed except the listed model.
  const premiumTier: TenantEntitlement = {
    tenantId:      'tenant-premium',
    features:      new Set(['summarise', 'search', 'image-gen', 'code-review', 'analytics']),
    deniedModels:  ['deprecated-gpt-3'],   // only model they cannot use
    maxModels:     10,
  };

  // Store both entitlements.
  store.set(freeTier);
  store.set(premiumTier);

  ok(`Stored ${store.list().length} tenant entitlements`);

  // createEntitlementPolicy() wraps the store as a PolicyRule that the
  // central policy evaluator (or any custom runner) can call with an
  // ExecutionContext + PolicyInput.
  const policy = createEntitlementPolicy(store);
  info(`Policy name: "${policy.name}" — "${policy.description}"`);

  // Build execution contexts that carry tenantId so the policy can
  // look up the right entitlement.
  const freeCtx    = weaveContext({ tenantId: 'tenant-free',    metadata: {} });
  const premiumCtx = weaveContext({ tenantId: 'tenant-premium', metadata: {} });

  // 2a. Free tenant uses a feature they HAVE → allowed.
  const r1 = await policy.evaluate(freeCtx, { action: 'use_feature', resource: 'search' });
  if (!r1.allowed) throw new Error('free tenant should be allowed to use "search"');
  ok(`free  + "search"    → allowed (${r1.reason})`);

  // 2b. Free tenant uses a feature they DON'T have → denied.
  const r2 = await policy.evaluate(freeCtx, { action: 'use_feature', resource: 'image-gen' });
  if (r2.allowed) throw new Error('free tenant should be denied "image-gen"');
  fail(`free  + "image-gen" → denied  (${r2.reason})`);

  // 2c. Free tenant uses their one allowed model → allowed.
  const r3 = await policy.evaluate(freeCtx, { action: 'use_model', resource: 'claude-haiku-3' });
  if (!r3.allowed) throw new Error('free tenant should be allowed their allowed model');
  ok(`free  + haiku        → allowed (${r3.reason})`);

  // 2d. Free tenant attempts to use a model not in their allowedModels → denied.
  const r4 = await policy.evaluate(freeCtx, { action: 'use_model', resource: 'claude-opus-4' });
  if (r4.allowed) throw new Error('free tenant should be denied claude-opus-4');
  fail(`free  + opus         → denied  (${r4.reason})`);

  // 2e. Premium tenant uses their explicitly-denied model → denied.
  const r5 = await policy.evaluate(premiumCtx, { action: 'use_model', resource: 'deprecated-gpt-3' });
  if (r5.allowed) throw new Error('premium tenant should be denied the deprecated model');
  fail(`prem  + deprecated-gpt-3 → denied (${r5.reason})`);

  // 2f. Premium tenant uses any other model → allowed (no allowlist constraint).
  const r6 = await policy.evaluate(premiumCtx, { action: 'use_model', resource: 'claude-opus-4' });
  if (!r6.allowed) throw new Error('premium tenant should be allowed opus');
  ok(`prem  + opus         → allowed (${r6.reason})`);

  ok('Entitlement policy correctly gates features and models by tier');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 3 — Capability map: fast per-tenant model & tool allowlists
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateCapabilityMap(): Promise<void> {
  header('3. Capability Map — Per-Tenant Model & Tool Allowlists');

  // createCapabilityMap() is a fast in-memory store designed for high-frequency
  // lookups at run-dispatch time (before hitting any policy engine).
  // Each TenantCapability records which models and tools a tenant may use,
  // how many concurrent runs they can have, and which features are active.
  const capMap = createCapabilityMap();

  // Starter tenant — minimal toolset, single model.
  capMap.set({
    tenantId:           'tenant-starter',
    models:             ['claude-haiku-3'],
    tools:              ['web_search', 'calculator'],
    maxConcurrentRuns:  2,
    features:           ['basic-chat'],
  });

  // Enterprise tenant — broad access.
  capMap.set({
    tenantId:           'tenant-enterprise',
    models:             ['claude-haiku-3', 'claude-sonnet-4', 'claude-opus-4', 'gpt-4o'],
    tools:              ['web_search', 'calculator', 'code_exec', 'file_read', 'sql_query', 'email_send'],
    maxConcurrentRuns:  50,
    features:           ['basic-chat', 'analytics', 'code-review', 'image-gen'],
  });

  ok(`Registered ${capMap.list().length} capability entries`);

  // isModelAllowed() — O(1) check before dispatching a run.
  // Returns false for unknown tenants or models not in their list.
  const starterHaiku    = capMap.isModelAllowed('tenant-starter',     'claude-haiku-3');
  const starterOpus     = capMap.isModelAllowed('tenant-starter',     'claude-opus-4');
  const enterpriseOpus  = capMap.isModelAllowed('tenant-enterprise',  'claude-opus-4');
  const unknownTenant   = capMap.isModelAllowed('tenant-ghost',       'claude-haiku-3');

  info(`starter  + haiku:      ${starterHaiku}  (in their models list)`);
  info(`starter  + opus:       ${starterOpus} (not in their models list)`);
  info(`enterprise + opus:     ${enterpriseOpus}  (enterprise has full access)`);
  info(`unknown  + haiku:      ${unknownTenant} (no entry for this tenant)`);

  if (!starterHaiku)   throw new Error('starter should be allowed haiku');
  if (starterOpus)     throw new Error('starter should NOT be allowed opus');
  if (!enterpriseOpus) throw new Error('enterprise should be allowed opus');
  if (unknownTenant)   throw new Error('ghost tenant should return false');
  ok('isModelAllowed() returns correct results');

  // isToolAllowed() — same pattern for tools.
  const starterSql      = capMap.isToolAllowed('tenant-starter',    'sql_query');
  const enterpriseSql   = capMap.isToolAllowed('tenant-enterprise', 'sql_query');
  info(`starter  + sql_query:  ${starterSql} (not in their tools list)`);
  info(`enterprise + sql_query: ${enterpriseSql}  (enterprise has it)`);
  if (starterSql)     throw new Error('starter should not have sql_query');
  if (!enterpriseSql) throw new Error('enterprise should have sql_query');
  ok('isToolAllowed() correctly gates tool access');

  // getAvailableModels() / getAvailableTools() — return the full list for
  // display in a tenant settings UI or for populating a run config dropdown.
  const starterModels   = capMap.getAvailableModels('tenant-starter');
  const entModels       = capMap.getAvailableModels('tenant-enterprise');
  info(`starter  available models: [${starterModels.join(', ')}]`);
  info(`enterprise available models: [${entModels.join(', ')}]`);

  const starterTools    = capMap.getAvailableTools('tenant-starter');
  info(`starter  available tools:  [${starterTools.join(', ')}]`);

  ok('getAvailableModels() / getAvailableTools() return full capability lists');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SECTION 4 — Budget enforcer: daily & monthly spend limits
   ═══════════════════════════════════════════════════════════════════════════ */

async function demonstrateBudgetEnforcer(): Promise<void> {
  header('4. Budget Enforcer — Daily & Monthly Spend Limits');

  // createBudgetEnforcer() maintains two stores:
  //   budgets — the configured ceilings per tenant
  //   usage   — the accumulated consumption per tenant × period
  // On every run completion, call recordUsage(); before dispatching a new
  // run, call checkBudget() to gate it.
  const enforcer = createBudgetEnforcer();

  // Set a budget with tight daily limits and generous monthly limits.
  // TenantBudget.daily and .monthly are ExecutionBudget objects that can
  // cap tokens, dollars, steps, or duration.
  enforcer.setBudget({
    tenantId: 'tenant-constrained',
    daily: {
      maxTokens:  50_000,    // 50 K tokens per day
      maxCostUsd: 5.00,      // $5 per day
    },
    monthly: {
      maxTokens:  1_000_000, // 1 M tokens per month
      maxCostUsd: 50.00,     // $50 per month
    },
  });

  ok(`Budget set for "tenant-constrained"`);

  // --- 4a. Record usage: three small runs within daily limits ----------------
  // recordUsage(tenantId, tokens, costUsd, steps) accumulates into both
  // daily and monthly buckets simultaneously.
  enforcer.recordUsage('tenant-constrained', 10_000, 1.00, 5);
  enforcer.recordUsage('tenant-constrained', 12_000, 1.20, 8);
  enforcer.recordUsage('tenant-constrained', 8_000,  0.80, 4);
  // Cumulative: 30 000 tokens, $3.00 cost, 17 steps, 3 runs

  const usageAfterThree = enforcer.getUsage('tenant-constrained', 'daily');
  info(`After 3 runs — tokens: ${usageAfterThree?.tokens}, cost: $${usageAfterThree?.costUsd?.toFixed(2)}, runs: ${usageAfterThree?.runs}`);

  // --- 4b. checkBudget() within limits → allowed -------------------------
  // checkBudget() reads both daily and monthly usage and compares each
  // against the configured ceilings. Returns {allowed:true} if all clear.
  const checkOk = enforcer.checkBudget('tenant-constrained');
  info(`Budget check (within limits): allowed=${checkOk.allowed}`);
  if (!checkOk.allowed) throw new Error('Should be within budget');
  ok('Budget check passed while within daily and monthly limits');

  // --- 4c. Record enough usage to exceed the daily token ceiling ----------
  // After this call, cumulative daily tokens exceed 50 000.
  enforcer.recordUsage('tenant-constrained', 25_000, 1.00, 10);
  // Cumulative: 55 000 tokens, $4.00 cost — daily token limit (50 K) breached

  const checkExceeded = enforcer.checkBudget('tenant-constrained');
  info(`Budget check (exceeded): allowed=${checkExceeded.allowed}, reason="${checkExceeded.reason}"`);
  if (checkExceeded.allowed) throw new Error('Should be over budget');
  fail(`Budget exceeded: ${checkExceeded.reason}`);
  ok('Budget check correctly blocked when daily token ceiling is breached');

  // --- 4d. resetPeriod() clears usage for a fresh period -----------------
  // Called by a nightly scheduler to open up capacity for the new day.
  // Only resets the named period; monthly accumulation is preserved.
  enforcer.resetPeriod('tenant-constrained', 'daily');

  const afterReset = enforcer.getUsage('tenant-constrained', 'daily');
  info(`After daily reset — daily usage: ${afterReset === undefined ? 'cleared' : afterReset.tokens + ' tokens'}`);
  if (afterReset !== undefined) throw new Error('Daily usage should be cleared after reset');

  // Now the check should pass again (daily bucket is fresh).
  const checkAfterReset = enforcer.checkBudget('tenant-constrained');
  info(`Budget check after reset: allowed=${checkAfterReset.allowed}`);
  if (!checkAfterReset.allowed) throw new Error('Should be within budget after reset');
  ok('resetPeriod() cleared daily bucket; budget check now passes again');

  // Verify monthly bucket was NOT cleared.
  const monthlyUsage = enforcer.getUsage('tenant-constrained', 'monthly');
  info(`Monthly usage still accumulated: ${monthlyUsage?.tokens} tokens`);
  if (!monthlyUsage || monthlyUsage.tokens < 50_000) {
    throw new Error('Monthly usage should still reflect all runs');
  }
  ok('Monthly bucket untouched by daily reset');

  // --- 4e. listBudgets() — show configured budgets ----------------------
  const budgets = enforcer.listBudgets();
  info(`Total budgets configured: ${budgets.length}`);
  ok('listBudgets() returns all registered budgets');
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN
   ═══════════════════════════════════════════════════════════════════════════ */

async function main(): Promise<void> {
  console.log('\n@weaveintel/tenancy — Example 112');
  console.log('Multi-tenant config, entitlements, capability maps & budgets');

  await demonstrateConfigResolver();
  await demonstrateEntitlements();
  await demonstrateCapabilityMap();
  await demonstrateBudgetEnforcer();

  header('All sections complete');
  console.log('  ✓ Config resolver: layered override precedence verified');
  console.log('  ✓ Entitlement policy: feature and model gating verified');
  console.log('  ✓ Capability map: model and tool allowlist lookups verified');
  console.log('  ✓ Budget enforcer: usage tracking and limit blocking verified');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
