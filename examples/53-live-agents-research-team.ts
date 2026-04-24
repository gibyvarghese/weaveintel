/**
 * Example 53 - live-agents research team
 *
 * Exercises ALL @weaveintel/live-agents capabilities:
 *   Runtime      : createLiveAgentsRuntime, createHeartbeat, createCompressionMaintainer
 *   Ingress      : createExternalEventHandler, EventRoutes, push-stream Gmail
 *   Attention    : ProcessMessage, StartTask, ContinueTask, DraftMessage,
 *                  RequestCapability, IssueGrant, EscalateToHuman,
 *                  EmitEpisodicMarker, RequestCompressionRefresh,
 *                  RequestPromotion, CheckpointAndRest
 *   State        : Mesh, Agents, Teams, TeamMemberships, DelegationEdges,
 *                  AccountBindings, CapabilityGrants, PromotionRequests,
 *                  CrossMeshBridges, BacklogItems, Messages, OutboundRecords
 *   Observability: InMemoryLiveAgentsRunLogger
 *
 * Run: npx tsx examples/53-live-agents-research-team.ts
 */

import 'dotenv/config';

import {
  weaveContext,
  weaveSetDefaultTracer,
  type ExecutionContext,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type RoutingPolicy,
} from '@weaveintel/core';
import { weaveMCPClient, createMCPStreamableHttpTransport } from '@weaveintel/mcp-client';
import { weaveConsoleTracer } from '@weaveintel/observability';
import { SmartModelRouter } from '@weaveintel/routing';
import {
  createLiveAgentsRuntime,
  createExternalEventHandler,
  createHeartbeat,
  createCompressionMaintainer,
  createStandardAttentionPolicy,
  createActionExecutor,
  InMemoryLiveAgentsRunLogger,
  weaveInMemoryStateStore,
  type AgentContract,
  type AgentContractDraft,
  type Heartbeat,
  type HeartbeatTick,
  type LiveAgent,
  type Message,
  type Mesh,
  type StateStore,
  type Team,
  type TeamMembership,
  type AccountBinding,
  type CrossMeshBridge,
  type AttentionAction,
  type AttentionContext,
  type AttentionPolicy,
} from '@weaveintel/live-agents';
import { weaveRealMCPTransport } from '@weaveintel/mcp-server';
import { liveGmailAdapter, type GmailCredentials, type GmailMessage } from '@weaveintel/tools-gmail';

const TARGET_SENDER = 'giby.varghese@tech-lunch.com';
const ENABLE_EMAIL_SEND = process.env['GMAIL_ENABLE_SEND'] === '1';
const SIMULATE_EMAIL_FLOW = process.env['SIMULATE_EMAIL_FLOW'] === '1';
const HEARTBEAT_SCHEDULE_MS = 15_000;
const COMPRESSION_INTERVAL_MS = 60_000;

/** Canonical agent IDs used across policies, routes, and state setup. */
const AGENT_IDS = {
  manager:     'agent-manager',
  researcherA: 'agent-researcher-a',
  researcherB: 'agent-researcher-b',
  writer:      'agent-writer',
} as const;

/**
 * Generates a lightweight unique identifier for demo entities such as messages,
 * backlog items, ticks, and events.
 *
 * @param prefix Stable namespace prefix indicating the entity kind.
 * @returns A best-effort unique id combining prefix, wall-clock time, and randomness.
 */
function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Reads a required environment variable and throws if missing.
 *
 * @param name Environment variable key to resolve.
 * @returns The non-empty environment variable value.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * Extracts the text payload from an MCP tool response shaped as content parts.
 *
 * @param result Unknown tool-call result object.
 * @returns First text part if present, otherwise a JSON empty array string.
 */
function parseTextPayload(result: unknown): string {
  const obj = result as { content?: Array<{ text?: string; type?: string }> };
  return obj.content?.find((item) => item.type === 'text')?.text ?? '[]';
}

/**
 * Async sleep helper used by simulated flow paths.
 *
 * @param ms Delay duration in milliseconds.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Emits a structured flow log line for runtime trace readability.
 *
 * @param step Short phase name used for grouping related logs.
 * @param detail Human-readable description of what just happened.
 */
function flow(step: string, detail: string): void {
  console.log(`[FLOW] ${step} :: ${detail}`);
}

/**
 * Computes an ISO timestamp offset from a baseline ISO instant.
 *
 * @param nowIso Baseline timestamp in ISO-8601 format.
 * @param minutes Positive or negative minute offset.
 * @returns Shifted ISO timestamp.
 */
function nextTickIso(nowIso: string, minutes: number): string {
  return new Date(Date.parse(nowIso) + minutes * 60_000).toISOString();
}

