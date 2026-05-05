/**
 * Kaggle live-agents global heartbeat runner.
 *
 * Wired once at server boot via `startKaggleHeartbeat()` in geneweave's
 * `createGeneWeave()` factory. A single shared heartbeat (workerId
 * `geneweave-kaggle-worker`) drives every active Kaggle competition run by
 * (a) scheduling pending ticks for any agent with work in inbox/backlog,
 * (b) calling `heartbeat.tick(ctx)` to execute claimed ticks, and (c)
 * mirroring the resulting agent state into the `kgl_run_step` /
 * `kgl_run_event` ledger so the admin UI's run-detail timeline updates in
 * near real-time.
 *
 * Concurrency is set high enough (default 8) that a single heartbeat covers
 * many Kaggle pipelines running in parallel — each pipeline has 6 roles, so
 * 8 means 1+ run can fully tick in a single interval pass.
 */

import { weaveContext, type Model } from '@weaveintel/core';
import {
  createHeartbeat,
  createActionExecutor,
  type Heartbeat,
  type AttentionPolicy,
  type TaskHandler,
} from '@weaveintel/live-agents';
// Phase 5 — model routing flows exclusively through `weaveDbModelResolver`
// from `@weaveintel/live-agents-runtime`. The legacy `buildPlannerModel`
// helper and `resolveModelForRole` callback have been removed.
import type { DatabaseAdapter } from '../../db.js';
import type { ProviderConfig } from '../../chat.js';
import { getOrCreateModel } from '../../chat-runtime.js';
import { routeModel } from '../../chat-routing-utils.js';
import { newUUIDv7 } from '../../lib/uuid.js';
import { getKaggleLiveStore } from './store.js';
import { createDbKagglePlaybookResolver } from './playbook-resolver.js';
import { registerKaggleHandlerKinds } from './handler-kinds.js';
import { getHandlerRegistry, syncHandlerKindsToDb } from '../handler-registry-boot.js';
import { createKaggleAttentionPolicy } from './agents.js';
import {
  resolveAttentionPolicyFromDb,
  weaveDbLiveAgentPolicy,
  weaveDbModelResolver,
  weaveLiveAgentFromDb,
} from '@weaveintel/live-agents-runtime';
import { DbToolPolicyResolver, DbToolRateLimiter } from '../../tool-policy-resolver.js';
import { DbToolAuditEmitter } from '../../tool-audit-emitter.js';
import { DbToolApprovalGate } from '../../tool-approval-gate.js';

export interface StartKaggleHeartbeatOptions {
  db: DatabaseAdapter;
  providers: Record<string, ProviderConfig>;
  defaultProvider: string;
  defaultModel: string;
  /** Schedule + bridge interval in milliseconds (default 5_000). */
  intervalMs?: number;
  /**
   * Number of parallel tick() workers. Each worker runs an independent
   * `heartbeat.tick()` loop with its own workerId so a long-running ReAct
   * loop on one agent doesn't block ticks for other runs.
   *
   * There is no cap on the number of concurrent competitions — workers
   * round-robin through all SCHEDULED ticks across all active runs. The
   * worker count only controls how many ticks execute in parallel per
   * interval; queued ticks pick up on subsequent intervals. Scale via the
   * `KAGGLE_HEARTBEAT_WORKERS` env var (default 32) for high-density
   * deployments — set to e.g. 64 or 128 if competitions arrive faster than
   * they drain.
   */
  workers?: number;
  workerIdPrefix?: string;
  /**
   * Phase 4: Optional DB key from `live_attention_policies.key`.
   * When set the heartbeat uses the DB-driven factory to resolve the
   * attention policy. When omitted (default) falls back to the Kaggle-
   * specific `createKaggleAttentionPolicy('discoverer')` heuristic.
   */
  attentionPolicyKey?: string;
}

export interface KaggleHeartbeatHandle {
  stop(): Promise<void>;
}

