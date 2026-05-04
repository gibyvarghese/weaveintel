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
} from '@weaveintel/live-agents';
import type { DatabaseAdapter } from '../../db.js';
import type { ProviderConfig } from '../../chat.js';
import { getOrCreateModel } from '../../chat-runtime.js';
import { routeModel } from '../../chat-routing-utils.js';
import { newUUIDv7 } from '../../lib/uuid.js';
import { getKaggleLiveStore } from './store.js';
import { createDbKagglePlaybookResolver } from './playbook-resolver.js';
import { createKaggleRoleHandlers } from './role-handlers.js';
import { createKaggleAttentionPolicy } from './agents.js';
import {
  resolveAttentionPolicyFromDb,
  weaveDbModelResolver,
} from '@weaveintel/live-agents-runtime';

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
   * loop on one agent doesn't block ticks for other runs. Default 4 — at
   * concurrency=1 per worker that means up to 4 parallel agent ticks.
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
 * Build (best-effort) the planner LLM the strategist's ReAct loop uses.
 *
 * Resolution order:
 *   1. If an enabled `routing_policies` row exists, call `@weaveintel/routing`'s
 *      SmartModelRouter via `routeModel(...)` (the same helper chat.ts uses
 *      per request). This honors the active policy's strategy, weights,
 *      cost ceilings, capability constraints, and fallback chain — so the
 *      heartbeat respects auto routing identically to the chat path.
 *   2. Otherwise, fall back to `(defaultProvider, defaultModel)` from the
 *      ChatEngine config (legacy behaviour).
 *   3. If no provider is configured at all, returns `undefined` and the
 *      role handlers run in deterministic mode.
 *
 * Routing happens once at heartbeat startup. Every Kaggle role agent
 * (strategist, validator, observer) shares the resolved model. Per-tick
 * re-routing for per-agent `model_capability_json` overrides is handled
 * separately by `resolveLiveAgentModel()` in `../agent-model-resolver.ts`.
 */
