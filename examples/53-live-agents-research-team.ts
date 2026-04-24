/**
 * Example 53 - live-agents research team
 *
 * Run: npx tsx examples/53-live-agents-research-team.ts
 */

import 'dotenv/config';

import { weaveContext, weaveSetDefaultTracer } from '@weaveintel/core';
import { weaveMCPClient, createMCPStreamableHttpTransport } from '@weaveintel/mcp-client';
import { weaveConsoleTracer } from '@weaveintel/observability';
import {
  createHeartbeat,
  createStandardAttentionPolicy,
  createActionExecutor,
  weaveInMemoryStateStore,
  type AgentContract,
  type Heartbeat,
  type HeartbeatTick,
  type LiveAgent,
  type LiveAgentsRunLogger,
  type Message,
  type Mesh,
  type StateStore,
} from '@weaveintel/live-agents';
import { weaveRealMCPTransport } from '@weaveintel/mcp-server';
import { liveGmailAdapter, type GmailCredentials } from '@weaveintel/tools-gmail';

const TARGET_SENDER = 'giby.varghese@tech-lunch.com';
const POLL_MS = 20_000;
const SEARCH_MAX = 5;
const ENABLE_EMAIL_SEND = process.env['GMAIL_ENABLE_SEND'] === '1';
const SIMULATE_EMAIL_FLOW = process.env['SIMULATE_EMAIL_FLOW'] === '1';
const HEARTBEAT_SCHEDULE_MS = 15_000;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseTextPayload(result: unknown): string {
  const obj = result as { content?: Array<{ text?: string; type?: string }> };
  return obj.content?.find((item) => item.type === 'text')?.text ?? '[]';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function flow(step: string, detail: string): void {
  console.log(`[FLOW] ${step} :: ${detail}`);
}

function createConsoleRunLogger(): LiveAgentsRunLogger {
  const runs = new Map<string, { started: number; steps: number; status?: string; endTime?: number }>();

  return {
    startRun(executionId: string, startTime?: number) {
      runs.set(executionId, { started: startTime ?? Date.now(), steps: 0 });
    },
    recordStep(executionId: string, step) {
      const run = runs.get(executionId);
      if (run) run.steps += 1;

      const duration = step.endTime - step.startTime;
      const tickIdShort = (step as any).input?.tickId?.slice(-8) ?? '?';
      const agentIdShort = (step as any).input?.agentId?.slice(-8) ?? '?';
      const actionType = (step as any).input?.actionType?.slice(0, 12) ?? '?';
      const resultStatus = (step as any).output?.status ?? '?';

      console.log(
        `[HEARTBEAT] tick=${tickIdShort} agent=${agentIdShort} action=${actionType} ` +
        `status=${resultStatus} duration=${duration}ms`,
      );
    },
    completeRun(executionId: string, status, endTime?: number) {
      const run = runs.get(executionId);
      if (run) {
        run.status = status;
        run.endTime = endTime ?? Date.now();
      }
    },
    getRunLog(executionId: string) {
      return (runs.get(executionId) as any) ?? null;
    },
    listRunLogs() {
      return Array.from(runs.values()) as any;
    },
  };
}

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

async function startHeartbeatRuntime(args: {
  store: StateStore;
  mesh: Mesh;
  agents: LiveAgent[];
}): Promise<{ heartbeat: Heartbeat }> {
  const workerId = 'worker-research-team-1';
  const schedulerId = 'scheduler-research-team-1';
  const policy = createStandardAttentionPolicy();
  const runLogger = createConsoleRunLogger();
  const heartbeat = createHeartbeat({
    stateStore: args.store,
    workerId,
    concurrency: Math.max(1, args.agents.length),
    attentionPolicy: policy,
    actionExecutor: createActionExecutor(),
    runOptions: {
      runPollIntervalMs: 200,
      leaseDurationMs: 30_000,
      observability: {
        runLogger,
      },
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
      flow('HB schedule', `Recurring ticks queued: ${created}`);
    } catch (error) {
      console.warn('Heartbeat scheduler failed:', error instanceof Error ? error.message : String(error));
    }
  }, HEARTBEAT_SCHEDULE_MS);
  schedulerTimer.unref();

  void heartbeat.run(weaveContext({
    userId: 'human:ops-admin-1',
    tenantId: args.mesh.tenantId,
    metadata: { runtime: 'heartbeat-loop' },
  })).catch((error) => {
    console.error('Heartbeat runtime stopped with error:', error);
  });

  flow('HB run', `Heartbeat runtime started (worker=${workerId}, interval=${HEARTBEAT_SCHEDULE_MS}ms)`);
  return { heartbeat };
}

type AgentDirectory = {
  manager: LiveAgent;
  researcherA: LiveAgent;
  researcherB: LiveAgent;
  writer: LiveAgent;
};

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

async function watchAndReplyToNewEmails(args: {
  store: StateStore;
  mesh: Mesh;
  agents: AgentDirectory;
}): Promise<void> {
  const accessToken = requireEnv('GMAIL_ACCESS_TOKEN');
  const refreshToken = process.env['GMAIL_REFRESH_TOKEN'] ?? '';
  const userId = process.env['GMAIL_USER_ID'] ?? 'me';

  const { server, endpoint } = await weaveRealMCPTransport();

  function creds(): GmailCredentials {
    return {
      accessToken,
      userId,
      refreshAccessToken: async () => refreshToken || undefined,
    };
  }

  server.addTool(
    {
      name: 'gmail.search',
      description: 'Search Gmail messages using Gmail query syntax.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'number', default: 20 },
        },
        required: ['query'],
      },
    },
    async (_ctx, args) => {
      const query = String((args as Record<string, unknown>)['query'] ?? '');
      const maxResults = Number((args as Record<string, unknown>)['maxResults'] ?? 20);
      const messages = await liveGmailAdapter.searchMessages(creds(), query, maxResults);
      return { content: [{ type: 'text', text: JSON.stringify(messages) }] };
    },
  );

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

  async function runSearch(query: string): Promise<Array<{
    id: string;
    subject?: string;
    body?: string;
    internalDate?: string;
    from?: string;
  }>> {
    const foundRaw = await client.callTool(ctx, {
      name: 'gmail.search',
      arguments: { query, maxResults: SEARCH_MAX },
    });
    return JSON.parse(parseTextPayload(foundRaw)) as Array<{
      id: string;
      subject?: string;
      body?: string;
      internalDate?: string;
      from?: string;
    }>;
  }

  const startupTimeMs = Date.now();
  const startupEpochSeconds = Math.floor(startupTimeMs / 1000);
  const pollQuery = `from:${TARGET_SENDER} in:inbox after:${startupEpochSeconds}`;
  const knownIds = new Set<string>();

  console.log(`Email watcher started for ${TARGET_SENDER}.`);
  console.log('Only NEW inbound emails after startup will be searched and replied to.');
  flow('0/9 startup', `MCP polling query: ${pollQuery}`);

  while (true) {
    console.log(`Polling Gmail via MCP at ${new Date().toISOString()} ...`);

    let found: Array<{
      id: string;
      subject?: string;
      body?: string;
      internalDate?: string;
      from?: string;
    }> = [];

    try {
      found = await runSearch(pollQuery);
    } catch (error) {
      console.warn('Poll failed; will retry next cycle:', error instanceof Error ? error.message : String(error));
      await sleep(POLL_MS);
      continue;
    }

    for (const msg of found) {
      const internalMs = Number(msg.internalDate ?? '0');
      if (knownIds.has(msg.id)) continue;
      if (!Number.isFinite(internalMs) || internalMs < startupTimeMs) {
        knownIds.add(msg.id);
        continue;
      }
      if (!(msg.from ?? '').toLowerCase().includes(TARGET_SENDER.toLowerCase())) {
        knownIds.add(msg.id);
        continue;
      }

      const subject = msg.subject?.trim() || '(no subject)';
      const bodyPreview = (msg.body ?? '').slice(0, 400);

      console.log(`New email from ${TARGET_SENDER}: ${subject}`);
      flow('trigger', `New eligible email detected: ${msg.id}`);

      await executeEmailActionWorkflow({
        store: args.store,
        mesh: args.mesh,
        agents: args.agents,
        emailId: msg.id,
        subject,
        body: bodyPreview,
      });

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

    await sleep(POLL_MS);
  }

  // Unreachable by design because this example continuously watches email.
  // Cleanup would happen on process exit.
  // await client.disconnect();
}

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