const KAGGLE_ROLE_TO_STEP: Record<string, string> = {
  discoverer: 'kaggle_discoverer',
  strategist: 'kaggle_strategist',
  implementer: 'kaggle_implementer',
  validator: 'kaggle_validator',
  submitter: 'kaggle_submitter',
  observer: 'kaggle_observer',
};

const NOOP_MODEL: Model = {
  id: 'noop-kaggle-heartbeat',
  call: async () => ({ text: '' }),
} as unknown as Model;

/**
 * Build the candidate model list the SmartModelRouter chooses from. Mirrors
 * `ChatEngine.getAvailableModels()` in `chat.ts` so the live-agents heartbeat
 * picks among the same enabled `model_pricing` rows + configured-provider
 * fallbacks the chat path uses. Keeping the logic here local avoids pulling
 * the whole ChatEngine into the heartbeat boot path.
 */
async function listAvailableModelsForRouting(
  db: DatabaseAdapter,
  providers: Record<string, ProviderConfig>,
): Promise<Array<{ id: string; provider: string }>> {
  const seen = new Set<string>();
  const out: Array<{ id: string; provider: string }> = [];
  const configured = new Set(Object.keys(providers));
  try {
    const rows = await db.listModelPricing();
    for (const row of rows) {
      if (!row.enabled || !configured.has(row.provider)) continue;
      const key = `${row.provider}:${row.model_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: row.model_id, provider: row.provider });
    }
  } catch {
    /* DB lookup is best-effort */
  }
  // Same fallback list as ChatEngine — ensures routing has candidates even
  // when the operator hasn't seeded model_pricing yet.
  const FALLBACK_MODELS: Record<string, string[]> = {
    anthropic: ['claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-haiku-4-20250414'],
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini'],
    google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    ollama: ['llama3.1', 'qwen2.5', 'mistral'],
    llamacpp: ['local'],
    'llama-cpp': ['local'],
    mock: ['mock-model'],
  };
  for (const provider of configured) {
    const fb = FALLBACK_MODELS[provider];
    if (!fb) continue;
    for (const id of fb) {
      const key = `${provider}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, provider });
    }
  }
  return out;
}


/**
 * Scan every kaggle agent across active runs and ensure a SCHEDULED tick
 * row exists for any agent with pending inbox or open backlog. Without this
 * the heartbeat would have nothing to claim. Idempotent per-agent.
 *
 * Filters out paused/archived meshes and non-ACTIVE agents so operator pause
 * actions stop new work immediately (in-flight ticks still drain naturally).
 *
 * No cap on concurrent competitions — runs are paged in batches of
 * RUN_PAGE_SIZE and every page is processed in parallel. Scheduling cost
 * scales linearly with the active-run count; SQLite + Promise.all keep this
 * sub-second well into the thousands of agents.
 */
const RUN_PAGE_SIZE = 200;

async function listAllRunningRuns(db: DatabaseAdapter): Promise<Array<Awaited<ReturnType<DatabaseAdapter['listKglCompetitionRuns']>>[number]>> {
  const out: Array<Awaited<ReturnType<DatabaseAdapter['listKglCompetitionRuns']>>[number]> = [];
  let offset = 0;
  for (;;) {
    const page = await db.listKglCompetitionRuns({ status: 'running', limit: RUN_PAGE_SIZE, offset });
    out.push(...page);
    if (page.length < RUN_PAGE_SIZE) break;
    offset += RUN_PAGE_SIZE;
  }
  return out;
}

