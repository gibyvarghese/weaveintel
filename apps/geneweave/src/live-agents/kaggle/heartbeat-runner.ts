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
import { createHeartbeat, createActionExecutor, type Heartbeat, type AttentionPolicy } from '@weaveintel/live-agents';
import type { DatabaseAdapter } from '../../db.js';
import type { ProviderConfig } from '../../chat.js';
import { getOrCreateModel } from '../../chat-runtime.js';
import { newUUIDv7 } from '../../lib/uuid.js';
import { getKaggleLiveStore } from './store.js';
import { createDbKagglePlaybookResolver } from './playbook-resolver.js';
import { createKaggleRoleHandlers } from './role-handlers.js';
import { createKaggleAttentionPolicy } from './agents.js';

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
 * Build (best-effort) the planner LLM the strategist's ReAct loop uses.
 * Returns `undefined` when no usable provider/key is configured — handlers
 * then fall back to deterministic mode and the pipeline still ticks through.
 */
async function buildPlannerModel(opts: StartKaggleHeartbeatOptions): Promise<Model | undefined> {
  const provider = opts.defaultProvider;
  const cfg = opts.providers[provider];
  if (!cfg) return undefined;
  // Only certain providers can act as the strategist planner. Local providers
  // (ollama/llamacpp) work too via the same factory.
  try {
    return await getOrCreateModel(provider, opts.defaultModel, cfg);
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

  const taskHandlers = createKaggleRoleHandlers({
    plannerModel,
    playbookResolver,
    db: opts.db,
    log: (msg) => console.log('[kaggle-heartbeat]', msg),
  });
  const actionExecutor = createActionExecutor({ taskHandlers });
  const attentionPolicy: AttentionPolicy = createKaggleAttentionPolicy('discoverer');

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