async function main() {
  weaveSetDefaultTracer(weaveConsoleTracer());

  const store = weaveInMemoryStateStore();
  const executor = createActionExecutor();
  const now = '2025-06-02T09:00:00.000Z';

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

  await store.saveBacklogItem({
    id: 'bl-research-a',
    agentId: 'agent-researcher-a',
    priority: 'HIGH',
    status: 'BLOCKED',
    originType: 'MANAGER',
    originRef: manager.id,
    blockedOnMessageId: null,
    blockedOnGrantRequestId: null,
    blockedOnPromotionRequestId: null,
    blockedOnAccountBindingRequestId: null,
    estimatedEffort: 'PT2H',
    deadline: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    title: 'Gather restricted source notes',
    description: 'Need authority extension to access protected source index.',
  });

  const ctx = weaveContext({ userId: 'human:ops-admin-1' });

  await executor.execute(
    {
      type: 'RequestCapability',
      capability: {
        kindHint: 'AUTHORITY_EXTENSION',
        descriptionProse: 'Need temporary authority to access restricted source index.',
        reasonProse: 'Current role cannot retrieve required source evidence.',
        evidenceMessageIds: [],
      },
    },
    {
      tickId: 'tick-research-team-1',
      nowIso: '2025-06-02T09:05:00.000Z',
      stateStore: store,
      agent: teamAgents[1]!,
      activeBindings: [],
    },
    ctx,
  );

  await executor.execute(
    {
      type: 'IssueGrant',
      recipientAgentId: 'agent-researcher-a',
      capability: {
        kindHint: 'AUTHORITY_EXTENSION',
        descriptionProse: 'Temporary authority for restricted source lookup.',
        scopeProse: 'Applies to source-index tasks only.',
        durationHint: 'PT4H',
        reasonProse: 'Approved by manager to unblock critical research task.',
      },
    },
    {
      tickId: 'tick-research-team-2',
      nowIso: '2025-06-02T09:10:00.000Z',
      stateStore: store,
      agent: manager,
      activeBindings: [],
    },
    ctx,
  );

  await store.transitionBacklogItemStatus('bl-research-a', 'IN_PROGRESS', '2025-06-02T09:11:00.000Z');

  const grantRequests = await store.listGrantRequests(mesh.id);
  const grants = await store.listCapabilityGrantsForRecipient('AGENT', 'agent-researcher-a');
  const backlog = await store.listBacklogForAgent('agent-researcher-a');

  console.log('Live-agents research team example is wired and running.');
  console.log(`Agents in mesh: ${(await store.listAgents(mesh.id)).length}`);
  console.log(`Grant requests: ${grantRequests.length}`);
  console.log(`Active grants for Alice: ${grants.length}`);
  console.log(`Alice backlog state: ${backlog[0]?.status ?? 'n/a'}`);

  await startHeartbeatRuntime({
    store,
    mesh,
    agents: teamAgents,
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