async function scheduleDueTicks(db: DatabaseAdapter, workerId: string): Promise<number> {
  const store = await getKaggleLiveStore();
  const runs = await listAllRunningRuns(db);
  if (runs.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const bucket = Math.floor(Date.now() / 30_000); // 30s dedupe window

  const scheduleAgent = async (agentId: string): Promise<number> => {
    const [inbox, backlog] = await Promise.all([
      store.listMessagesForRecipient('AGENT', agentId),
      store.listBacklogForAgent(agentId),
    ]);
    const hasPendingMsg = inbox.some(
      (m) => m.status === 'PENDING' || m.status === 'DELIVERED' || m.status === 'READ',
    );
    const hasOpenBacklog = backlog.some(
      (b) => b.status === 'PROPOSED' || b.status === 'ACCEPTED' || b.status === 'IN_PROGRESS',
    );
    if (!hasPendingMsg && !hasOpenBacklog) return 0;
    // Deterministic tick id per agent per bucket — upserts on PK so repeated
    // scheduling within the same bucket replaces the same row. Once a worker
    // claims it, the next bucket's SCHEDULED upsert won't override an
    // in-flight claim (claimNextTicks filters status=SCHEDULED only).
    const tickId = `tick:${agentId}:${bucket}`;
    const existing = await store.loadHeartbeatTick(tickId);
    if (existing && existing.status !== 'SCHEDULED') return 0;
    await store.saveHeartbeatTick({
      id: tickId,
      agentId,
      scheduledFor: nowIso,
      pickedUpAt: null,
      completedAt: null,
      workerId: '',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    });
    return 1;
  };

  const scheduleRun = async (meshId: string): Promise<number> => {
    // Skip meshes operator has paused/archived. Defense-in-depth: even if a
    // kgl_competition_run row is still 'running', a paused mesh means
    // "operator wants no new work" — honor that here so ticks don't pile up.
    const mesh = await store.loadMesh(meshId);
    if (!mesh || mesh.status !== 'ACTIVE') return 0;
    const agents = await store.listAgents(meshId);
    const activeAgents = agents.filter((a) => a.status === 'ACTIVE');
    if (activeAgents.length === 0) return 0;
    const counts = await Promise.all(activeAgents.map((a) => scheduleAgent(a.id)));
    return counts.reduce((s, n) => s + n, 0);
  };

  const perRun = await Promise.all(runs.map((r) => (r.mesh_id ? scheduleRun(r.mesh_id) : Promise.resolve(0))));
  void workerId;
  return perRun.reduce((s, n) => s + n, 0);
}

/**
 * After each tick, mirror live-agents state (per role agent backlog/inbox)
 * into the `kgl_run_step` ledger so the admin UI's pipeline timeline reflects
 * real progress. Idempotent — only writes when the step status would change.
 */
async function bridgeRunState(db: DatabaseAdapter): Promise<void> {
  const store = await getKaggleLiveStore();
  const runs = await listAllRunningRuns(db);
  await Promise.all(runs.map((run) => bridgeOneRun(db, store, run)));
}

async function bridgeOneRun(
  db: DatabaseAdapter,
  store: Awaited<ReturnType<typeof getKaggleLiveStore>>,
  run: { id: string; mesh_id: string | null; status: string; summary?: string | null },
): Promise<void> {
  if (!run.mesh_id) return;
  const meshId = run.mesh_id;
  const steps = await db.listKglRunSteps(run.id);
  const stepByRole = new Map(steps.map((s) => [s.role, s] as const));
  for (const [roleSlug, stepRole] of Object.entries(KAGGLE_ROLE_TO_STEP)) {
    const step = stepByRole.get(stepRole);
    if (!step) continue;
    const agentId = `${meshId}::${roleSlug}`;
    const [backlog, inbox] = await Promise.all([
      store.listBacklogForAgent(agentId),
      store.listMessagesForRecipient('AGENT', agentId),
    ]);
    const inProgress = backlog.find((b) => b.status === 'IN_PROGRESS');
    const completed = backlog.filter((b) => b.status === 'COMPLETED').sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
    const open = backlog.find((b) => b.status === 'PROPOSED' || b.status === 'ACCEPTED');
    // Inbox-driven activity: roles after the discoverer (strategist,
    // implementer, validator, submitter, observer) typically receive
    // TASK messages from upstream agents and may execute via ReAct loops
    // without ever creating a backlog item. Treat any pending/delivered
    // inbox or any handled inbox message as evidence the step is active.
    const hasOpenInbox = inbox.some((m) => m.status === 'PENDING' || m.status === 'DELIVERED' || m.status === 'READ');
    const hasHandledInbox = inbox.some((m) => m.status === 'PROCESSED');
    // running: in-progress backlog OR open backlog OR open inbox OR
    // already-handled inbox (means the agent has at least started work).
    if (step.status === 'pending' && (inProgress || open || hasOpenInbox || hasHandledInbox)) {
      await db.updateKglRunStep(step.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        agent_id: agentId,
      });
      await db.appendKglRunEvent({
        id: newUUIDv7(),
        run_id: run.id,
        step_id: step.id,
        kind: 'step_started',
        agent_id: agentId,
        tool_key: null,
        summary: `${roleSlug} agent picked up work.`,
        payload_json: null,
      });
    }
    // completed: latest backlog item is COMPLETED and no remaining open work
    if ((step.status === 'pending' || step.status === 'running') && completed && !inProgress && !open && !hasOpenInbox) {
      const summary = (completed.title || completed.description || `${roleSlug} step complete`).slice(0, 240);
      await db.updateKglRunStep(step.id, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        summary,
        agent_id: agentId,
      });
      await db.appendKglRunEvent({
        id: newUUIDv7(),
        run_id: run.id,
        step_id: step.id,
        kind: 'step_completed',
        agent_id: agentId,
        tool_key: null,
        summary,
        payload_json: null,
      });
    }
  }
  // If the submitter step is completed, mark the whole run completed.
  const submitterStep = stepByRole.get('kaggle_submitter');
  if (submitterStep && submitterStep.status === 'completed' && run.status === 'running') {
    await db.updateKglCompetitionRun(run.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      summary: submitterStep.summary ?? 'Pipeline reached submitter step.',
    });
  }
}

