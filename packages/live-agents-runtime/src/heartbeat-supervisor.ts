/**
 * Phase 5 — Generic heartbeat supervisor.
 *
 * Replaces bespoke `startXxxHeartbeat()` boots with a single, mesh-agnostic
 * loop that:
 *
 *   1. Builds N parallel `createHeartbeat()` workers backed by a shared
 *      StateStore (so claim leases isolate them).
 *   2. Wires a **single dispatcher TaskHandler** that loads each agent's
 *      enabled handler binding from the DB at invoke time and delegates to
 *      the `HandlerRegistry`. The dispatcher is registered for every
 *      currently-active role string in the DB, so the live-agents engine's
 *      role-keyed lookup finds it.
 *   3. Schedules `SCHEDULED` ticks for any agent with pending inbox or open
 *      backlog (so the heartbeat actually has work to claim).
 *   4. Mirrors agent state into `live_run_steps` / `live_run_events` via
 *      `bridgeRunState()` so the admin UI updates live.
 *   5. Periodically re-checks the active role set and rebuilds workers if
 *      a new mesh adds a previously-unknown role. This is rare but needed
 *      so newly-provisioned meshes start ticking without a process restart.
 *
 * Failure isolation: every periodic step is wrapped in try/catch and logged.
 * One failing agent never stops the loop.
 */

import { weaveContext, type Model } from '@weaveintel/core';
import {
  createActionExecutor,
  createHeartbeat,
  type AttentionPolicy,
  type Heartbeat,
  type StateStore,
  type TaskHandler,
} from '@weaveintel/live-agents';

import {
  HandlerRegistry,
  type HandlerBinding,
  type HandlerContext,
} from './handler-registry.js';
import { resolveAttentionPolicyFromDb } from './attention-factory.js';
import { bridgeRunState, type RunBridgeDb } from './run-bridge.js';

// ─── Lightweight DB row shapes the supervisor needs ──────────

export interface SupervisorAgentRowLike {
  id: string;
  mesh_id: string;
  role_key: string;
  name: string;
  status: string;
  attention_policy_key: string | null;
}

export interface SupervisorMeshRowLike {
  id: string;
  status: string;
}

export interface SupervisorHandlerBindingRowLike {
  id: string;
  agent_id: string;
  handler_kind: string;
  config_json: string | null;
  enabled: number;
}

export interface SupervisorHeartbeatTickRowLike {
  id: string;
}

export interface SupervisorDb extends RunBridgeDb {
  listLiveMeshes(opts?: { status?: string }): Promise<SupervisorMeshRowLike[]>;
  listLiveAgents(opts: {
    meshId?: string;
    status?: string;
  }): Promise<SupervisorAgentRowLike[]>;
  listLiveAgentHandlerBindings(opts: {
    agentId?: string;
    enabledOnly?: boolean;
  }): Promise<SupervisorHandlerBindingRowLike[]>;
}

// ─── Public API ──────────────────────────────────────────────

export interface HeartbeatSupervisorOptions {
  db: SupervisorDb;
  /** Shared StateStore — must be the same one provisionMesh wrote to. */
  store: StateStore;
  /** Pre-populated registry of handler kinds (built-in + plugins). */
  handlerRegistry: HandlerRegistry;
  /** Schedule + bridge interval in milliseconds. Default 5000. */
  intervalMs?: number;
  /** How often to refresh the active-role list. Default 30000. */
  refreshMs?: number;
  /** Number of parallel `heartbeat.tick()` workers. Default 4. */
  workers?: number;
  workerIdPrefix?: string;
  /**
   * Lazy model factory invoked on demand by `agentic.react` handlers via the
   * shared `HandlerContext`. Returns `undefined` when no usable provider
   * is configured (handlers fall back to deterministic mode).
   */
  modelFactory?: () => Promise<Model | undefined>;
  /** DB-backed prompt resolver, passed through to handlers. */
  resolveSystemPrompt?: (key: string) => Promise<string | null>;
  /** Optional default attention policy DB key. */
  attentionPolicyKey?: string;
  /** Logger (defaults to console.log with a tag). */
  logger?: (msg: string) => void;
}

export interface HeartbeatSupervisorHandle {
  stop(): Promise<void>;
}

const NOOP_MODEL: Model = {
  id: 'noop-live-supervisor',
  call: async () => ({ text: '' }),
} as unknown as Model;

/**
 * Boot the generic supervisor. Returns a handle whose `stop()` clears the
 * intervals and stops all workers.
 */
