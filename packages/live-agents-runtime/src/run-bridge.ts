/**
 * Phase 5 — Generic run-state bridge.
 *
 * Mirrors live-agents per-agent backlog/inbox state into the
 * `live_run_steps` + `live_run_events` ledger so admin dashboards reflect
 * real-time pipeline progress. This is the generic equivalent of
 * `bridgeRunState()` in `apps/geneweave/src/live-agents/kaggle/heartbeat-runner.ts`
 * — same algorithm, but keyed on `live_runs.mesh_id` + `live_run_steps.role_key`
 * instead of the Kaggle-specific `kgl_*` ledger.
 *
 * Algorithm per RUNNING run:
 *   For each pre-existing step row (matched by `role_key` to a runtime
 *   agent in the same mesh):
 *     - if step is PENDING and the agent has open work → mark RUNNING
 *     - if step is PENDING/RUNNING and the latest backlog item is COMPLETED
 *       and no remaining open backlog/inbox → mark COMPLETED
 *
 * The bridge is idempotent — only writes when the step status would change.
 *
 * Steps are NOT auto-created by the bridge: callers (admin or workflow
 * orchestrators) are responsible for seeding the per-run step ledger before
 * the supervisor starts ticking. This keeps the bridge unopinionated about
 * which subset of agents in a mesh constitutes a "pipeline".
 */

import type { StateStore } from '@weaveintel/live-agents';

// ─── Lightweight DB row shapes (mirror geneweave) ────────────

export interface LiveRunRowLike {
  id: string;
  mesh_id: string;
  status: string; // 'RUNNING' | 'COMPLETED' | …
}

export interface LiveAgentRowLike {
  id: string;
  mesh_id: string;
  role_key: string;
}

export interface LiveRunStepRowLike {
  id: string;
  run_id: string;
  mesh_id: string;
  agent_id: string | null;
  role_key: string;
  status: string; // 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
}

export interface LiveRunEventRowLike {
  id: string;
  run_id: string;
  step_id: string | null;
  kind: string;
  agent_id: string | null;
  tool_key: string | null;
  summary: string | null;
  payload_json: string | null;
}

/** Slice of `DatabaseAdapter` the bridge needs. */
export interface RunBridgeDb {
  listLiveRuns(opts: { meshId?: string; status?: string; limit?: number }): Promise<LiveRunRowLike[]>;
  listLiveAgents(opts: { meshId?: string; status?: string }): Promise<LiveAgentRowLike[]>;
  listLiveRunSteps(opts: { runId: string }): Promise<LiveRunStepRowLike[]>;
  updateLiveRunStep(
    id: string,
    patch: Partial<{
      status: string;
      started_at: string | null;
      completed_at: string | null;
      summary: string | null;
      agent_id: string | null;
    }>,
  ): Promise<void>;
  appendLiveRunEvent(row: Omit<LiveRunEventRowLike, 'created_at'>): Promise<unknown>;
}

export interface BridgeRunStateOptions {
  /** Only bridge runs in this mesh. When omitted, bridges every active mesh's runs. */
  meshId?: string;
  /** Logger (defaults to console.log with a tag). */
  logger?: (msg: string) => void;
  /** UUID generator for new event rows. */
  newId?: () => string;
  /** Override `now()` for deterministic tests. */
  nowIso?: string;
}

const defaultIdGen = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
};

/**
 * Mirror StateStore agent state into `live_run_steps` + `live_run_events`.
 * Safe to call once per heartbeat tick — only emits writes on status change.
 */
export async function bridgeRunState(
  db: RunBridgeDb,
  store: StateStore,
  opts: BridgeRunStateOptions = {},
): Promise<void> {
  const log = opts.logger ?? ((m) => console.log('[run-bridge]', m));
  const newId = opts.newId ?? defaultIdGen;
  const nowIso = opts.nowIso ?? new Date().toISOString();

  const runs = await db.listLiveRuns({
    ...(opts.meshId ? { meshId: opts.meshId } : {}),
    status: 'RUNNING',
    limit: 200,
  });

  for (const run of runs) {
    try {
      await bridgeOneRun(db, store, run, newId, nowIso, log);
    } catch (err) {
      log(`run ${run.id} bridge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function bridgeOneRun(
  db: RunBridgeDb,
  store: StateStore,
  run: LiveRunRowLike,
  newId: () => string,
  nowIso: string,
  log: (m: string) => void,
): Promise<void> {
  const [agents, steps] = await Promise.all([
    db.listLiveAgents({ meshId: run.mesh_id, status: 'ACTIVE' }),
    db.listLiveRunSteps({ runId: run.id }),
  ]);
  const agentByRole = new Map(agents.map((a) => [a.role_key, a] as const));

  for (const step of steps) {
    if (step.status === 'COMPLETED' || step.status === 'FAILED') continue;
    const agent = agentByRole.get(step.role_key);
    if (!agent) continue;

    const [backlog, inbox] = await Promise.all([
      store.listBacklogForAgent(agent.id),
      store.listMessagesForRecipient('AGENT', agent.id),
    ]);

    const inProgress = backlog.find((b) => b.status === 'IN_PROGRESS');
    const open = backlog.find(
      (b) => b.status === 'PROPOSED' || b.status === 'ACCEPTED',
    );
    const completed = backlog
      .filter((b) => b.status === 'COMPLETED')
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
    const hasOpenInbox = inbox.some(
      (m) => m.status === 'PENDING' || m.status === 'DELIVERED' || m.status === 'READ',
    );
    const hasHandledInbox = inbox.some((m) => m.status === 'PROCESSED');

    // PENDING → RUNNING
    if (
      step.status === 'PENDING' &&
      (inProgress || open || hasOpenInbox || hasHandledInbox)
    ) {
      await db.updateLiveRunStep(step.id, {
        status: 'RUNNING',
        started_at: nowIso,
        agent_id: agent.id,
      });
      await db.appendLiveRunEvent({
        id: newId(),
        run_id: run.id,
        step_id: step.id,
        kind: 'step_started',
        agent_id: agent.id,
        tool_key: null,
        summary: `${step.role_key} agent picked up work.`,
        payload_json: null,
      });
      log(`run ${run.id} step ${step.role_key} → RUNNING`);
      continue;
    }

    // RUNNING → COMPLETED
    if (
      (step.status === 'PENDING' || step.status === 'RUNNING') &&
      completed &&
      !inProgress &&
      !open &&
      !hasOpenInbox
    ) {
      const summary = (
        completed.title ||
        completed.description ||
        `${step.role_key} step complete`
      ).slice(0, 240);
      await db.updateLiveRunStep(step.id, {
        status: 'COMPLETED',
        completed_at: nowIso,
        summary,
        agent_id: agent.id,
      });
      await db.appendLiveRunEvent({
        id: newId(),
        run_id: run.id,
        step_id: step.id,
        kind: 'step_completed',
        agent_id: agent.id,
        tool_key: null,
        summary,
        payload_json: null,
      });
      log(`run ${run.id} step ${step.role_key} → COMPLETED`);
    }
  }
}