/**
 * Boot the global Kaggle live-agents heartbeat. Returns a handle whose
 * `stop()` clears the interval and stops the heartbeat. Safe to call once
 * at server startup; failure inside any single tick is logged and the
 * loop continues.
 */
export async function startKaggleHeartbeat(opts: StartKaggleHeartbeatOptions): Promise<KaggleHeartbeatHandle> {
  const intervalMs = opts.intervalMs ?? 5_000;
  // No cap on concurrent competitions — workers process the global queue
  // of SCHEDULED ticks round-robin. Worker count only controls per-interval
  // parallelism; pending ticks naturally roll forward. Default 32 is a sane
  // out-of-the-box value; operators set `KAGGLE_HEARTBEAT_WORKERS` to scale
  // arbitrarily (e.g. 128 or 256) when many competitions run simultaneously.
  const envWorkers = Number(process.env['KAGGLE_HEARTBEAT_WORKERS'] ?? '');
  const workerCount = Math.max(
    1,
    opts.workers ?? (Number.isFinite(envWorkers) && envWorkers > 0 ? envWorkers : 32),
  );
  const workerIdPrefix = opts.workerIdPrefix ?? 'geneweave-kaggle-worker';

  const store = await getKaggleLiveStore();
  const playbookResolver = createDbKagglePlaybookResolver(opts.db);

  // ---------------------------------------------------------------------
  // Per-tick model routing — Phase 5 (live-agents capability parity).
  //
  // All routing flows through `weaveDbModelResolver` from
  // `@weaveintel/live-agents-runtime`. The runtime resolver owns the
  // listCandidates → routeModel → getModel pipeline; we inject geneweave's:
  //   • candidate enumerator (`listAvailableModelsForRouting`)
  //   • routing brain (`routeModel`)
  //   • model factory (`getOrCreateModel`)
  // so no DB types leak into the package.
  //
  // The legacy `buildPlannerModel()` and `resolveModelForRole(role, hint)`
  // shim were removed in Phase 5 — `createKaggleRoleHandlers` now consumes
  // `modelResolver` exclusively.
  // ---------------------------------------------------------------------
  const dbModelResolver = weaveDbModelResolver({
    listCandidates: () => listAvailableModelsForRouting(opts.db, opts.providers),
    routeModel: async (cands, hints) => {
      const routed = await routeModel(opts.db, cands, [], {
        taskType: hints.taskType,
        prompt: hints.prompt,
      });
      if (!routed) return null;
      return {
        provider: routed.provider,
        modelId: routed.modelId,
        taskKey: routed.taskKey,
        experimentName: routed.experimentName,
      };
    },
    getOrCreateModel: async (provider, modelId) => {
      const cfg = opts.providers[provider];
      if (!cfg) throw new Error(`no provider config for ${provider}`);
      return getOrCreateModel(provider, modelId, cfg);
    },
    roleTaskMap: {
      strategist: 'reasoning',
      validator: 'analysis',
      observer: 'analysis',
      discoverer: 'reasoning',
    },
    log: (msg) => console.log('[kaggle-heartbeat]', msg),
  });

  // Build the shared DB-backed policy bundle once. Both the handler-kind
  // registration (Phase A) and the per-tick handler resolution (Phase C)
  // reuse it so chat / generic-supervisor / kaggle paths share identical
  // gating and audit semantics.
  const liveAgentPolicy = weaveDbLiveAgentPolicy({
    policyResolver: new DbToolPolicyResolver(opts.db),
    approvalGate: new DbToolApprovalGate(opts.db),
    rateLimiter: new DbToolRateLimiter(opts.db),
    auditEmitter: new DbToolAuditEmitter(opts.db),
  });

  // Phase A — register the 10 kaggle handler kinds against the shared
  // registry so the action executor can resolve a `TaskHandler` purely from
  // a `live_agent_handler_bindings` row. Idempotent: silently skips kinds
  // already registered. Re-runs syncHandlerKindsToDb so the rows reach
  // `live_handler_kinds` for admin visibility.
  const handlerRegistry = getHandlerRegistry();
  try {
    registerKaggleHandlerKinds(handlerRegistry, {
      modelResolver: dbModelResolver,
      playbookResolver,
      db: opts.db,
      log: (msg) => console.log('[kaggle-handler-kinds]', msg),
      policy: liveAgentPolicy,
    });
    await syncHandlerKindsToDb(opts.db, handlerRegistry);
  } catch (err) {
    console.error(
      '[kaggle-heartbeat] handler-kind registration failed:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Phase C — per-tick handler resolution from DB bindings.
  //
  // For each StartTask/ContinueTask action the action executor dispatches by
  // `agent.role` to a TaskHandler. The shim below ignores in-code role
  // tables and instead resolves the agent's enabled `live_agent_handler_bindings`
  // row, looks up the handler kind in the shared registry, and invokes it.
  // This makes the kaggle pipeline behavior fully DB-driven: operators can
  // swap an agent between e.g. `kaggle.strategist.agentic` and
  // `kaggle.strategist.deterministic` purely via the admin UI.
  //
  // The shim is registered under all 6 kaggle role keys so the dispatcher
  // routes every kaggle agent to it.
  const dbDrivenHandler: TaskHandler = async (action, execCtx, ctx) => {
    const agentId = execCtx.agent.id;
    // Defense-in-depth: the scheduler already filters PAUSED meshes/agents
    // when emitting NEW ticks, but stale SCHEDULED ticks can persist across
    // server restarts (the la_entities table outlives the in-process loop)
    // and operator pause actions can land between claim and execute. Re-check
    // status here so a paused agent or paused mesh drops the tick instantly
    // without invoking the model — critical for not burning paid quota on
    // abandoned/paused work.
    const liveAgent = await store.loadAgent(agentId);
    if (!liveAgent || liveAgent.status !== 'ACTIVE') {
      return { completed: false, summaryProse: `Agent status=${liveAgent?.status ?? 'missing'} — skipping tick.` };
    }
    const mesh = await store.loadMesh(liveAgent.meshId);
    if (!mesh || mesh.status !== 'ACTIVE') {
      return { completed: false, summaryProse: `Mesh status=${mesh?.status ?? 'missing'} — skipping tick.` };
    }
    const { handler } = await weaveLiveAgentFromDb(opts.db, agentId, {
      modelResolver: dbModelResolver,
      policy: liveAgentPolicy,
      handlerRegistry,
      logger: (msg) => console.log('[kaggle-heartbeat][db-handler]', msg),
    });
    return handler(action, execCtx, ctx);
  };
  const taskHandlers: Record<string, TaskHandler> = {
    discoverer: dbDrivenHandler,
    strategist: dbDrivenHandler,
    implementer: dbDrivenHandler,
    validator: dbDrivenHandler,
    submitter: dbDrivenHandler,
    observer: dbDrivenHandler,
  };
  const actionExecutor = createActionExecutor({ taskHandlers });

  // Phase 4: Resolve attention policy from DB when a key is configured;
  // otherwise fall back to the Kaggle-specific discoverer heuristic for
  // full backward compatibility. This lets operators switch to any DB-driven
  // policy (e.g. 'heuristic.inbox-first', 'cron.hourly') via the admin UI
  // without touching code.
  const attentionPolicy: AttentionPolicy = opts.attentionPolicyKey
    ? await resolveAttentionPolicyFromDb(opts.db, opts.attentionPolicyKey, {
        logger: (msg) => console.log('[kaggle-heartbeat][attention-factory]', msg),
      })
    : createKaggleAttentionPolicy('discoverer');

  // Build N independent heartbeat workers. Each has its own workerId so the
  // claimNextTicks lease isolates them — a long-running ReAct loop in worker
  // 0 can't block ticks on workers 1..N-1, giving us real parallel pipeline
  // execution across many concurrent Kaggle competition runs.
  const workers: Array<{ id: string; heartbeat: Heartbeat; busy: boolean }> = [];
  for (let i = 0; i < workerCount; i++) {
    const id = `${workerIdPrefix}-${i}`;
    workers.push({
      id,
      busy: false,
      heartbeat: createHeartbeat({
        stateStore: store,
        workerId: id,
        concurrency: 1, // one tick per worker; parallelism comes from N workers
        model: NOOP_MODEL,
        attentionPolicy,
        actionExecutor,
      }),
    });
  }

  let stopped = false;
  let scheduleInFlight = false;

  // Schedule + bridge runs every interval. Cheap, must not block tick loops.
  const scheduleAndBridge = async (): Promise<void> => {
    if (stopped || scheduleInFlight) return;
    scheduleInFlight = true;
    try {
      await scheduleDueTicks(opts.db, workerIdPrefix);
      await bridgeRunState(opts.db);
    } catch (err) {
      console.error('[kaggle-heartbeat] schedule/bridge failed:', err instanceof Error ? err.message : String(err));
    } finally {
      scheduleInFlight = false;
    }
  };

  // Each worker independently calls heartbeat.tick() in a loop. Workers are
  // not blocked by other workers — only by their own currently-running tick.
  const runWorker = async (w: { id: string; heartbeat: Heartbeat; busy: boolean }): Promise<void> => {
    if (stopped || w.busy) return;
    w.busy = true;
    try {
      await w.heartbeat.tick(weaveContext({ userId: 'human:geneweave-system' }));
    } catch (err) {
      console.error(`[kaggle-heartbeat] worker ${w.id} tick failed:`, err instanceof Error ? err.message : String(err));
    } finally {
      w.busy = false;
    }
  };

  const ticker = setInterval(() => {
    void scheduleAndBridge();
    for (const w of workers) {
      void runWorker(w);
    }
  }, intervalMs);
  ticker.unref();

  console.log(
    `[kaggle-heartbeat] started (workers=${workerCount} intervalMs=${intervalMs} planner=agentic[modelResolver])`,
  );

  return {
    async stop() {
      stopped = true;
      clearInterval(ticker);
      await Promise.all(workers.map((w) => w.heartbeat.stop()));
    },
  };
}