function parseContextJsonFromModelRequest(request: ModelRequest): Record<string, unknown> | null {
  const userMessage = request.messages.find((m) => m.role === 'user');
  if (!userMessage || typeof userMessage.content !== 'string') {
    return null;
  }
  const content = userMessage.content;
  const marker = 'Context JSON:\n';
  const idx = content.indexOf(marker);
  if (idx < 0) return null;
  const jsonText = content.slice(idx + marker.length).trim();
  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function createResearchAttentionModel(modelId: string): Model {
  return {
    info: {
      provider: 'demo',
      modelId,
      capabilities: new Set(),
    },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate(_ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      const payload = parseContextJsonFromModelRequest(request);
      const inbox = Array.isArray(payload?.['inbox']) ? payload['inbox'] as Array<Record<string, unknown>> : [];
      const backlog = Array.isArray(payload?.['backlog']) ? payload['backlog'] as Array<Record<string, unknown>> : [];
      const nowIso = typeof payload?.['nowIso'] === 'string'
        ? payload['nowIso']
        : new Date().toISOString();

      const pending = inbox.find((m) => m['status'] === 'PENDING' || m['status'] === 'DELIVERED');
      const inProgress = backlog.find((b) => b['status'] === 'IN_PROGRESS');
      const accepted = backlog.find((b) => b['status'] === 'ACCEPTED' || b['status'] === 'PROPOSED');

      let action: Record<string, unknown>;
      if (pending && typeof pending['id'] === 'string') {
        action = { type: 'ProcessMessage', messageId: pending['id'] };
      } else if (inProgress && typeof inProgress['id'] === 'string') {
        action = { type: 'ContinueTask', backlogItemId: inProgress['id'] };
      } else if (accepted && typeof accepted['id'] === 'string') {
        action = { type: 'StartTask', backlogItemId: accepted['id'] };
      } else {
        action = {
          type: 'CheckpointAndRest',
          nextTickAt: nextTickIso(nowIso, 5),
        };
      }

      return {
        id: `resp-${modelId}-${Date.now()}`,
        content: JSON.stringify({ action, reason: `heuristic:${modelId}` }),
        finishReason: 'stop',
        usage: { promptTokens: 64, completionTokens: 16, totalTokens: 80 },
        model: modelId,
      };
    },
  };
}

// ─── Custom Attention Policies ────────────────────────────────────────────────

/**
 * Per-thread email coordination state tracked by Carol's manager policy.
 */
interface EmailCoordinationState {
  delegatedTo: Set<string>;  // specialist agentIds Carol has sent TASK messages to
  grantedTo:   Set<string>;  // agentIds Carol has issued IssueGrant for
  reportCount: number;       // REPORT messages received from specialists
  escalated:   boolean;      // EscalateToHuman already issued
  marked:      boolean;      // EmitEpisodicMarker already issued
}

/**
 * Role-aware attention policy for Carol (Research Manager).
 *
 * Demonstrates: ProcessMessage, DraftMessage (delegation + escalation),
 *               IssueGrant, EscalateToHuman, EmitEpisodicMarker,
 *               CheckpointAndRest.
 */
function createManagerPolicy(): AttentionPolicy {
  const emailState = new Map<string, EmailCoordinationState>();

  function getEmailState(threadId: string): EmailCoordinationState {
    let s = emailState.get(threadId);
    if (!s) {
      s = { delegatedTo: new Set(), grantedTo: new Set(), reportCount: 0, escalated: false, marked: false };
      emailState.set(threadId, s);
    }
    return s;
  }

  return {
    key: 'manager-research-v1',
    async decide(context: AttentionContext): Promise<AttentionAction> {
      const now = context.nowIso;

      // ── 1. Process any PENDING / DELIVERED messages ───────────────────────
      const pending = context.inbox.find(
        (m) => m.status === 'PENDING' || m.status === 'DELIVERED',
      );
      if (pending) {
        // Track report count when a REPORT from a specialist is acknowledged
        if (pending.kind === 'REPORT' && pending.fromType === 'AGENT') {
          getEmailState(pending.threadId).reportCount += 1;
        }
        return { type: 'ProcessMessage', messageId: pending.id };
      }

      // ── 2. Issue grants for processed GRANT_REQUEST messages ─────────────
      const processedGrantReqs = context.inbox.filter(
        (m) => m.kind === 'GRANT_REQUEST' && m.status === 'PROCESSED' && m.fromType === 'AGENT',
      );
      for (const req of processedGrantReqs) {
        const s = getEmailState(req.threadId);
        if (!s.grantedTo.has(req.fromId)) {
          s.grantedTo.add(req.fromId);
          return {
            type: 'IssueGrant',
            recipientAgentId: req.fromId,
            capability: {
              kindHint:         'AUTHORITY_EXTENSION',
              descriptionProse: 'Temporary authority for restricted research source access.',
              scopeProse:       'Restricted source index — current research cycle only.',
              durationHint:     'PT4H',
              reasonProse:      'Approved by manager to unblock specialist research task.',
            },
          };
        }
      }

      // ── 3. Delegate tasks for processed INGRESS emails ────────────────────
      const processedEmails = context.inbox.filter(
        (m) => m.fromType === 'INGRESS' && m.status === 'PROCESSED',
      );
      for (const email of processedEmails) {
        const s = getEmailState(email.threadId);
        const snippet = email.body.slice(0, 300);
        const subject = email.subject;

        if (!s.delegatedTo.has(AGENT_IDS.researcherA)) {
          s.delegatedTo.add(AGENT_IDS.researcherA);
          return {
            type: 'DraftMessage',
            to:   { type: 'AGENT', id: AGENT_IDS.researcherA },
            kind: 'TASK',
            subject: `Research task: ${subject}`,
            bodySeed: `Extract requirements and acceptance criteria from this request: ${snippet}`,
          };
        }
        if (!s.delegatedTo.has(AGENT_IDS.researcherB)) {
          s.delegatedTo.add(AGENT_IDS.researcherB);
          return {
            type: 'DraftMessage',
            to:   { type: 'AGENT', id: AGENT_IDS.researcherB },
            kind: 'TASK',
            subject: `Risk assessment: ${subject}`,
            bodySeed: `Analyze constraints, dependencies, and risks from: ${snippet}`,
          };
        }
        if (!s.delegatedTo.has(AGENT_IDS.writer)) {
          s.delegatedTo.add(AGENT_IDS.writer);
          return {
            type: 'DraftMessage',
            to:   { type: 'AGENT', id: AGENT_IDS.writer },
            kind: 'TASK',
            subject: `Execution brief: ${subject}`,
            bodySeed: `Draft action plan and owner assignments for: ${snippet}`,
          };
        }

        // ── 4. Once all 3 reports arrive, escalate to human ─────────────────
        const SPECIALIST_COUNT = 3;
        if (s.reportCount >= SPECIALIST_COUNT && !s.escalated) {
          s.escalated = true;
          const reportMsgs = context.inbox.filter(
            (m) => m.kind === 'REPORT' && m.status === 'PROCESSED',
          );
          return {
            type: 'EscalateToHuman',
            reasonProse: `Research team completed analysis of "${subject}". All specialist reports received.`,
            optionsProse: reportMsgs
              .slice(-SPECIALIST_COUNT)
              .map((m) => `${m.fromId}: ${m.body}`)
              .join('\n\n'),
          };
        }

        // ── 5. Emit episodic marker after escalation ─────────────────────────
        if (s.escalated && !s.marked) {
          s.marked = true;
          return {
            type: 'EmitEpisodicMarker',
            summaryProse: `Research cycle complete for "${subject}". Specialists coordinated, reports collected, human notified.`,
            tags: ['research-complete', 'email-handled', email.threadId],
          };
        }
      }

      return { type: 'CheckpointAndRest', nextTickAt: nextTickIso(now, 2) };
    },
  };
}

/**
 * Per-task phase state for specialist agents (Alice, Bob, Dana).
 */
type TaskPhase =
  | 'cap-requested'         // Alice: RequestCapability sent, awaiting grant
  | 'started'               // StartTask executed; backlog item IN_PROGRESS
  | 'reported'              // DraftMessage REPORT sent to manager
  | 'compression-requested' // Alice: RequestCompressionRefresh issued
  | 'promotion-requested'   // Dana: RequestPromotion issued
  | 'done';                 // terminal; CheckpointAndRest


/**
 * Role-aware attention policy for specialist agents.
 *
 * Alice (researcher-a): ProcessMessage → RequestCapability → StartTask
 *                       → DraftMessage REPORT → RequestCompressionRefresh → CheckpointAndRest
 * Bob   (researcher-b): ProcessMessage → StartTask → DraftMessage REPORT
 *                       → ContinueTask → CheckpointAndRest
 * Dana  (writer):       ProcessMessage → StartTask → DraftMessage REPORT
 *                       → RequestPromotion → CheckpointAndRest
 */
function createSpecialistPolicy(args: {
  agentId: string;
  managerId: string;
  role: 'researcher-a' | 'researcher-b' | 'writer';
}): AttentionPolicy {
  const taskPhase = new Map<string, TaskPhase>();

  function generateReportBody(task: Message): string {
    if (args.role === 'researcher-a') {
      return [
        `Topic: ${task.subject}`,
        'Findings: requirements and acceptance criteria extracted from source request.',
        'Confidence: HIGH | Gaps: none identified in this pass.',
        'Recommendation: proceed to risk assessment and execution planning.',
      ].join(' | ');
    }
    if (args.role === 'researcher-b') {
      return [
        'Constraints identified: single email source, limited context window.',
        'Risk highlights: potential ambiguity in expected output format.',
        'Mitigation: propose options and confirm preferred format before execution.',
        'Confidence: MEDIUM | Blocker probability: LOW.',
      ].join(' | ');
    }
    // writer
    return [
      'Execution brief drafted: objective, evidence, risks, actions, owners.',
      'Draft recommendation: phased research plan with checkpoint review.',
      'Delivery format: concise summary + actionable next steps.',
      'Confidence: HIGH | Ready for manager review.',
    ].join(' | ');
  }

  return {
    key: `specialist-${args.role}-v1`,
    async decide(context: AttentionContext): Promise<AttentionAction> {
      const now = context.nowIso;

      // ── 1. Process any PENDING / DELIVERED messages ───────────────────────
      const pending = context.inbox.find(
        (m) => m.status === 'PENDING' || m.status === 'DELIVERED',
      );
      if (pending) {
        return { type: 'ProcessMessage', messageId: pending.id };
      }

      // ── 2. New TASK not yet in phase map ──────────────────────────────────
      const newTasks = context.inbox.filter(
        (m) => m.kind === 'TASK' && m.status === 'PROCESSED' && !taskPhase.has(m.id),
      );
      for (const task of newTasks) {
        if (args.role === 'researcher-a') {
          // Alice requests capability BEFORE starting work
          taskPhase.set(task.id, 'cap-requested');
          return {
            type: 'RequestCapability',
            capability: {
              kindHint:         'AUTHORITY_EXTENSION',
              descriptionProse: 'Need temporary authority to access restricted source index for this task.',
              reasonProse:      'Current role scope does not cover restricted source retrieval.',
              evidenceMessageIds: [task.id],
            },
          };
        }
        // Bob and Dana: go straight to StartTask or DraftMessage
        const acceptedItem = context.backlog.find((b) => b.status === 'ACCEPTED');
        if (acceptedItem) {
          taskPhase.set(task.id, 'started');
          return { type: 'StartTask', backlogItemId: acceptedItem.id };
        }
        taskPhase.set(task.id, 'reported');
        return {
          type: 'DraftMessage',
          to:   { type: 'AGENT', id: args.managerId },
          kind: 'REPORT',
          subject: `Report from ${args.role}: ${task.subject}`,
          bodySeed: generateReportBody(task),
        };
      }

      // ── 3. Alice: cap-requested → now start the task ───────────────────────
      if (args.role === 'researcher-a') {
        const capTask = context.inbox.find(
          (m) => m.kind === 'TASK' && taskPhase.get(m.id) === 'cap-requested',
        );
        if (capTask) {
          const acceptedItem = context.backlog.find((b) => b.status === 'ACCEPTED');
          if (acceptedItem) {
            taskPhase.set(capTask.id, 'started');
            return { type: 'StartTask', backlogItemId: acceptedItem.id };
          }
          taskPhase.set(capTask.id, 'reported');
          return {
            type: 'DraftMessage',
            to:   { type: 'AGENT', id: args.managerId },
            kind: 'REPORT',
            subject: `Report from researcher-a: ${capTask.subject}`,
            bodySeed: generateReportBody(capTask),
          };
        }
      }

      // ── 4. started → DraftMessage REPORT ──────────────────────────────────
      const startedTask = context.inbox.find(
        (m) => m.kind === 'TASK' && taskPhase.get(m.id) === 'started',
      );
      if (startedTask) {
        taskPhase.set(startedTask.id, 'reported');
        return {
          type: 'DraftMessage',
          to:   { type: 'AGENT', id: args.managerId },
          kind: 'REPORT',
          subject: `Report from ${args.role}: ${startedTask.subject}`,
          bodySeed: generateReportBody(startedTask),
        };
      }

      // ── 5. reported → role-specific follow-up ─────────────────────────────
      const reportedTask = context.inbox.find(
        (m) => m.kind === 'TASK' && taskPhase.get(m.id) === 'reported',
      );
      if (reportedTask) {
        if (args.role === 'researcher-a') {
          taskPhase.set(reportedTask.id, 'compression-requested');
          return { type: 'RequestCompressionRefresh' };
        }
        if (args.role === 'writer') {
          taskPhase.set(reportedTask.id, 'promotion-requested');
          return {
            type: 'RequestPromotion',
            targetRole: 'Senior Research Writer',
            reasonProse: 'Consistently delivering high-quality synthesis briefs with accurate source tracing.',
            evidenceMessageIds: [reportedTask.id],
          };
        }
        // Bob: ContinueTask on any in-progress backlog, then rest
        const inProgress = context.backlog.find((b) => b.status === 'IN_PROGRESS');
        if (inProgress) {
          taskPhase.set(reportedTask.id, 'done');
          return { type: 'ContinueTask', backlogItemId: inProgress.id };
        }
        taskPhase.set(reportedTask.id, 'done');
      }

      // ── 6. compression-requested or promotion-requested → done ────────────
      const followUpTask = context.inbox.find(
        (m) =>
          m.kind === 'TASK' &&
          (taskPhase.get(m.id) === 'compression-requested' || taskPhase.get(m.id) === 'promotion-requested'),
      );
      if (followUpTask) {
        taskPhase.set(followUpTask.id, 'done');
      }

      return { type: 'CheckpointAndRest', nextTickAt: nextTickIso(now, 2) };
    },
  };
}

/**
 * Multiplex policy: routes each heartbeat tick to the correct per-agent policy.
 * Falls back to the standard policy for agents without a dedicated entry.
 *
 * @param policies Map keyed by agent id to role-specific policy implementation.
 * @returns A single policy facade accepted by createHeartbeat.
 */
function createMultiplexPolicy(policies: Map<string, AttentionPolicy>): AttentionPolicy {
  const standard = createStandardAttentionPolicy();
  return {
    key: 'multiplex-research-v1',
    async decide(context: AttentionContext, ctx): Promise<AttentionAction> {
      const policy = policies.get(context.agent.id) ?? standard;
      return policy.decide(context, ctx);
    },
  };
}

// ─── Heartbeat Scheduler ──────────────────────────────────────────────────────

/**
 * Queues one scheduled heartbeat tick per agent.
 *
 * @param args.store State store used to persist heartbeat ticks.
 * @param args.agents Agents that should receive new scheduled work.
 * @param args.workerId Scheduler identifier written into each tick record.
 * @returns Number of ticks created.
 */
async function scheduleHeartbeatTicks(args: {
  store: StateStore;
  agents: LiveAgent[];
  workerId: string;
}): Promise<number> {
  const scheduledFor = new Date().toISOString();
  let created = 0;
  for (const agent of args.agents) {
    const tick: HeartbeatTick = {
      id: makeId(`tick-${agent.id}`),
      agentId: agent.id,
      scheduledFor,
      pickedUpAt: null,
      completedAt: null,
      workerId: args.workerId,
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    };
    await args.store.saveHeartbeatTick(tick);
    created += 1;
  }
  return created;
}

/**
 * Starts the recurring heartbeat runtime and scheduler loop for the mesh.
 *
 * @param args.store State store backing agents, ticks, and messages.
 * @param args.mesh Mesh metadata used for runtime context scoping.
 * @param args.agents Team agents that should receive scheduled ticks.
 * @param args.policies Role-aware per-agent policy map.
 * @returns Active heartbeat instance and in-memory run logger.
 */
async function startHeartbeatRuntime(args: {
  store: StateStore;
  mesh: Mesh;
  agents: LiveAgent[];
  policies: Map<string, AttentionPolicy>;
}): Promise<{ heartbeat: Heartbeat; runLogger: InMemoryLiveAgentsRunLogger }> {
  const workerId = 'worker-research-team-1';
  const schedulerId = 'scheduler-research-team-1';
  const runLogger = new InMemoryLiveAgentsRunLogger();
  const multiplexPolicy = createMultiplexPolicy(args.policies);
  const useModelAttention = process.env['LIVE_AGENTS_MODEL_ATTENTION'] !== '0';

  const routedModels = new Map<string, Model>([
    ['demo:research-fast', createResearchAttentionModel('research-fast')],
    ['demo:research-quality', createResearchAttentionModel('research-quality')],
  ]);
  const router = new SmartModelRouter({
    candidates: [
      { providerId: 'demo', modelId: 'research-fast', capabilities: ['attention'] },
      { providerId: 'demo', modelId: 'research-quality', capabilities: ['attention'] },
    ],
  });
  const routingPolicy: RoutingPolicy = {
    id: 'live-agents-research-attention',
    name: 'Live Agents Research Attention',
    strategy: 'balanced',
    enabled: true,
    fallbackProviderId: 'demo',
    fallbackModelId: 'research-fast',
  };

  const modelBackedPolicy: AttentionPolicy = {
    key: 'model-routed-research-v1',
    async decide(context, ctx): Promise<AttentionAction> {
      try {
        const first = context.inbox.find((m) => m.status === 'PENDING' || m.status === 'DELIVERED');
        const decision = await router.route(
          {
            prompt: first
              ? `${context.agent.role} attention for ${first.kind}:${first.subject}`
              : `${context.agent.role} attention with no pending inbox items`,
            context: {
              taskType: 'live-agents-attention',
              tenantId: ctx.tenantId,
            },
          },
          routingPolicy,
        );

        const model = routedModels.get(`${decision.providerId}:${decision.modelId}`)
          ?? routedModels.get('demo:research-fast')!;

        const response = await model.generate(ctx, {
          messages: [
            {
              role: 'system',
              content: 'Return JSON: {"action":{"type":"..."}} and choose one valid live-agents action.',
            },
            {
              role: 'user',
              content: [
                'Context JSON:',
                JSON.stringify({
                  nowIso: context.nowIso,
                  inbox: context.inbox,
                  backlog: context.backlog,
                  contract: context.contract,
                  activeBindings: context.activeBindings,
                  agent: context.agent,
                }),
              ].join('\n'),
            },
          ],
          responseFormat: { type: 'json_object' },
          temperature: 0,
          maxTokens: 500,
        });

        const parsed = JSON.parse(response.content) as { action?: AttentionAction };
        if (parsed.action && parsed.action.type) {
          return parsed.action;
        }
        return multiplexPolicy.decide(context, ctx);
      } catch {
        return multiplexPolicy.decide(context, ctx);
      }
    },
  };

  const heartbeat = createHeartbeat({
    stateStore: args.store,
    workerId,
    concurrency: Math.max(1, args.agents.length),
    attentionPolicy: useModelAttention ? modelBackedPolicy : multiplexPolicy,
    actionExecutor: createActionExecutor({ observability: { runLogger } }),
    runOptions: {
      runPollIntervalMs: 200,
      leaseDurationMs: 30_000,
      observability: { runLogger },
    },
  });

  const initiallyScheduled = await scheduleHeartbeatTicks({
    store: args.store,
    agents: args.agents,
    workerId: schedulerId,
  });
  flow('HB schedule', `Initial ticks queued: ${initiallyScheduled}`);

  const schedulerTimer = setInterval(async () => {
    try {
      const created = await scheduleHeartbeatTicks({
        store: args.store,
        agents: args.agents,
        workerId: schedulerId,
      });
      flow('HB schedule', `Recurring ticks: ${created} | total runs: ${runLogger.listRunLogs().length}`);
    } catch (error) {
      console.warn('Heartbeat scheduler failed:', error instanceof Error ? error.message : String(error));
    }
  }, HEARTBEAT_SCHEDULE_MS);
  schedulerTimer.unref();

  void heartbeat
    .run(weaveContext({
      userId: 'human:ops-admin-1',
      tenantId: args.mesh.tenantId,
      metadata: { runtime: 'heartbeat-loop' },
    }))
    .catch((error) => {
      console.error('Heartbeat runtime stopped with error:', error);
    });

  flow(
    'HB run',
    `Heartbeat started (worker=${workerId}, policy=${useModelAttention ? 'model-routed-research-v1' : 'multiplex-research-v1'})`,
  );
  return { heartbeat, runLogger };
}

type AgentDirectory = {
  manager: LiveAgent;
  researcherA: LiveAgent;
  researcherB: LiveAgent;
  writer: LiveAgent;
};

/**
 * Persists a message tied to a logical thread with consistent defaults.
 *
 * @param args.store State store used to save the message.
 * @param args.meshId Mesh id containing the conversation.
 * @param args.threadId Thread identifier that groups related messages.
 * @param args.fromType Sender actor type.
 * @param args.fromId Sender actor id.
 * @param args.toType Recipient actor type.
 * @param args.toId Recipient actor id, or null for non-addressed recipients.
 * @param args.kind Message kind controlling downstream policy behavior.
 * @param args.subject Message subject line.
 * @param args.body Message body content.
 * @param args.createdAt Optional message creation timestamp.
 * @param args.priority Optional message priority.
 * @returns The persisted message object.
 */
async function saveMessageForThread(args: {
  store: StateStore;
  meshId: string;
  threadId: string;
  fromType: Message['fromType'];
  fromId: string;
  toType: Message['toType'];
  toId: string | null;
  kind: Message['kind'];
  subject: string;
  body: string;
  createdAt?: string;
  priority?: Message['priority'];
}): Promise<Message> {
  const createdAt = args.createdAt ?? new Date().toISOString();
  const message: Message = {
    id: makeId('msg'),
    meshId: args.meshId,
    fromType: args.fromType,
    fromId: args.fromId,
    fromMeshId: null,
    toType: args.toType,
    toId: args.toId,
    topic: 'email-action',
    kind: args.kind,
    replyToMessageId: null,
    threadId: args.threadId,
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: args.priority ?? 'NORMAL',
    status: 'DELIVERED',
    deliveredAt: createdAt,
    readAt: createdAt,
    processedAt: null,
    createdAt,
    subject: args.subject,
    body: args.body,
  };
  await args.store.saveMessage(message);
  return message;
}

/**
 * Executes a deterministic in-memory simulation of the multi-agent email workflow.
 *
 * @param args.store State store receiving simulated state transitions.
 * @param args.mesh Mesh context used to route and persist records.
 * @param args.agents Agent directory used for sender and recipient ids.
 * @param args.emailId Unique email id used to derive thread id.
 * @param args.subject Email subject for task and report text.
 * @param args.body Email body used to derive synthetic work outputs.
 */
async function executeEmailActionWorkflow(args: {
  store: StateStore;
  mesh: Mesh;
  agents: AgentDirectory;
  emailId: string;
  subject: string;
  body: string;
}): Promise<void> {
  const threadId = `thread-email-${args.emailId}`;
  const now = new Date().toISOString();
  const topic = args.subject.trim() || 'Untitled topic';
  const bodySignals = args.body
    .split(/\.|\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 3);

  const researcherAOutput = [
    `Topic interpreted: ${topic}`,
    `Primary asks: ${bodySignals[0] ?? 'No explicit ask detected; request clarification.'}`,
    'Acceptance criteria: includes scope, expected deliverable, and timeline assumptions.',
  ].join(' | ');

  const researcherBOutput = [
    'Constraints identified: limited source context from a single email.',
    `Risk highlights: ${bodySignals[1] ?? 'Potential ambiguity in expected output format.'}`,
    'Mitigation: propose options and confirm preferred output format before execution.',
  ].join(' | ');

  const writerOutput = [
    'Execution brief drafted with sections: objective, evidence, risks, actions, owners.',
    `Draft recommendation: ${bodySignals[2] ?? 'Proceed with a phased research plan and checkpoint review.'}`,
    'Delivery format: concise summary + actionable next steps.',
  ].join(' | ');

  const managerSummaryOutput = [
    `Thread ${threadId} closed with coordinated team output for '${topic}'.`,
    'Decision package includes criteria extraction, risk assessment, and execution brief.',
    'Next action: await human confirmation or additional scope details.',
  ].join(' | ');

  flow('1/9 ingress', `Email ${args.emailId} routed to manager ${args.agents.manager.name}`);

  await saveMessageForThread({
    store: args.store,
    meshId: args.mesh.id,
    threadId,
    fromType: 'INGRESS',
    fromId: 'gmail-ingress',
    toType: 'AGENT',
    toId: args.agents.manager.id,
    kind: 'TASK',
    subject: `Incoming email: ${args.subject}`,
    body: args.body,
    createdAt: now,
    priority: 'HIGH',
  });

  const taskA = await saveMessageForThread({
    store: args.store,
    meshId: args.mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: args.agents.manager.id,
    toType: 'AGENT',
    toId: args.agents.researcherA.id,
    kind: 'TASK',
    subject: 'Task: Extract request and acceptance criteria',
    body: `From email '${args.subject}', extract requested outcomes and acceptance criteria.`,
    priority: 'HIGH',
  });
  flow('2/9 delegate', `${args.agents.manager.name} -> ${args.agents.researcherA.name}: extract criteria`);

  const taskB = await saveMessageForThread({
    store: args.store,
    meshId: args.mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: args.agents.manager.id,
    toType: 'AGENT',
    toId: args.agents.researcherB.id,
    kind: 'TASK',
    subject: 'Task: Validate constraints and risks',
    body: `Analyze constraints, dependencies, and risks from email '${args.subject}'.`,
    priority: 'HIGH',
  });
  flow('3/9 delegate', `${args.agents.manager.name} -> ${args.agents.researcherB.name}: validate risks`);

  const taskC = await saveMessageForThread({
    store: args.store,
    meshId: args.mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: args.agents.manager.id,
    toType: 'AGENT',
    toId: args.agents.writer.id,
    kind: 'TASK',
    subject: 'Task: Draft execution plan',
    body: `Draft action plan and owner assignment for email '${args.subject}'.`,
    priority: 'HIGH',
  });
  flow('4/9 delegate', `${args.agents.manager.name} -> ${args.agents.writer.name}: draft execution plan`);

  const backlogItems = [
    { id: makeId('bl'), agent: args.agents.researcherA, task: taskA, title: 'Extract request criteria' },
    { id: makeId('bl'), agent: args.agents.researcherB, task: taskB, title: 'Assess constraints and risks' },
    { id: makeId('bl'), agent: args.agents.writer, task: taskC, title: 'Draft execution brief' },
  ];

  for (const item of backlogItems) {
    const at = new Date().toISOString();
    await args.store.saveBacklogItem({
      id: item.id,
      agentId: item.agent.id,
      priority: 'HIGH',
      status: 'ACCEPTED',
      originType: 'MESSAGE',
      originRef: item.task.id,
      blockedOnMessageId: null,
      blockedOnGrantRequestId: null,
      blockedOnPromotionRequestId: null,
      blockedOnAccountBindingRequestId: null,
      estimatedEffort: 'PT20M',
      deadline: null,
      acceptedAt: at,
      startedAt: null,
      completedAt: null,
      createdAt: at,
      title: item.title,
      description: item.task.body,
    });
    await args.store.transitionBacklogItemStatus(item.id, 'IN_PROGRESS', new Date().toISOString());
    flow('5/9 execute', `${item.agent.name} started: ${item.title}`);
    await args.store.transitionBacklogItemStatus(item.id, 'COMPLETED', new Date().toISOString());
    flow('6/9 complete', `${item.agent.name} completed: ${item.title}`);
  }

  await saveMessageForThread({
    store: args.store,
    meshId: args.mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: args.agents.researcherA.id,
    toType: 'AGENT',
    toId: args.agents.manager.id,
    kind: 'REPORT',
    subject: 'Report: Request criteria extracted',
    body: `Key asks extracted from '${args.subject}' and normalized into action items.`,
  });
  flow('7/9 report', `${args.agents.researcherA.name} reported to ${args.agents.manager.name}`);
  console.log(`[OUTPUT] ${args.agents.researcherA.name}: ${researcherAOutput}`);

  await saveMessageForThread({
    store: args.store,
    meshId: args.mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: args.agents.researcherB.id,
    toType: 'AGENT',
    toId: args.agents.manager.id,
    kind: 'REPORT',
    subject: 'Report: Constraints validated',
    body: `Risk and dependency scan completed for '${args.subject}'.`,
  });
  flow('7/9 report', `${args.agents.researcherB.name} reported to ${args.agents.manager.name}`);
  console.log(`[OUTPUT] ${args.agents.researcherB.name}: ${researcherBOutput}`);

  await saveMessageForThread({
    store: args.store,
    meshId: args.mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: args.agents.writer.id,
    toType: 'AGENT',
    toId: args.agents.manager.id,
    kind: 'REPORT',
    subject: 'Report: Action plan drafted',
    body: `Execution brief is ready for '${args.subject}' with owners and next steps.`,
  });
  flow('7/9 report', `${args.agents.writer.name} reported to ${args.agents.manager.name}`);
  console.log(`[OUTPUT] ${args.agents.writer.name}: ${writerOutput}`);

  await saveMessageForThread({
    store: args.store,
    meshId: args.mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: args.agents.manager.id,
    toType: 'HUMAN',
    toId: 'human-ops',
    kind: 'REPORT',
    subject: `Team delivery summary: ${args.subject}`,
    body: 'Team coordinated and executed requested email action.',
  });
  flow('8/9 summarize', `${args.agents.manager.name} posted human summary for thread ${threadId}`);
  console.log(`[OUTPUT] ${args.agents.manager.name}: ${managerSummaryOutput}`);

  const threadMessages = await args.store.listThreadMessages(threadId);
  const participantIds = new Set(
    threadMessages
      .filter((msg) => msg.fromType === 'AGENT')
      .map((msg) => msg.fromId),
  );
  const expected = [
    args.agents.manager.id,
    args.agents.researcherA.id,
    args.agents.researcherB.id,
    args.agents.writer.id,
  ];
  const allParticipated = expected.every((id) => participantIds.has(id));

  flow('9/9 participation', `Agents active in thread: ${Array.from(participantIds).join(', ')}`);
  console.log(`Email action thread ${threadId} participants: ${Array.from(participantIds).join(', ')}`);
  console.log(`All live agents participated: ${allParticipated}`);
}

/**
 * Push-based Gmail subscription as an AsyncGenerator.
 *
 * Internally calls liveGmailAdapter.subscribeInbox (History API poll) and
 * bridges its callback model into an async-iterable stream so callers can
 * simply `for await (const msg of streamGmailMessages(creds)) { ... }`
 * with no outer poll loop.
 */
async function* streamGmailMessages(
  getCreds: () => GmailCredentials,
  signal?: AbortSignal,
): AsyncGenerator<GmailMessage, void, void> {
  const queue: GmailMessage[] = [];
  let wakeup: (() => void) | null = null;
  let stopped = false;

  const handle = await liveGmailAdapter.subscribeInbox(getCreds(), async (message) => {
    queue.push(message);
    if (queue.length > 200) queue.shift();
    wakeup?.();
  });

  const onAbort = () => {
    stopped = true;
    handle.stop();
    wakeup?.();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (!stopped) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          wakeup = resolve;
        });
        wakeup = null;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    handle.stop();
  }
}

