/**
 * @weaveintel/geneweave — Public API
 *
 * The single entry-point for consumers. Install the package, call
 * `createGeneWeave(config)`, and you have a running chat + dashboard server.
 *
 * @example
 * ```ts
 * import { createGeneWeave } from '@weaveintel/geneweave';
 *
 * const app = await createGeneWeave({
 *   port: 3000,
 *   jwtSecret: process.env.JWT_SECRET!,
 *   database: { type: 'sqlite', path: './geneweave.db' },
 *   providers: {
 *     anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
 *   },
 *   defaultModel: 'claude-sonnet-4-6',
 *   defaultProvider: 'anthropic',
 * });
 *
 * console.log(`geneWeave running → http://localhost:${app.port}`);
 * ```
 */

import type { Server } from 'node:http';
import { weaveSetDefaultTracer, weaveRuntime, envSecretResolver, weaveInMemoryPersistence, type WeaveRuntime, type RuntimePersistenceSlot } from '@weaveintel/core';
import { weaveConsoleTracer } from '@weaveintel/observability';
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveRedactor } from '@weaveintel/redaction';
import { createDatabaseAdapter, type DatabaseAdapter, type DatabaseConfig } from './db.js';
import { ChatEngine, type ProviderConfig } from './chat.js';
import { createGeneWeaveServer } from './server.js';
import { syncModelPricing, type PricingSyncReport } from './pricing-sync.js';
import { syncToolCatalog } from './tools.js';
import { BUILTIN_TOOLS, setWorkflowEngineForTools } from './tools.js';
import {
  createGeneweaveWorkflowEngine,
  syncWorkflowHandlerKindsToDb,
  type WorkflowEngineHandle,
} from './workflow-engine.js';
import { startToolHealthJob } from './tool-health-job.js';
import {
  createTriggerDispatcher,
  createDurableTriggerRateLimiter,
  ManualSourceAdapter,
  MeshContractSourceAdapter,
  WebhookOutTargetAdapter,
  type TriggerDispatcher,
} from '@weaveintel/triggers';
import { OAuthClient, createDurableOAuthStateStore } from '@weaveintel/oauth';
import { setOAuthClient } from './server-core.js';
import { createDbTriggerStore } from './triggers/db-trigger-store.js';
import { createWorkflowTargetAdapter, createContractTargetAdapter } from './triggers/target-adapters.js';
import { DbContractEmitter } from './contracts/db-contract-emitter.js';
import { EventEmitter } from 'node:events';
import { applyDbResilienceObserver } from './db-resilience-observer.js';
import { startRoutingRegressionJob } from './routing-feedback.js';
import { registerMCPGatewayInCatalog, loadGatewayConfigFromCatalog } from './mcp-gateway.js';
import { applySeed } from './seed/index.js';
import {
  initHandlerRegistry,
  syncHandlerKindsToDb,
} from './live-agents/handler-registry-boot.js';
import { startKaggleHeartbeat, type KaggleHeartbeatHandle } from './live-agents/kaggle/heartbeat-runner.js';
import { startGenericSupervisorIfEnabled } from './live-agents/generic-supervisor-boot.js';
import type { HeartbeatSupervisorHandle } from '@weaveintel/live-agents-runtime';

export type { PricingSyncReport };

// ─── Config ──────────────────────────────────────────────────

export interface GeneWeaveConfig {
  /** Port to listen on (default: 3500) */
  port?: number;
  /** Host to bind (default: '0.0.0.0') */
  host?: string;
  /** Secret for signing JWT tokens — MUST be a strong random string in production */
  jwtSecret: string;
  /** Database config — defaults to SQLite at ./geneweave.db */
  database?: DatabaseConfig;
  /** Provider API keys keyed by provider name */
  providers: Record<string, ProviderConfig>;
  /** Default provider key (must match a key in providers) */
  defaultProvider: string;
  /** Default model ID to use */
  defaultModel: string;
  /** CORS origin — set to your frontend URL in production */
  corsOrigin?: string;
  /** Absolute public origin used for OAuth callbacks when behind a proxy */
  publicBaseUrl?: string;
}

// ─── App handle ──────────────────────────────────────────────