export async function createHeartbeatSupervisor(
  opts: HeartbeatSupervisorOptions,
): Promise<HeartbeatSupervisorHandle> {
  const log = opts.logger ?? ((m) => console.log('[live-supervisor]', m));
  const intervalMs = opts.intervalMs ?? 5_000;
  const refreshMs = opts.refreshMs ?? 30_000;
  const workerCount = Math.max(1, opts.workers ?? 4);
  const workerIdPrefix = opts.workerIdPrefix ?? 'geneweave-live-worker';

  // Resolve attention policy once (DB-driven when configured).
  const attentionPolicy: AttentionPolicy | undefined = opts.attentionPolicyKey
    ? await resolveAttentionPolicyFromDb(
        opts.db as unknown as Parameters<typeof resolveAttentionPolicyFromDb>[0],
        opts.attentionPolicyKey,
        { logger: (m) => log(`[attention] ${m}`) },
      )
    : undefined;

  // ── Build the dispatcher TaskHandler ────────────────────
  // One function for every role: looks up the agent's enabled binding from
  // DB on every tick (so admin edits take effect without restart), then
  // hands off to the registry.
  const dispatcher: TaskHandler = async (action, execCtx, ctx) => {
    const agentId = execCtx.agent.id;
    const agent = await opts.store.loadAgent(agentId);
    if (!agent) {
      log(`dispatcher: agent ${agentId} not found in store — skipping`);
      return { completed: false };
    }
    const bindings = await opts.db.listLiveAgentHandlerBindings({
      agentId,
      enabledOnly: true,
    });
    if (bindings.length === 0) {
      log(`dispatcher: agent ${agentId} has no enabled handler binding — skipping`);
      return { completed: false };
    }
    // Honour the most recently updated enabled binding deterministically.
    const row = bindings[0]!;
    let config: Record<string, unknown> = {};
    if (row.config_json) {
      try {
        const parsed = JSON.parse(row.config_json);
        if (parsed && typeof parsed === 'object') {
          config = parsed as Record<string, unknown>;
        }
      } catch {
        log(`dispatcher: agent ${agentId} binding ${row.id} has invalid config_json`);
      }
    }
    const binding: HandlerBinding = {
      id: row.id,
      agentId,
      handlerKind: row.handler_kind,
      config,
    };
    const model = opts.modelFactory ? await opts.modelFactory() : undefined;
    const hctx: HandlerContext = {
      binding,
      agent: {
        id: agent.id,
        meshId: agent.meshId,
        roleKey: agent.role,
        name: agent.name,
      },
      log: (m) => log(`[${agent.role}/${agentId.slice(0, 8)}] ${m}`),
      ...(model ? { model } : {}),
      ...(opts.resolveSystemPrompt ? { resolveSystemPrompt: opts.resolveSystemPrompt } : {}),
    };
    const handler = opts.handlerRegistry.build(hctx);
    return handler(action, execCtx, ctx);
  };

  // ── Worker management ──────────────────────────────────
  let workers: Array<{ id: string; heartbeat: Heartbeat; busy: boolean }> = [];
  let registeredRoles = new Set<string>();
  let stopped = false;
  let scheduleInFlight = false;

  /** Build (or rebuild) workers when the active role set changes. */
  const rebuildWorkers = async (roles: Set<string>): Promise<void> => {
    // Stop existing workers in parallel; ignore errors.
    if (workers.length > 0) {
      await Promise.all(
        workers.map(async (w) => {
          try {
            await w.heartbeat.stop();
          } catch {
            /* noop */
          }
        }),
      );
    }
    workers = [];
    registeredRoles = roles;
    const taskHandlers: Record<string, TaskHandler> = {};
    for (const r of roles) taskHandlers[r] = dispatcher;
    const actionExecutor = createActionExecutor({ taskHandlers });
    for (let i = 0; i < workerCount; i++) {
      const id = `${workerIdPrefix}-${i}`;
      workers.push({
        id,
        busy: false,
        heartbeat: createHeartbeat({
          stateStore: opts.store,
          workerId: id,
          concurrency: 1,
          model: NOOP_MODEL,
          ...(attentionPolicy ? { attentionPolicy } : {}),
          actionExecutor,
        }),
      });
    }
    log(
      `workers rebuilt: count=${workerCount} roles=${[...roles].sort().join(',') || '(none)'}`,
    );
  };

  /** Find every distinct role across active meshes' active agents. */
  const collectActiveRoles = async (): Promise<Set<string>> => {
    const meshes = await opts.db.listLiveMeshes({ status: 'ACTIVE' });
    const roles = new Set<string>();
    for (const m of meshes) {
      const agents = await opts.db.listLiveAgents({ meshId: m.id, status: 'ACTIVE' });
      for (const a of agents) roles.add(a.role_key);
    }
    return roles;
  };

  /** Schedule SCHEDULED ticks for any agent with open work. Idempotent. */
  const scheduleDueTicks = async (): Promise<void> => {
    const meshes = await opts.db.listLiveMeshes({ status: 'ACTIVE' });
    for (const m of meshes) {
      const agents = await opts.db.listLiveAgents({ meshId: m.id, status: 'ACTIVE' });
      for (const a of agents) {
        try {
          await scheduleTickIfWorkPending(opts.store, a.id);
        } catch (err) {
          log(`schedule failed for agent ${a.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  };

  /** Combined per-interval action: schedule + bridge. */
  const scheduleAndBridge = async (): Promise<void> => {
    if (stopped || scheduleInFlight) return;
    scheduleInFlight = true;
    try {
      await scheduleDueTicks();
      await bridgeRunState(opts.db, opts.store, { logger: (m) => log(`[bridge] ${m}`) });
    } catch (err) {
      log(`schedule/bridge cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      scheduleInFlight = false;
    }
  };

  /** Refresh the role set; if it differs, rebuild workers. */
  const refreshRolesIfChanged = async (): Promise<void> => {
    try {
      const roles = await collectActiveRoles();
      const same =
        roles.size === registeredRoles.size && [...roles].every((r) => registeredRoles.has(r));
      if (!same) {
        await rebuildWorkers(roles);
      }
    } catch (err) {
      log(`role refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Worker tick driver — each worker independently calls heartbeat.tick().
  const runWorker = async (
    w: { id: string; heartbeat: Heartbeat; busy: boolean },
  ): Promise<void> => {
    if (stopped || w.busy) return;
    w.busy = true;
    try {
      await w.heartbeat.tick(weaveContext({ userId: 'human:geneweave-system' }));
    } catch (err) {
      log(`worker ${w.id} tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      w.busy = false;
    }
  };

  // ── Initial boot ──────────────────────────────────────
  await rebuildWorkers(await collectActiveRoles());

  const ticker = setInterval(() => {
    void scheduleAndBridge();
    for (const w of workers) void runWorker(w);
  }, intervalMs);
  ticker.unref();

  const refresher = setInterval(() => {
    void refreshRolesIfChanged();
  }, refreshMs);
  refresher.unref();

  log(`started (workers=${workerCount} intervalMs=${intervalMs} refreshMs=${refreshMs})`);

  return {
    async stop() {
      stopped = true;
      clearInterval(ticker);
      clearInterval(refresher);
      await Promise.all(workers.map((w) => w.heartbeat.stop()));
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Insert a `SCHEDULED` heartbeat tick for the agent if (a) it has open work
 * (open backlog or pending inbox) and (b) no `SCHEDULED` tick already
 * exists for it. Deterministic id keeps the call idempotent within a
 * 60-second bucket — repeated calls collapse on the StateStore's PK.
 */
async function scheduleTickIfWorkPending(
  store: StateStore,
  agentId: string,
): Promise<void> {
  const [backlog, inbox] = await Promise.all([
    store.listBacklogForAgent(agentId),
    store.listMessagesForRecipient('AGENT', agentId),
  ]);
  const hasWork =
    backlog.some(
      (b) =>
        b.status === 'PROPOSED' ||
        b.status === 'ACCEPTED' ||
        b.status === 'IN_PROGRESS',
    ) ||
    inbox.some(
      (m) => m.status === 'PENDING' || m.status === 'DELIVERED' || m.status === 'READ',
    );
  if (!hasWork) return;

  const nowIso = new Date().toISOString();
  // 30-second bucket → repeated calls within the bucket upsert the same
  // PK row instead of piling up duplicates.
  const bucket = Math.floor(Date.now() / 30_000);
  const tickId = `tick:${agentId}:${bucket}`;
  const existing = await store.loadHeartbeatTick(tickId);
  // If a worker has already claimed the tick (status moved past SCHEDULED),
  // don't clobber its lease.
  if (existing && existing.status !== 'SCHEDULED') return;
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
}