/**
 * Watches Gmail ingress events, routes them into live-agents state, and optionally
 * sends an acknowledgement email via an MCP-exposed send tool.
 *
 * @param args.store State store for accounts, routes, events, messages, and backlog.
 * @param args.mesh Mesh used for route and account scoping.
 * @param args.agents Directory of manager/specialist agents.
 */
async function watchAndReplyToNewEmails(args: {
  store: StateStore;
  mesh: Mesh;
  agents: AgentDirectory;
}): Promise<void> {
  const accessToken = requireEnv('GMAIL_ACCESS_TOKEN');
  const refreshToken = process.env['GMAIL_REFRESH_TOKEN'] ?? '';
  const userId = process.env['GMAIL_USER_ID'] ?? 'me';

  const { server, endpoint } = await weaveRealMCPTransport();
  const externalEventHandler = createExternalEventHandler({ stateStore: args.store });
  const ingressAccountId = 'account-gmail-ingress';
  // Route ONLY to Carol (manager). She will delegate to specialists via DraftMessage.
  const routeTargets: LiveAgent[] = [args.agents.manager];
  const specialistAgents: LiveAgent[] = [
    args.agents.researcherA,
    args.agents.researcherB,
    args.agents.writer,
  ];

  await args.store.saveAccount({
    id: ingressAccountId,
    meshId: args.mesh.id,
    provider: 'gmail',
    accountIdentifier: userId,
    description: 'Gmail ingress account for research-team watcher',
    mcpServerRef: {
      url: endpoint,
      serverType: 'HTTP',
      discoveryHint: 'Example 53 local Gmail MCP transport',
    },
    credentialVaultRef: 'env:GMAIL_ACCESS_TOKEN',
    upstreamScopesDescription: 'gmail.readonly,gmail.send',
    ownerHumanId: 'human:ops-admin-1',
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    revokedAt: null,
  });

  for (const agent of routeTargets) {
    await args.store.saveEventRoute({
      id: `route-gmail-${agent.id}`,
      meshId: args.mesh.id,
      accountId: ingressAccountId,
      matchDescriptionProse: `Route Gmail ingress events to ${agent.name}.`,
      matchExpr: 'sourceType:gmail.message.received',
      targetType: 'AGENT',
      targetId: agent.id,
      targetTopic: 'email-ingress',
      priorityOverride: 'HIGH',
      enabled: true,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Builds Gmail credentials object expected by the Gmail adapter.
   *
   * @returns Credentials with a refresh callback derived from environment values.
   */
  function creds(): GmailCredentials {
    return {
      accessToken,
      userId,
      refreshAccessToken: async () => refreshToken || undefined,
    };
  }

  server.addTool(
    {
      name: 'gmail.send',
      description: 'Send an email via Gmail.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'array', items: { type: 'string' } },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    async (_ctx, args) => {
      const a = args as Record<string, unknown>;
      const to = Array.isArray(a['to']) ? (a['to'] as unknown[]).map(String) : [];
      const subject = String(a['subject'] ?? '');
      const body = String(a['body'] ?? '');
      const result = await liveGmailAdapter.sendMessage(creds(), to, subject, body);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  const client = weaveMCPClient();
  await client.connect(createMCPStreamableHttpTransport(endpoint));

  const ctx = weaveContext({
    userId: 'email-responder',
    metadata: {
      gmailAccessToken: accessToken,
      gmailRefreshAccessToken: refreshToken,
      gmailUserId: userId,
    },
  });

  /**
   * Schedules manager attention immediately after a relevant ingress trigger.
   *
   * @param trigger Human-readable trigger reason for flow logs.
   */
  async function queueHeartbeatTicks(trigger: string): Promise<void> {
    // Queue a tick ONLY for Carol — she will delegate and specialists get their own ticks
    await args.store.saveHeartbeatTick({
      id: makeId(`tick-${args.agents.manager.id}`),
      agentId: args.agents.manager.id,
      scheduledFor: new Date().toISOString(),
      pickedUpAt: null,
      completedAt: null,
      workerId: 'scheduler-email-watcher',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    });
    flow('HB schedule', `Queued heartbeat tick for manager after ${trigger}`);
  }

  const knownIds = new Set<string>();
  const abortController = new AbortController();
  const onSignal = () => abortController.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  console.log(`Email watcher started for ${TARGET_SENDER}.`);
  flow('0/9 startup', 'Gmail event stream opened (push-based, no poll loop)');

  for await (const msg of streamGmailMessages(creds, abortController.signal)) {
    if (knownIds.has(msg.id)) continue;
    if (!(msg.from ?? '').toLowerCase().includes(TARGET_SENDER.toLowerCase())) {
      knownIds.add(msg.id);
      continue;
    }

    const subject = msg.subject?.trim() || '(no subject)';
    const bodyPreview = (msg.body ?? '').slice(0, 400);

    console.log(`New email from ${TARGET_SENDER}: ${subject}`);
    flow('trigger', `New eligible email detected: ${msg.id}`);

    const eventResult = await externalEventHandler.process(
      {
        id: makeId('evt-gmail'),
        accountId: ingressAccountId,
        sourceType: 'gmail.message.received',
        sourceRef: msg.id,
        receivedAt: new Date().toISOString(),
        payloadSummary: `From ${msg.from || 'unknown'} | Subject: ${subject} | Preview: ${bodyPreview.slice(0, 160)}`,
        payloadContextRef: `gmail://message/${msg.id}`,
        processedAt: null,
        producedMessageIds: [],
        processingStatus: 'RECEIVED',
        error: null,
      },
      ctx,
    );
    flow('route', `External event routed to ${eventResult.routedMessageCount} live-agent inbox(es)`);

    // Pre-create ACCEPTED backlog items for each specialist so their policies can call StartTask
    const threadId = msg.id;
    for (const specialist of specialistAgents) {
      await args.store.saveBacklogItem({
        id: makeId(`backlog-${specialist.id}-${threadId.slice(-6)}`),
        agentId: specialist.id,
        status: 'ACCEPTED',
        priority: 'HIGH',
        originType: 'INGRESS',
        originRef: `gmail://message/${threadId}`,
        blockedOnMessageId: null,
        blockedOnGrantRequestId: null,
        blockedOnPromotionRequestId: null,
        blockedOnAccountBindingRequestId: null,
        estimatedEffort: 'PT2H',
        deadline: null,
        acceptedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        createdAt: new Date().toISOString(),
        title: `Research task for email ${threadId.slice(-6)}`,
        description: `Work item pre-created by manager for email thread ${threadId}. Awaiting delegation.`,
      });
    }
    flow('backlog', `Pre-created ${specialistAgents.length} ACCEPTED backlog items for specialists`);

    await queueHeartbeatTicks(`ingress:${msg.id}`);

    if (ENABLE_EMAIL_SEND) {
      try {
        await client.callTool(ctx, {
          name: 'gmail.send',
          arguments: {
            to: [TARGET_SENDER],
            subject: `Re: ${subject}`,
            body: [
              'Automatic reply from the live-agents watcher.',
              '',
              `Received your new email: ${subject}`,
              '',
              'Body preview:',
              bodyPreview || '(empty)',
            ].join('\n'),
          },
        });
      } catch (error) {
        console.warn(`Reply send failed for ${msg.id}; will skip:`, error instanceof Error ? error.message : String(error));
      }
    } else {
      console.log('Send step disabled (set GMAIL_ENABLE_SEND=1 to enable gmail.send).');
    }

    knownIds.add(msg.id);
    console.log(`Processed message ${msg.id}.`);
  }

  // Unreachable by design because this example continuously watches email.
  // Cleanup would happen on process exit.
  // await client.disconnect();
}

/**
 * Constructs an agent contract with role-shaped persona/objective content and
 * standard budget/context defaults for this example.
 *
 * @param args.id Contract id.
 * @param args.agentId Agent id this contract belongs to.
 * @param args.persona Base persona text seeded by caller.
 * @param args.objectives Base objective text seeded by caller.
 * @param args.role Human-readable role label used for role-specific expansions.
 * @param args.roleAuthority Whether the role may issue grants.
 * @returns Fully assembled contract object.
 */
function contractForAgent(args: {
  id: string;
  agentId: string;
  persona: string;
  objectives: string;
  role: string;
  roleAuthority?: boolean;
}): AgentContract {
  const role = args.role.toLowerCase();

  const personaByRole = role.includes('manager')
    ? [
      'You are an operations-minded research manager.',
      'You maintain delivery quality, timeline discipline, and escalation hygiene.',
      'You prioritize evidence-backed decisions and explicit ownership.',
    ].join(' ')
    : role.includes('writer')
      ? [
        'You are a synthesis-first research writer and communicator.',
        'You transform fragmented findings into clear, decision-ready outputs.',
        'You preserve source traceability and confidence levels in every summary.',
      ].join(' ')
      : [
        'You are a rigorous domain researcher.',
        'You test assumptions, gather corroborating evidence, and quantify uncertainty.',
        'You surface contradictions early and recommend next best actions.',
      ].join(' ');

  const objectivesByRole = role.includes('manager')
    ? [
      'Convert inbound user topics into clear research missions with scope boundaries.',
      'Break work into parallel tasks across specialists and enforce completion SLAs.',
      'Escalate blockers quickly with concrete options and impact analysis.',
      'Approve final synthesis only when evidence quality and coverage are sufficient.',
    ].join(' ')
    : role.includes('writer')
      ? [
        'Create concise research briefs from specialist outputs.',
        'Produce final deliverables with executive summary, findings, risks, and recommendations.',
        'Ensure each claim is traceable to a source or explicitly marked as hypothesis.',
        'Adapt tone and structure to stakeholder intent in the received topic request.',
      ].join(' ')
      : [
        'Investigate user-provided topics with breadth-first scan then depth-first validation.',
        'Extract key facts, conflicting claims, and unknowns requiring follow-up.',
        'Assess evidence quality and confidence for each finding.',
        'Deliver structured outputs enabling downstream synthesis and action planning.',
      ].join(' ');

  const successByRole = role.includes('manager')
    ? [
      'Work is delegated with explicit owner, deadline, and acceptance criteria.',
      'No critical blocker remains un-escalated beyond one cycle.',
      'Final output is decision-ready and aligned to original user topic.',
      'At least one explicit risk and mitigation is documented when uncertainty is high.',
    ].join(' ')
    : role.includes('writer')
      ? [
        'Deliverables are clear, structured, and aligned to stakeholder ask.',
        'Every major claim has confidence annotations and source trace references.',
        'Open questions and recommended next actions are explicit.',
        'Summary can be consumed in under five minutes without loss of key signal.',
      ].join(' ')
      : [
        'Findings are specific, testable, and evidence-tagged.',
        'Contradictory evidence is surfaced, not hidden.',
        'Assumptions are clearly labeled and bounded.',
        'Output contains practical recommendations for the team to execute.',
      ].join(' ');

  const operatingGuide = [
    'Operating protocol: 1) Clarify objective. 2) Plan approach. 3) Execute research tasks. 4) Validate evidence. 5) Communicate outcomes with risks and confidence.',
    'Quality gates: relevance to user topic, source credibility, contradiction check, recency check, and actionability.',
    'Escalation policy: if blocked by missing data, ambiguity, or conflict in evidence, escalate with two concrete options and expected trade-offs.',
    'Communication standard: concise, structured, and explicit about uncertainty. Never present assumptions as verified facts.',
  ].join(' ');

  return {
    id: args.id,
    agentId: args.agentId,
    version: 1,
    persona: `${args.persona} ${personaByRole}`,
    objectives: `${args.objectives} ${objectivesByRole} ${operatingGuide}`,
    successIndicators: `${successByRole} Research progress is shared and traceable across messages, backlog updates, and manager summaries.`,
    budget: {
      monthlyUsdCap: 80,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    grantAuthority: args.roleAuthority
      ? {
        mayIssueKinds: ['AUTHORITY_EXTENSION', 'COLLEAGUE_INTRODUCTION'],
        scopePredicate: 'agents in same mesh',
        maxBudgetIncreaseUsd: null,
        requiresEvidence: false,
        dualControl: false,
      }
      : null,
    contractAuthority: null,
    breakGlass: null,
    accountBindingRefs: [],
    attentionPolicyRef: 'research-team',
    reviewCadence: 'P1D',
    contextPolicy: {
      compressors: [],
      weighting: [],
      budgets: {
        attentionTokensMax: 1000,
        actionTokensMax: 1000,
        handoffTokensMax: 500,
        reportTokensMax: 500,
        monthlyCompressionUsdCap: 5,
      },
      defaultsProfile: 'knowledge-worker',
    },
    createdAt: '2025-06-02T09:00:00.000Z',
  };
}

/**
 * Bootstraps full example runtime: mesh and agents, contracts, account binding,
 * bridge wiring, heartbeat runtime, optional simulation flow, and live Gmail loop.
 */
async function main() {
  weaveSetDefaultTracer(weaveConsoleTracer());

  const store = weaveInMemoryStateStore();
  const executor = createActionExecutor();
  const now = '2025-06-02T09:00:00.000Z';

  // ── Runtime ──────────────────────────────────────────────────────────────
  // createLiveAgentsRuntime provides: stateStore binding + built-in compressor map.
  const runtime = createLiveAgentsRuntime({ stateStore: store });
  flow('runtime', `Live-agents runtime created (compressors: ${Object.keys(runtime.compressors).join(', ')})`);

  const mesh: Mesh = {
    id: 'mesh-research-team',
    tenantId: 'tenant-live-agents-research-team',
    name: 'Research Mesh',
    charter: 'Coordinate asynchronous research tasks and evidence handoffs.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const manager: LiveAgent = {
    id: 'agent-manager',
    meshId: mesh.id,
    name: 'Carol',
    role: 'Research Manager',
    contractVersionId: 'contract-manager-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const teamAgents: LiveAgent[] = [
    manager,
    {
      id: 'agent-researcher-a',
      meshId: mesh.id,
      name: 'Alice',
      role: 'Researcher',
      contractVersionId: 'contract-researcher-a-v1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
    {
      id: 'agent-researcher-b',
      meshId: mesh.id,
      name: 'Bob',
      role: 'Researcher',
      contractVersionId: 'contract-researcher-b-v1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
    {
      id: 'agent-writer',
      meshId: mesh.id,
      name: 'Dana',
      role: 'Writer',
      contractVersionId: 'contract-writer-v1',
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
  ];

  await store.saveMesh(mesh);
  for (const agent of teamAgents) {
    await store.saveAgent(agent);
  }

  // ── Team ─────────────────────────────────────────────────────────────────
  const team: Team = {
    id: 'team-research-strike',
    meshId: mesh.id,
    name: 'Research Strike Team',
    charter: 'Rapid coordinated research in response to inbound email topics.',
    leadAgentId: manager.id,
  };
  await store.saveTeam(team);

  const teamMemberships: TeamMembership[] = [
    { id: 'tm-carol', teamId: team.id, agentId: manager.id,     roleInTeam: 'Lead',              joinedAt: now, leftAt: null },
    { id: 'tm-alice', teamId: team.id, agentId: teamAgents[1]!.id, roleInTeam: 'Primary Researcher', joinedAt: now, leftAt: null },
    { id: 'tm-bob',   teamId: team.id, agentId: teamAgents[2]!.id, roleInTeam: 'Risk Analyst',      joinedAt: now, leftAt: null },
    { id: 'tm-dana',  teamId: team.id, agentId: teamAgents[3]!.id, roleInTeam: 'Synthesis Writer',  joinedAt: now, leftAt: null },
  ];
  for (const m of teamMemberships) {
    await store.saveTeamMembership(m);
  }
  flow('team', `Team "${team.name}" created with ${teamMemberships.length} members`);

  // ── Account + AccountBinding (human binds gmail to Carol — invariant) ────
  // Per ADR-001: ONLY humans may bind accounts to agents.
  const gmailOpsAccount = {
    id:                      'account-gmail-ops',
    meshId:                  mesh.id,
    provider:                'gmail',
    accountIdentifier:       process.env['GMAIL_USER_ID'] ?? 'me',
    description:             'Gmail send-only account used by Carol for research escalation notices.',
    mcpServerRef:            { url: 'http://localhost:7462/mcp', serverType: 'HTTP' as const, discoveryHint: 'local gmail ops' },
    credentialVaultRef:      'env:GMAIL_ACCESS_TOKEN',
    upstreamScopesDescription: 'gmail.send',
    ownerHumanId:            'human:ops-admin-1',
    status:                  'ACTIVE' as const,
    createdAt:               now,
    revokedAt:               null,
  };
  await store.saveAccount(gmailOpsAccount);

  const carolBinding: AccountBinding = {
    id:               'binding-carol-gmail-ops',
    agentId:          manager.id,
    accountId:        gmailOpsAccount.id,
    purpose:          'Send research summaries via Gmail when escalating findings to human operators.',
    constraints:      'Send-only; no read or delete; restricted to single recipient domain.',
    grantedByHumanId: 'human:ops-admin-1',
    grantedAt:        now,
    expiresAt:        null,
    revokedAt:        null,
    revokedByHumanId: null,
    revocationReason: null,
  };
  await store.saveAccountBinding(carolBinding);
  flow('account', `Carol bound to gmail ops account (by human operator "ops-admin-1")`);

  // ── CrossMeshBridge (observer mesh audits research deliverables) ──────────
  const auditMeshId = 'mesh-audit-observer';
  const auditBridge: CrossMeshBridge = {
    id:                 'bridge-research-to-audit',
    fromMeshId:         mesh.id,
    toMeshId:           auditMeshId,
    allowedAgentPairs:  null,    // any agent pair
    allowedTopics:      ['research-deliverable', 'escalation'],
    rateLimitPerHour:   100,
    authorisedByType:   'HUMAN',
    authorisedById:     'human:ops-admin-1',
    coAuthorisedByType: null,
    coAuthorisedById:   null,
    effectiveFrom:      now,
    effectiveTo:        null,
    revokedAt:          null,
    purposeProse:       'Allow the audit observer mesh to receive research deliverables and escalation events.',
    constraintsProse:   'Read-only; topics: research-deliverable and escalation only.',
  };
  await store.saveCrossMeshBridge(auditBridge);
  flow('bridge', `CrossMeshBridge registered: ${mesh.id} → ${auditMeshId}`);

  await store.saveContract(contractForAgent({
    id: 'contract-manager-v1',
    agentId: manager.id,
    persona: 'Research manager prioritizing evidence-backed decisions.',
    objectives: 'Delegate and remove blockers.',
    role: manager.role,
    roleAuthority: true,
  }));
  await store.saveContract(contractForAgent({
    id: 'contract-researcher-a-v1',
    agentId: 'agent-researcher-a',
    persona: 'Market researcher focused on primary sources.',
    objectives: 'Collect verified source material.',
    role: teamAgents[1]!.role,
  }));
  await store.saveContract(contractForAgent({
    id: 'contract-researcher-b-v1',
    agentId: 'agent-researcher-b',
    persona: 'Competitive intelligence researcher.',
    objectives: 'Map competitor signal changes.',
    role: teamAgents[2]!.role,
  }));
  await store.saveContract(contractForAgent({
    id: 'contract-writer-v1',
    agentId: 'agent-writer',
    persona: 'Technical writer synthesizing findings.',
    objectives: 'Publish concise weekly updates.',
    role: teamAgents[3]!.role,
  }));

  await store.saveDelegationEdge({
    id: 'edge-manager-a',
    meshId: mesh.id,
    fromAgentId: manager.id,
    toAgentId: 'agent-researcher-a',
    relationship: 'DIRECTS',
    relationshipProse: 'Carol directs Alice on customer evidence collection.',
    effectiveFrom: now,
    effectiveTo: null,
  });
  await store.saveDelegationEdge({
    id: 'edge-manager-b',
    meshId: mesh.id,
    fromAgentId: manager.id,
    toAgentId: 'agent-researcher-b',
    relationship: 'DIRECTS',
    relationshipProse: 'Carol directs Bob on competitor analysis.',
    effectiveFrom: now,
    effectiveTo: null,
  });

  const ctx = weaveContext({ userId: 'human:ops-admin-1' });

  // ── Pre-seed a GRANT_REQUEST in Carol's inbox (from Alice) ────────────────
  // This allows createManagerPolicy to demonstrate IssueGrant in the live
  // heartbeat loop — Carol sees the request and authorises the grant on her
  // next tick (policy step 2).
  await store.saveMessage({
    id:        makeId('msg-grant-req'),
    meshId:    mesh.id,
    fromType:  'AGENT',
    fromId:    teamAgents[1]!.id,
    fromMeshId: mesh.id,
    toType:    'AGENT',
    toId:      manager.id,
    topic:     'capability-request',
    kind:      'GRANT_REQUEST',
    subject:   'Capability request: AUTHORITY_EXTENSION for restricted source lookup',
    body:      'Need temporary authority to access restricted source index for upcoming research task.',
    priority:  'HIGH',
    threadId:  'thread-pre-seed-grant-req',
    status:    'DELIVERED',
    createdAt: now,
    readAt:    null,
    processedAt: null,
    replyToMessageId: null,
    contextRefs:      [],
    contextPacketRef: null,
    expiresAt:        null,
    deliveredAt:      now,
  });

  flow('setup', `Pre-seeded GRANT_REQUEST message in Carol's inbox from Alice (IssueGrant demo)`);

  // ── Demonstrate RequestCapability + IssueGrant via executor (static setup) ─
  // The same actions will also fire live through the custom policies at runtime.
  await executor.execute(
    {
      type: 'RequestCapability',
      capability: {
        kindHint:         'AUTHORITY_EXTENSION',
        descriptionProse: 'Alice needs temporary authority to access the restricted source index.',
        reasonProse:      'Primary researcher role scope does not include restricted source retrieval.',
        evidenceMessageIds: [],
      },
    },
    { tickId: 'tick-setup-1', nowIso: now, stateStore: store, agent: teamAgents[1]!, activeBindings: [] },
    ctx,
  );

  await executor.execute(
    {
      type: 'IssueGrant',
      recipientAgentId: teamAgents[1]!.id,
      capability: {
        kindHint:         'AUTHORITY_EXTENSION',
        descriptionProse: 'Temporary authority for restricted source lookup — approved by manager.',
        scopeProse:       'Restricted source index; current research cycle only.',
        durationHint:     'PT4H',
        reasonProse:      'Approved by Carol (Research Manager) to unblock primary research task.',
      },
    },
    { tickId: 'tick-setup-2', nowIso: now, stateStore: store, agent: manager, activeBindings: [] },
    ctx,
  );

  const grantRequests = await store.listGrantRequests(mesh.id);
  const grants       = await store.listCapabilityGrantsForRecipient('AGENT', teamAgents[1]!.id);
  flow('grants', `Setup: grantRequests=${grantRequests.length}, active grants for Alice=${grants.length}`);

  // ── CompressionMaintainer ─────────────────────────────────────────────────
  // Runs periodically to compress each agent's context, keeping tokens within budget.
  const compressionMaintainer = createCompressionMaintainer({
    stateStore:    store,
    runIntervalMs: COMPRESSION_INTERVAL_MS,
    agentIds:      teamAgents.map((a) => a.id),
    onCompressed:  (payload, _compCtx) => {
      flow(
        'compress',
        `Agent ${payload.agentId} | profile=${payload.profile} | artefacts=${payload.artefactCount}`,
      );
    },
  });
  void compressionMaintainer.run(ctx).catch((err) => {
    console.warn('CompressionMaintainer error:', err instanceof Error ? err.message : String(err));
  });
  flow('compress', `CompressionMaintainer started (interval=${COMPRESSION_INTERVAL_MS}ms, agents=${teamAgents.length})`);

  // ── Per-agent policy map (passed to multiplex policy inside heartbeat) ────
  const policies = new Map<string, AttentionPolicy>([
    [manager.id,       createManagerPolicy()],
    [teamAgents[1]!.id, createSpecialistPolicy({ agentId: teamAgents[1]!.id, managerId: manager.id, role: 'researcher-a' })],
    [teamAgents[2]!.id, createSpecialistPolicy({ agentId: teamAgents[2]!.id, managerId: manager.id, role: 'researcher-b' })],
    [teamAgents[3]!.id, createSpecialistPolicy({ agentId: teamAgents[3]!.id, managerId: manager.id, role: 'writer' })],
  ]);

  console.log('Live-agents research team (Example 53) is wired and running.');
  console.log(`Agents in mesh: ${(await store.listAgents(mesh.id)).length}`);
  console.log(`Team memberships: ${(await store.listTeamMemberships(team.id)).length}`);
  console.log(`Account bindings (Carol): ${(await store.listAccountBindings(manager.id)).length}`);
  console.log(`Grant requests (startup): ${grantRequests.length}`);
  console.log(`Active grants for Alice: ${grants.length}`);

  const { runLogger } = await startHeartbeatRuntime({
    store,
    mesh,
    agents: teamAgents,
    policies,
  });

  if (SIMULATE_EMAIL_FLOW) {
    console.log('SIMULATE_EMAIL_FLOW=1: running synthetic end-to-end coordination flow.');
    await executeEmailActionWorkflow({
      store,
      mesh,
      agents: {
        manager,
        researcherA: teamAgents[1]!,
        researcherB: teamAgents[2]!,
        writer: teamAgents[3]!,
      },
      emailId: `sim-${Date.now()}`,
      subject: 'Simulated Request: Prepare research plan and risks',
      body: 'Please analyze scope, identify risks, and deliver an action plan with owners by EOD.',
    });
  }

  await watchAndReplyToNewEmails({
    store,
    mesh,
    agents: {
      manager,
      researcherA: teamAgents[1]!,
      researcherB: teamAgents[2]!,
      writer: teamAgents[3]!,
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