export interface GeneWeaveApp {
  /** The port the server is listening on */
  port: number;
  /** Underlying Node.js HTTP server */
  server: Server;
  /** Database adapter (for advanced use / testing) */
  db: DatabaseAdapter;
  /** Chat engine (for programmatic use) */
  chatEngine: ChatEngine;
  /**
   * Ambient cross-cutting runtime constructed at boot (Phase 2). Carries
   * the hardened egress client, tracer, secret resolver, audit logger, and
   * (when configured) persistence/resilience slots. Pass this into any
   * `ExecutionContext` derived from this app so features inherit one
   * coherent set of cross-cutting concerns.
   */
  runtime: WeaveRuntime;
  /**
   * Workflow engine handle: registry, run repository, checkpoint store,
   * cost meter, and span emitter. Phase B exposes this so consumers and
   * tests can introspect cost totals (durable when runtime persistence is
   * configured) without reaching into server internals.
   */
  workflows: WorkflowEngineHandle;
  /** Sync model pricing from provider APIs into the database */
  syncPricing(): Promise<PricingSyncReport>;
  /** Gracefully stop the server and close the database */
  stop(): Promise<void>;
}

// ─── Factory ─────────────────────────────────────────────────

/**
 * Module-level handle to the per-tenant encryption key manager. Set during
 * `createGeneWeave()` boot when `WEAVE_ENCRYPTION_MASTER_KEY` is available;
 * stays `null` otherwise. Phase 3 consumer integration (chat/sv encrypted
 * columns) reads this lazily so encryption is opt-in per deployment.
 */
import type {
  CachedKmsResolver,
  InMemoryMetricsEmitter,
  KmsProviderRegistry,
  MetricsEmitter,
  TenantKeyManager,
} from '@weaveintel/encryption';
import { withTenantEncryptedMessages } from './encryption/db-encrypted-adapter.js';
import { geneweaveGuardrailsSlot } from './guardrails-slot.js';
import { resolveLimits } from './platform-limits.js';
import {
  getGuardrailJudgeModel, setActiveGuardrailJudgeModel,
  getGuardrailModerationModel, setActiveGuardrailModerationModel,
  getGuardrailEmbeddingModel, setActiveGuardrailEmbeddingModel,
} from './guardrail-judge.js';
import { geneweaveEncryptionSlot, type GeneweaveEncryptionSlot } from './encryption-slot.js';
export let geneweaveEncryptionManager: TenantKeyManager | null = null;
/** Phase 7: KMS provider registry exposed for admin endpoints (list/health-check). */
export let geneweaveKmsRegistry: KmsProviderRegistry | null = null;
/** Phase 7: per-tenant KMS resolver exposed so admin code can invalidate cache on policy edits. */
export let geneweaveKmsResolver: CachedKmsResolver | null = null;
/** Phase 9: metrics emitter wired into the manager + resolver. Exposed so admin
 * observability endpoints can read its `snapshot()` (when it's the in-memory
 * default) without coupling to a singleton. */
export let geneweaveEncryptionMetrics: (MetricsEmitter & { snapshot?: InMemoryMetricsEmitter['snapshot'] }) | null = null;

/**
 * createGeneWeave() is the single entry-point for the entire application.
 * It wires together all WeaveIntel subsystems in order:
 *
 *  1. Database — SQLite adapter for persistence (users, sessions, chats, metrics)
 *  2. ChatEngine — orchestrates @weaveintel/models, @weaveintel/agents,
 *     @weaveintel/observability, @weaveintel/redaction, @weaveintel/evals,
 *     @weaveintel/guardrails, @weaveintel/routing, and @weaveintel/cache
 *  3. seedDefaultData — creates admin user and default settings on first run
 *  4. HTTP Server — zero-dependency router with auth, CORS, SSE streaming
 *  5. Returns a GeneWeaveApp handle with stop() for graceful shutdown
 */