async function buildPlannerModel(opts: StartKaggleHeartbeatOptions): Promise<Model | undefined> {
  // Try auto routing first. Falls through to the legacy default on any
  // failure — routing is best-effort and never blocks heartbeat startup.
  try {
    const candidates = await listAvailableModelsForRouting(opts.db, opts.providers);
    if (candidates.length > 0) {
      const routed = await routeModel(opts.db, candidates, [], {
        // The strategist plans multi-step ReAct sequences with tool calls.
        // Tag the routing request so capability-aware policies can pick a
        // tool-capable model from the active candidate set.
        taskType: 'reasoning',
        prompt: 'kaggle-strategist-planner',
      });
      if (routed) {
        const cfg = opts.providers[routed.provider];
        if (cfg) {
          const model = await getOrCreateModel(routed.provider, routed.modelId, cfg);
          console.log(
            `[kaggle-heartbeat] planner routed via SmartModelRouter → ${routed.provider}/${routed.modelId}` +
              (routed.taskKey ? ` (task=${routed.taskKey})` : '') +
              (routed.experimentName ? ` (experiment=${routed.experimentName})` : ''),
          );
          return model;
        }
      }
    }
  } catch (err) {
    console.warn(
      '[kaggle-heartbeat] auto-routing failed, falling back to default provider/model:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Legacy fallback: pinned (defaultProvider, defaultModel) — used only when
  // no active routing policy exists or routing fails.
  const provider = opts.defaultProvider;
  const cfg = opts.providers[provider];
  if (!cfg) return undefined;
  try {
    const model = await getOrCreateModel(provider, opts.defaultModel, cfg);
    console.log(`[kaggle-heartbeat] planner using default ${provider}/${opts.defaultModel} (no routing policy active)`);
    return model;
  } catch {
    return undefined;
  }
}

/**
 * Scan every kaggle agent across active runs and ensure a SCHEDULED tick
 * row exists for any agent with pending inbox or open backlog. Without this
 * the heartbeat would have nothing to claim. Idempotent per-agent.
 */
async function scheduleDueTicks(db: DatabaseAdapter, workerId: string): Promise<number> {
  const store = await getKaggleLiveStore();
  const runs = await db.listKglCompetitionRuns({ status: 'running', limit: 100 });
  const nowIso = new Date().toISOString();
  let scheduled = 0;
  for (const run of runs) {
    if (!run.mesh_id) continue;
    const agents = await store.listAgents(run.mesh_id);
    for (const agent of agents) {
      const [inbox, backlog] = await Promise.all([
        store.listMessagesForRecipient('AGENT', agent.id),
        store.listBacklogForAgent(agent.id),
      ]);
      const hasPendingMsg = inbox.some((m) => m.status === 'PENDING' || m.status === 'DELIVERED' || m.status === 'READ');
      const hasOpenBacklog = backlog.some(
        (b) => b.status === 'PROPOSED' || b.status === 'ACCEPTED' || b.status === 'IN_PROGRESS',
      );
      if (!hasPendingMsg && !hasOpenBacklog) continue;
      // Deterministic tick id per agent per interval bucket — saveHeartbeatTick
      // upserts on PK (entity_type, id), so repeated scheduling within the
      // same bucket replaces the same row instead of piling up duplicates.
      // Once a worker claims+leases the tick, its workerId/leaseExpiresAt are
      // set so the next bucket's SCHEDULED upsert won't override an in-flight
      // claim (claimNextTicks filters status=SCHEDULED only).
      const bucket = Math.floor(Date.now() / 30_000); // 30s window
      const tickId = `tick:${agent.id}:${bucket}`;
      const existing = await store.loadHeartbeatTick(tickId);
      if (existing && existing.status !== 'SCHEDULED') continue;
      await store.saveHeartbeatTick({
        id: tickId,
        agentId: agent.id,
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
      scheduled++;
      void workerId; // captured for logging callers
    }
  }
  return scheduled;
}

/**
 * After each tick, mirror live-agents state (per role agent backlog/inbox)
 * into the `kgl_run_step` ledger so the admin UI's pipeline timeline reflects
 * real progress. Idempotent — only writes when the step status would change.
 */
async function bridgeRunState(db: DatabaseAdapter): Promise<void> {
  const store = await getKaggleLiveStore();
  const runs = await db.listKglCompetitionRuns({ status: 'running', limit: 100 });
  for (const run of runs) {
    if (!run.mesh_id) continue;
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
}

/**
 * Boot the global Kaggle live-agents heartbeat. Returns a handle whose
 * `stop()` clears the interval and stops the heartbeat. Safe to call once
 * at server startup; failure inside any single tick is logged and the
 * loop continues.
 */
export async function startKaggleHeartbeat(opts: StartKaggleHeartbeatOptions): Promise<KaggleHeartbeatHandle> {
  const intervalMs = opts.intervalMs ?? 5_000;
  const workerCount = Math.max(1, opts.workers ?? 4);
  const workerIdPrefix = opts.workerIdPrefix ?? 'geneweave-kaggle-worker';

  const store = await getKaggleLiveStore();
  const playbookResolver = createDbKagglePlaybookResolver(opts.db);
  const plannerModel = await buildPlannerModel(opts);

  // ---------------------------------------------------------------------
  // Per-tick model routing.
  //
  // Phase 2 (live-agents capability parity) — switched from a hand-rolled
  // closure to `weaveDbModelResolver` from `@weaveintel/live-agents-runtime`.
  // The runtime resolver owns the listCandidates → routeModel → getModel
  // pipeline and the per-tick fallback contract. We just inject geneweave's
  // routing brain (`routeModel`), candidate enumerator
  // (`listAvailableModelsForRouting`), and model factory
  // (`getOrCreateModel`) so no DB types leak into the package.
  //
  // The legacy `resolveModelForRole(role, hint)` callback is preserved
  // below for back-compat (kaggle role-handlers' strategist.ts still
  // accepts it). Phase 5 of the plan will remove it once the role-handlers
  // are migrated to consume `modelResolver` exclusively.
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

  // Legacy back-compat shim: kaggle role-handlers still accept a per-role
  // callback. Delegate through the new resolver so behaviour is identical
  // and there is exactly one routing path. Returns `undefined` on any
  // failure → handler falls back to the startup-resolved `plannerModel`.
  const resolveModelForRole = async (
    role: 'strategist' | 'validator' | 'observer' | 'discoverer',
    hint?: { task?: string },
  ): Promise<Model | undefined> => {
    return dbModelResolver.resolve({
      role,
      capability: hint?.task ? { task: hint.task } : undefined,
    });
  };

  const taskHandlers = createKaggleRoleHandlers({
    plannerModel,
    // Phase 2 — pass the resolver directly. strategist.ts prefers
    // `modelResolver` over `resolveModelForRole` when both are present.
    modelResolver: dbModelResolver,
    resolveModelForRole,
    playbookResolver,
    db: opts.db,
    log: (msg) => console.log('[kaggle-heartbeat]', msg),
  });
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
    `[kaggle-heartbeat] started (workers=${workerCount} intervalMs=${intervalMs} planner=${plannerModel ? 'agentic' : 'deterministic'})`,
  );

  return {
    async stop() {
      stopped = true;
      clearInterval(ticker);
      await Promise.all(workers.map((w) => w.heartbeat.stop()));
    },
  };
}