export async function createGeneWeave(config: GeneWeaveConfig): Promise<GeneWeaveApp> {
  // Validate critical env vars at boot; throws on fatal misconfigurations.
  const { validateEnv } = await import('./env-validation.js');
  const envResult = validateEnv({ jwtSecret: config.jwtSecret });
  for (const warning of envResult.warnings) {
    console.warn(warning);
  }

  // Construct exactly one ambient runtime for this app. Every feature that
  // needs egress / tracing / secrets / audit pulls them from here — no
  // call site reconstructs them. `weaveSetDefaultTracer` is kept for
  // back-compat with packages that read the process-wide default; the
  // runtime tracer is the same instance so the two never disagree.
  const consoleTracer = weaveConsoleTracer();

  // Phase A: durable persistence slot. When the configured database is
  // SQLite we share its path so the runtime KV table (`runtime_kv`) lives
  // alongside the app's other tables and survives restarts. For custom
  // adapters (Postgres / Mongo / etc.) we fall back to the in-memory slot
  // — adopters can override by supplying their own runtime in future.
  const dbConfig = config.database ?? { type: 'sqlite' as const, path: './geneweave.db' };
  const persistenceSlot: RuntimePersistenceSlot = dbConfig.type === 'sqlite'
    ? weaveSqlitePersistence({ path: dbConfig.path ?? './geneweave.db' })
    : weaveInMemoryPersistence();

  // Phase A: default redactor with built-in PII patterns. Wired into the
  // runtime so the auto-attached durable audit logger redacts entries
  // before they hit the KV store — no call site needs to opt in.
  const defaultRedactor = weaveRedactor({
    patterns: [
      { name: 'email', type: 'builtin', builtinType: 'email' },
      { name: 'phone', type: 'builtin', builtinType: 'phone' },
      { name: 'ssn', type: 'builtin', builtinType: 'ssn' },
      { name: 'credit_card', type: 'builtin', builtinType: 'credit_card' },
    ],
    reversible: false,
  });

  // Phase E: build the database adapter BEFORE the runtime so the
  // ambient guardrails slot can close over it. The slot reads enabled
  // rows from the `guardrails` table on each call, so operator edits
  // take effect without restart. Encryption wrapper still uses the
  // module-level live binding (assigned later in this function).
  const rawDb = await createDatabaseAdapter(config.database ?? { type: 'sqlite', path: './geneweave.db' });
  const db = withTenantEncryptedMessages(rawDb, () => geneweaveEncryptionManager);

  // Resolve the guardrail judge model once at boot. Uses a cheap/fast model
  // (claude-haiku or gpt-4o-mini) by default, or GUARDRAIL_JUDGE_MODEL env var.
  // Stored as a mutable ref so it can be lazily replaced without restarting.
  // Resolve the guardrail judge model. Sets the module-level singleton so
  // chat-guardrail-eval-utils.ts picks it up without threading through deps.
  const guardrailJudgeModel = await getGuardrailJudgeModel({
    providers: config.providers,
    defaultProvider: config.defaultProvider,
    defaultModel: config.defaultModel,
  }).catch(() => undefined);
  setActiveGuardrailJudgeModel(guardrailJudgeModel);
  if (guardrailJudgeModel) {
    console.log(`[guardrails] judge model ready — ${guardrailJudgeModel.info.provider}:${guardrailJudgeModel.info.modelId}`);
  } else {
    console.log('[guardrails] no judge model available — model-graded checks will skip (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  }

  // R2: Moderation model — OpenAI omni-moderation-latest
  const guardrailModerationModel = await getGuardrailModerationModel(config.providers).catch(() => undefined);
  setActiveGuardrailModerationModel(guardrailModerationModel);
  if (guardrailModerationModel) {
    console.log('[guardrails] moderation model ready — openai:omni-moderation-latest');
  } else {
    console.log('[guardrails] no moderation model — content moderation check will skip (set OPENAI_API_KEY)');
  }

  // R3: Embedding model — OpenAI text-embedding-3-small for semantic grounding
  const guardrailEmbeddingModel = await getGuardrailEmbeddingModel(config.providers).catch(() => undefined);
  setActiveGuardrailEmbeddingModel(guardrailEmbeddingModel);
  if (guardrailEmbeddingModel) {
    console.log('[guardrails] embedding model ready — openai:text-embedding-3-small (semantic grounding active)');
  } else {
    console.log('[guardrails] no embedding model — semantic grounding will use lexical fallback (set OPENAI_API_KEY)');
  }

  const startupLimits = await resolveLimits(db);
  const guardrailsSlot = geneweaveGuardrailsSlot(db, {
    getModel: () => guardrailJudgeModel,
    getModerationModel: () => guardrailModerationModel,
    getEmbeddingModel: () => guardrailEmbeddingModel,
    maxActionLen: startupLimits.guardrail_action_max_chars,
  });

  // Phase F: encryption slot with a mutable internal ref. Constructed BEFORE
  // the runtime so `runtime.has('runtime.encryption')` advertises at boot;
  // the underlying TenantKeyManager is assigned post-bootstrap below.
  // Consumers retrieve the live manager via `ctx.runtime?.encryption?.getManager()`.
  const encryptionSlot: GeneweaveEncryptionSlot = geneweaveEncryptionSlot();

  const runtime = weaveRuntime({
    tracer: consoleTracer,
    secrets: envSecretResolver(),
    persistence: persistenceSlot,
    redactor: defaultRedactor,
    guardrails: guardrailsSlot,
    encryption: encryptionSlot,
    installDefaultTracer: true,
  });
  // `installDefaultTracer: true` already wired the runtime's tracer as the
  // process default; explicit call here documents intent for readers.
  weaveSetDefaultTracer(consoleTracer);

  console.log(
    '[runtime] weaveRuntime ready — capabilities:',
    Array.from(runtime.capabilities).join(', '),
  );

  // Phase G — swap the module-level OAuth client for one backed by the
  // durable state store so pending authorization-code exchanges survive a
  // restart. ESM live binding propagates the swap to `routes/auth.ts`.
  setOAuthClient(new OAuthClient(createDurableOAuthStateStore({ runtime, namespace: 'oauth-flow' })));

  const activeProviders = Object.fromEntries(
    Object.entries(config.providers).filter(([key, provider]) => {
      // Local providers (ollama, llamacpp) are valid without an apiKey.
      if (key === 'ollama' || key === 'llamacpp' || key === 'llama-cpp') return true;
      return Boolean(provider?.apiKey?.trim());
    }),
  );
  if (Object.keys(activeProviders).length === 0) {
    throw new Error('At least one provider with a non-empty apiKey is required.');
  }
  if (!activeProviders[config.defaultProvider]) {
    throw new Error(`Default provider "${config.defaultProvider}" is not configured with an apiKey.`);
  }

  const port = config.port ?? 3500;
  const host = config.host ?? '0.0.0.0';

  // 2. Chat engine
  const chatEngine = new ChatEngine(
    {
      providers: activeProviders,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
      runtime,
    },
    db,
  );

  // 3. Seed all default configuration data (no-op if already seeded).
  await applySeed(db);

  // 3f. Phase M22 Phase 2: initialise the in-process handler-kind registry
  // (currently ships `agentic.react` and `deterministic.forward` as built-in
  // plugins) and sync registered kinds back into `live_handler_kinds` so the
  // admin UI's description / config schema fields stay in step with code.
  // Operator toggles such as `enabled` are never overwritten.
  const handlerRegistry = initHandlerRegistry();
  await syncHandlerKindsToDb(db, handlerRegistry);

  // 4. Sync BUILTIN_TOOLS into tool_catalog so operators can manage them
  await syncToolCatalog(db);

  // 4a. Self-register the internal MCP gateway in tool_catalog + tool_credentials
  // so operators discover it through the admin UI. Idempotent on every boot;
  // preserves operator-edited `enabled` and `config.exposed_classes`.
  await registerMCPGatewayInCatalog(db);

  // 4b. Phase 4: load operator-edited gateway exposure config so admin
  // toggles (enabled / exposed_classes) take effect on next boot.
  const gatewayConfig = await loadGatewayConfigFromCatalog(db);

  // 5. Start background tool health snapshot job (writes every 15 min)
  startToolHealthJob(db);

  // 5-EN. Phase 1 (Tenant Encryption): bootstrap the per-tenant key
  // manager wired to SQLite-backed EncryptionStore + audit emitter.
  // Returns null and logs a single warning when WEAVE_ENCRYPTION_MASTER_KEY
  // is missing — encryption stays disabled but the server keeps booting.
  // The manager is exposed as `geneweaveEncryptionManager` for Phase 3
  // consumer integration (chat/sv encrypted columns).
  try {
    const { bootstrapEncryption } = await import('./encryption/bootstrap.js');
    const result = bootstrapEncryption(db);
    if (result) {
      geneweaveEncryptionManager = result.manager;
      encryptionSlot.setManager(result.manager);
      geneweaveKmsRegistry = result.registry;
      geneweaveKmsResolver = result.resolver;
      geneweaveEncryptionMetrics = result.metrics as typeof geneweaveEncryptionMetrics;
      // Phase 8: bootstrap the SYSTEM tenant whose BIK powers cross-tenant
      // equality lookups (login by users.email_bidx). Idempotent.
      try {
        const { bootstrapSystemTenant } = await import('./encryption/system-tenant.js');
        await bootstrapSystemTenant(db, result.manager);
      } catch (err) {
        console.error('[encryption] system-tenant bootstrap failed (non-fatal)', err);
      }
      // Phase 9: seed default fleet-wide alert rules so the operator dashboard
      // has data on first boot. Idempotent — preserves operator edits.
      try {
        const { seedDefaultAlertRules } = await import('./encryption/alert-store.js');
        const seeded = await seedDefaultAlertRules(db, { tenantId: null });
        console.log('[encryption] alert rules seeded', seeded);
      } catch (err) {
        console.error('[encryption] alert seed failed (non-fatal)', err);
      }
    }
  } catch (err) {
    console.error('[encryption] bootstrap failed (non-fatal)', err);
  }

  // 5-EN-RS. Phase 5 (Tenant Encryption): start automated DEK rotation
  // scheduler. Honors `tenant_encryption_policy.rotation_schedule`
  // (monthly | quarterly | annual). Skipped silently when manager is
  // null. Default tick interval is 1 hour; uses `.unref()` so process
  // exit is unaffected.
  try {
    const { startEncryptionRotationScheduler } = await import(
      './encryption/rotation-scheduler.js'
    );
    startEncryptionRotationScheduler({
      db,
      getManager: () => geneweaveEncryptionManager,
    });
  } catch (err) {
    console.error('[encryption] rotation scheduler startup failed (non-fatal)', err);
  }

  // 5-EN-PS. Phase 6 (Tenant Encryption): start the GDPR purge scheduler.
  // Polls `tenant_deletion_requests` for rows whose retention window has
  // expired and calls `manager.hardShred(tenantId)` for each. Per-tenant
  // errors are isolated. Skipped silently when manager is null.
  try {
    const { weavePurgeScheduler } = await import('@weaveintel/encryption');
    weavePurgeScheduler({
      getManager: () => geneweaveEncryptionManager,
      listDuePurges: async (nowMs: number) => {
        const rows = await db.listDueTenantPurges(nowMs);
        return rows.map((r) => ({
          id: r.id,
          tenantId: r.tenant_id,
          requestedAt: r.requested_at,
          retentionUntil: r.retention_until,
        }));
      },
      markPurged: async (requestId: string, nowMs: number) => {
        await db.markTenantPurged(requestId, nowMs);
      },
    });
  } catch (err) {
    console.error('[encryption] purge scheduler startup failed (non-fatal)', err);
  }

  // 5-IR. Phase 8 (Cost Governor — Intent-RAG): warm tool description
  // embeddings so the per-step retrieval ranker has up-to-date vectors.
  // Best-effort + idempotent. No-op without OPENAI_API_KEY.
  try {
    const { createOpenAIEmbedder } = await import('./cost/openai-embedder.js');
    const { createDbToolEmbeddingStore } = await import('./cost/db-tool-embedding-store.js');
    const { warmToolEmbeddings } = await import('./cost/warm-tool-embeddings.js');
    const embedder = createOpenAIEmbedder();
    const store = createDbToolEmbeddingStore({ db, modelId: 'text-embedding-3-small' });
    await warmToolEmbeddings({
      embedder,
      store,
      log: (msg, meta) => console.log(msg, meta ?? ''),
    });
  } catch (err) {
    console.warn('cost.intent-rag: warmer hook failed (non-fatal)', String(err));
  }

  // 5-WF. Workflow Platform Phase 1: construct the singleton DB-driven
  // workflow engine and sync the resolver registry into the
  // `workflow_handler_kinds` catalog. The engine is reused by admin
  // routes (POST /api/admin/workflows/:id/run) and by other geneweave
  // subsystems that need to start runs from `workflow_defs` rows.
  // The `tool:` resolver is wired to BUILTIN_TOOLS so workflow steps
  // can call any in-process tool by key. Resolver registry sync is
  // best-effort and never blocks startup.
  // Phase 4 (DB-driven capability plan): build the in-process contract
  // bus + DB-backed emitter BEFORE the workflow engine so the engine
  // can publish typed completion contracts (`outputContract`) on every
  // run. The same bus feeds `MeshContractSourceAdapter` below so a
  // contract row in `mesh_contracts` doubles as a trigger source event.
  const contractBus = new EventEmitter();
  contractBus.setMaxListeners(0);
  const contractEmitter = new DbContractEmitter(db, contractBus);
  // Wire `prompt:<key>` resolver: render-only execution. Looks up the prompt
  // by id or name, renders the template via `executePromptRecord`, and
  // returns `{ promptKey, content, strategy }`. A future iteration may
  // forward the rendered text to a model client; for now this gives
  // workflows a deterministic templating step backed by the live prompt
  // registry, including fragment expansion and strategy overlays.
  const promptDeps = {
    async executePrompt(
      promptKey: string,
      variables: Record<string, unknown>,
      _config: Record<string, unknown>,
    ): Promise<unknown> {
      const { executePromptRecord, resolvePromptRecordForExecution } = await import(
        '@weaveintel/prompts'
      );
      const rows = await db.listPrompts();
      const match = rows.find(
        (r) => r.enabled && (r.id === promptKey || r.name === promptKey),
      );
      if (!match) throw new Error(`prompt resolver: no prompt found for key "${promptKey}"`);
      const versions = await db.listPromptVersions(match.id);
      const experiments = await db.listPromptExperiments(match.id);
      const resolved = resolvePromptRecordForExecution({
        prompt: match,
        versions,
        experiments,
        options: { assignmentKey: match.id },
      });
      const executed = executePromptRecord(resolved.record, variables);
      return {
        promptKey,
        promptId: match.id,
        version: resolved.meta.resolvedVersion,
        content: executed.content,
        strategy: executed.strategy.resolvedKey,
      };
    },
  };

  const workflowEngineHandle: WorkflowEngineHandle = createGeneweaveWorkflowEngine({
    db,
    toolGetter: (key: string) => BUILTIN_TOOLS[key],
    contractEmitter,
    runtime,
    promptDeps,
  });  try {
    await syncWorkflowHandlerKindsToDb(db, workflowEngineHandle.registry);
  } catch (err) {
    console.warn('[workflow-engine] failed to sync handler kinds:', err);
  }
  // Wire the `workflow_run` built-in tool so any agent / chat session can
  // start a workflow run by id or name. Tool definition lives in
  // `tools.ts`; the engine reference is published here once available.
  setWorkflowEngineForTools({
    startRun: (id, input) => workflowEngineHandle.engine.startRun(id, input),
    async resolveByKey(key) {
      const direct = await db.getWorkflowDef(key);
      if (direct) return direct.id;
      const all = await db.listWorkflowDefs();
      return all.find((row) => row.name === key)?.id;
    },
  });

  // 5-TR. Phase 3 Unified Triggers: build the singleton dispatcher with
  // a DB-backed store, in-process manual + cron sources (cron sources
  // are spun up per-trigger by the dispatcher itself based on rows in
  // `triggers`), and target adapters for `webhook_out` and `workflow`.
  // The dispatcher reloads on every CRUD write (admin route handlers
  // call `dispatcher.reload()`), so cron schedules reflect DB state
  // without a server restart.
  const triggerStore = createDbTriggerStore(db);
  const manualSource = new ManualSourceAdapter();
  const meshContractSource = new MeshContractSourceAdapter(contractBus);
  // Phase G — durable per-trigger rate-limit windows. Backed by
  // `runtime.persistence.kv` so quotas survive process restart and
  // coordinate across nodes.
  const triggerRateLimiter = createDurableTriggerRateLimiter({ runtime, namespace: 'trigger-rate' });
  const triggerDispatcher: TriggerDispatcher = createTriggerDispatcher({
    store: triggerStore,
    sourceAdapters: [manualSource, meshContractSource],
    targetAdapters: [
      new WebhookOutTargetAdapter(),
      createWorkflowTargetAdapter(workflowEngineHandle),
      createContractTargetAdapter(contractEmitter),
    ],
    rateLimiter: triggerRateLimiter,
  });
  try {
    await triggerDispatcher.start();
  } catch (err) {
    console.warn('[triggers] failed to start dispatcher:', err);
  }

  // 5a. Resilience Phase 4: subscribe to the process-wide signal bus and
  // batch-write per-endpoint counters into `endpoint_health` every ~1s.
  applyDbResilienceObserver(db);

  // 5b. anyWeave Phase 5: daily regression detection on capability signals
  startRoutingRegressionJob(db);

  // 5c. M21: global Kaggle live-agents heartbeat — drives every active
  // competition run (concurrency 8 covers ~1 full pipeline of 6 roles per
  // tick). Failure here is non-fatal: the HTTP server still boots so
  // operators can inspect runs in the admin UI.
  let kaggleHeartbeat: KaggleHeartbeatHandle | null = null;
  try {
    kaggleHeartbeat = await startKaggleHeartbeat({
      db,
      providers: activeProviders,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
    });
  } catch (err) {
    console.error('[geneweave] Failed to start Kaggle heartbeat:', err instanceof Error ? err.message : String(err));
  }

  // 5d. Phase 5: optional generic supervisor (mesh-agnostic). Off by default;
  // enable with LIVE_AGENTS_GENERIC_RUNTIME=1. Coexists with the Kaggle
  // heartbeat; safe to leave off if no generic mesh has been provisioned.
  let genericSupervisor: HeartbeatSupervisorHandle | null = null;
  try {
    genericSupervisor = await startGenericSupervisorIfEnabled({
      db,
      providers: activeProviders,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
    });
  } catch (err) {
    console.error('[geneweave] Failed to start generic supervisor:', err instanceof Error ? err.message : String(err));
  }

  // 5. HTTP server
  const server = createGeneWeaveServer({
    db,
    chatEngine,
    jwtSecret: config.jwtSecret,
    corsOrigin: config.corsOrigin,
    providers: activeProviders,
    publicBaseUrl: config.publicBaseUrl,
    gatewayConfig,
    workflowEngine: workflowEngineHandle,
    triggerDispatcher: { dispatcher: triggerDispatcher, manualSource },
    runtime, // thread real runtime so admin weaveAudit writes to durable KV
  });

  // 5. Listen
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      console.log(`\n  🧬 geneWeave running → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`);
      resolve();
    });
  });

  return {
    port,
    server,
    db,
    chatEngine,
    runtime,
    workflows: workflowEngineHandle,
    async syncPricing() {
      return syncModelPricing(db, activeProviders);
    },
    async stop() {
      if (kaggleHeartbeat) {
        try { await kaggleHeartbeat.stop(); } catch { /* non-fatal */ }
      }
      if (genericSupervisor) {
        try { await genericSupervisor.stop(); } catch { /* non-fatal */ }
      }
      try { await triggerDispatcher.stop(); } catch { /* non-fatal */ }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await db.close();
      console.log('  🧬 geneWeave stopped');
    },
  };
}

// ─── Re-exports for advanced usage ───────────────────────────

export type { DatabaseAdapter, DatabaseConfig, UserRow, SessionRow, ChatRow, MessageRow, MetricRow, EvalRow, MetricsSummary, ChatSettingsRow, TraceRow, PromptRow, GuardrailRow, RoutingPolicyRow, WorkflowDefRow, ToolCatalogRow, WorkflowRunRow, GuardrailEvalRow, ToolPolicyRow, ToolRateLimitBucketRow, ToolAuditEventRow, ToolHealthSnapshotRow, ToolCredentialRow } from './db.js';
export { SQLiteAdapter, createDatabaseAdapter } from './db.js';
export type { ProviderConfig, ChatEngineConfig, ChatSettings } from './chat.js';
export { ChatEngine, calculateCost } from './chat.js';
export { DashboardService } from './dashboard.js';
export type { AuthContext, JWTPayload } from './auth.js';
export { signJWT, verifyJWT, hashPassword, verifyPassword, generateCSRFToken } from './auth.js';
export { BUILTIN_TOOLS, createToolRegistry, getAvailableTools } from './tools.js';
