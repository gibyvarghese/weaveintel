/**
 * Example: live-agents coding team
 *
 * A four-agent coding mesh that coordinates to implement a feature end-to-end.
 * Exercises the existing live-agents primitives without any new framework code:
 *
 *   - Mesh with four role-typed LiveAgents
 *   - AgentContracts with persona/objectives/successIndicators per role
 *   - ContextPolicy using real compressors from the ten-compressor default set
 *     (knowledge-worker profile for architect/designer, standard for coder/reviewer)
 *   - DelegationEdges capturing the reporting structure
 *   - BacklogItem lifecycle (PROPOSED -> ACCEPTED -> IN_PROGRESS -> COMPLETED)
 *   - Messages flowing through agent inboxes (TASK, REPORT, ASK kinds)
 *   - CapabilityGrant flow: Coder RequestCapability -> Architect IssueGrant
 *   - Account + AccountBinding bound to a fake CSE MCP server
 *   - OutboundActionRecord audit trail via the MCP session provider
 *   - CompressionMaintainer run producing compressed working memory
 *   - Promotion: Coder requests, Architect issues a v2 contract with wider authority
 *   - Heartbeat processing ticks with the standard attention policy
 *
 * Run:
 *   npx tsx examples/61-live-agents-coding-team.ts
 *
 * No external API keys required — the example uses weaveFakeTransport for the
 * MCP session and the in-memory state store.
 */

import type { AccessTokenResolver } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveFakeTransport } from '@weaveintel/testing';
import {
  createActionExecutor,
  createCompressionMaintainer,
  createHeartbeat,
  createMcpAccountSessionProvider,
  createStandardAttentionPolicy,
  weaveInMemoryStateStore,
  type Account,
  type AccountBinding,
  type AgentContract,
  type AttentionAction,
  type AttentionPolicy,
  type BacklogItem,
  type CapabilityGrant,
  type DelegationEdge,
  type HeartbeatTick,
  type LiveAgent,
  type Message,
  type Mesh,
  type Promotion,
  type PromotionRequest,
  type StateStore,
} from '@weaveintel/live-agents';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Generates compact demo-safe identifiers for persisted entities.
 *
 * @param prefix Entity prefix used to categorize the id.
 * @returns Best-effort unique id using prefix, timestamp, and random suffix.
 */
function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Emits structured execution logs for scenario steps.
 *
 * @param step Step identifier shown in output.
 * @param detail Human-readable detail text for the step.
 */
function flow(step: string, detail: string): void {
  console.log(`[FLOW] ${step} :: ${detail}`);
}

/**
 * Prints a section banner to make long scenario logs easier to scan.
 *
 * @param title Section title text.
 */
function banner(title: string): void {
  const bar = '-'.repeat(Math.max(8, 72 - title.length - 2));
  console.log(`\n${title} ${bar}`);
}

// ---------------------------------------------------------------------------
// Contract factory for coding roles
// ---------------------------------------------------------------------------

type CodingRole = 'architect' | 'coder' | 'designer' | 'reviewer';

/**
 * Builds a role-shaped agent contract for the coding-team scenario.
 *
 * @param args.id Contract record id.
 * @param args.agentId Agent id this contract applies to.
 * @param args.role Role template used for persona/objective/success text.
 * @param args.version Contract version number.
 * @param args.createdAt Contract creation timestamp.
 * @param args.grantAuthority Optional flag to enable grant issuance authority.
 * @param args.contractAuthority Optional flag to enable contract/promotion authority.
 * @returns AgentContract object ready to persist.
 */
function contractForCodingAgent(args: {
  id: string;
  agentId: string;
  role: CodingRole;
  version: number;
  createdAt: string;
  grantAuthority?: boolean;
  contractAuthority?: boolean;
}): AgentContract {
  const personaByRole: Record<CodingRole, string> = {
    architect: [
      'You are a pragmatic software architect.',
      'You convert product intent into buildable designs with clear acceptance criteria.',
      'You delegate well-scoped tasks and expect evidence-backed reports.',
    ].join(' '),
    coder: [
      'You are a careful implementation engineer.',
      'You write small, well-tested changes and always run the test suite before reporting done.',
      'You surface uncertainty early and request capability only when clearly justified.',
    ].join(' '),
    designer: [
      'You are a UX-focused designer who owns the design system.',
      'You maintain token discipline, reuse existing components, and document interaction patterns.',
      'You flag open questions rather than guessing at visual direction.',
    ].join(' '),
    reviewer: [
      'You are a rigorous code reviewer.',
      'You run the test suite, read the diff for regressions, and block merges on unresolved risks.',
      'You teach through comments and keep review cycles tight.',
    ].join(' '),
  };

  const objectivesByRole: Record<CodingRole, string> = {
    architect:
      'Break inbound product requests into implementation tasks, assign owners, and close out with a human-facing summary once quality gates are met.',
    coder:
      'Implement assigned backlog items, write tests, request the narrowest capability needed, and report progress back to the architect.',
    designer:
      'Produce component-level design specs that reference the existing token system and call out deviations for architect review.',
    reviewer:
      'Gate merges on test pass + regression check, leave review comments, and escalate only when human judgement is required.',
  };

  const successByRole: Record<CodingRole, string> = {
    architect:
      'Every delegated task has an owner, deadline, and acceptance criteria; final output is decision-ready for the human.',
    coder: 'All reported completions pass the test suite; no capability is held longer than scoped.',
    designer: 'Specs reuse tokens, open questions are recorded, and component inventory stays up-to-date.',
    reviewer: 'No regression reaches main; review turnaround stays under one heartbeat cycle for in-scope changes.',
  };

  // Architects + designers do knowledge work; coders + reviewers do operational work.
  const profile =
    args.role === 'architect' || args.role === 'designer' ? 'knowledge-worker' : 'operational';

  return {
    id: args.id,
    agentId: args.agentId,
    version: args.version,
    persona: personaByRole[args.role],
    objectives: objectivesByRole[args.role],
    successIndicators: successByRole[args.role],
    budget: {
      monthlyUsdCap: args.role === 'architect' ? 300 : 150,
      perActionUsdCap: 10,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      // Every minute, always active — keeps the heartbeat loop running in the demo.
      cronActive: '* * * * *',
    },
    grantAuthority: args.grantAuthority
      ? {
          mayIssueKinds: ['AUTHORITY_EXTENSION', 'COLLEAGUE_INTRODUCTION', 'BUDGET_INCREASE'],
          scopePredicate: 'agents in same mesh',
          maxBudgetIncreaseUsd: 100,
          requiresEvidence: true,
          dualControl: false,
        }
      : null,
    contractAuthority: args.contractAuthority
      ? {
          canIssueContracts: true,
          canIssuePromotions: true,
          scopePredicate: 'agents in same mesh',
          requiresEvidence: true,
        }
      : null,
    breakGlass: null,
    accountBindingRefs: [],
    attentionPolicyRef: 'coding-team',
    reviewCadence: 'P7D',
    contextPolicy: {
      // A realistic subset of the ten shipped compressors. The defaultsProfile
      // ordering above still applies; these are the ones we explicitly schedule.
      compressors:
        profile === 'knowledge-worker'
          ? [
              { id: 'hierarchical-summarisation', schedule: 'PT1H' },
              { id: 'knowledge-graph-distillation', onEvent: 'BACKLOG_TRANSITION' },
              { id: 'handoff-packets', onDemand: true },
              { id: 'contract-anchored-weighting', schedule: 'PT30M' },
            ]
          : [
              { id: 'rolling-conversation-summary', schedule: 'PT15M' },
              { id: 'structural-state-snapshot', onEvent: 'TICK_COMPLETE' },
              { id: 'timeline-compression', schedule: 'PT2H' },
              { id: 'relevance-decayed-retrieval', onDemand: true },
            ],
      weighting: [{ id: 'recency-weighted' }],
      budgets: {
        attentionTokensMax: 4000,
        actionTokensMax: 2000,
        handoffTokensMax: 1000,
        reportTokensMax: 500,
        monthlyCompressionUsdCap: 25,
      },
      defaultsProfile: profile,
    },
    createdAt: args.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Fixture MCP server: simulated CSE workspace tools
// ---------------------------------------------------------------------------

/**
 * Creates a fake MCP server with CSE-like tools and returns an account session provider
 * wired to that fake transport.
 *
 * @returns Session provider that can open MCP-backed account sessions for agents.
 */
async function buildFixtureCseMcp(): Promise<{
  sessionProvider: ReturnType<typeof createMcpAccountSessionProvider>;
}> {
  const { client, server } = weaveFakeTransport();
  const mcp = weaveMCPServer({ name: 'cse-fixture', version: '1.0.0' });

  mcp.addTool(
    {
      name: 'cse.read_file',
      description: 'Read a file from the CSE workspace.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    async (_ctx, args) => {
      const path = String((args as Record<string, unknown>)['path'] ?? '');
      return {
        content: [
          {
            type: 'text',
            text: `// ${path}\n// (fixture contents)\nexport function placeholder() { return 'ok'; }\n`,
          },
        ],
      };
    },
  );

  mcp.addTool(
    {
      name: 'cse.write_file',
      description: 'Write a file to the CSE workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    async (_ctx, args) => {
      const path = String((args as Record<string, unknown>)['path'] ?? '');
      return {
        content: [{ type: 'text', text: `wrote ${path}` }],
      };
    },
  );

  mcp.addTool(
    {
      name: 'cse.run_tests',
      description: 'Run the test suite in the CSE workspace.',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
      },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ passed: 42, failed: 0, duration_ms: 3120 }),
        },
      ],
    }),
  );

  mcp.addTool(
    {
      name: 'github.create_pull_request',
      description: 'Open a pull request against main.',
      inputSchema: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['branch', 'title'],
      },
    },
    async (_ctx, args) => {
      const branch = String((args as Record<string, unknown>)['branch'] ?? '');
      return {
        content: [
          { type: 'text', text: `opened PR from ${branch}` },
          { type: 'resource', uri: 'github://repo/weaveintel/pull/999' },
        ],
      };
    },
  );

  await mcp.start(server);

  const tokenResolver: AccessTokenResolver = {
    async resolve() {
      return 'fixture-cse-token';
    },
    async revoke() {
      // no-op for fixtures
    },
  };

  const sessionProvider = createMcpAccountSessionProvider({
    tokenResolver,
    transportFactory: {
      async createTransport() {
        return client;
      },
    },
  });

  return { sessionProvider };
}

// ---------------------------------------------------------------------------
// Helpers that wrap StateStore calls
// ---------------------------------------------------------------------------

/**
 * Creates and saves a thread message with normalized defaults.
 *
 * @param args.store State store used to persist the message.
 * @param args.meshId Mesh id containing the message thread.
 * @param args.threadId Thread identifier grouping related messages.
 * @param args.fromType Sender type.
 * @param args.fromId Sender id.
 * @param args.toType Recipient type.
 * @param args.toId Recipient id.
 * @param args.subject Message subject.
 * @param args.body Message body text.
 * @param args.createdAt Message creation timestamp.
 * @param args.priority Optional priority override.
 * @param args.kind Optional message kind override.
 * @param args.topic Optional message topic override.
 * @returns Persisted message object.
 */
async function saveTaskMessage(args: {
  store: StateStore;
  meshId: string;
  threadId: string;
  fromType: Message['fromType'];
  fromId: string;
  toType: Message['toType'];
  toId: string;
  subject: string;
  body: string;
  createdAt: string;
  priority?: Message['priority'];
  kind?: Message['kind'];
  topic?: string | null;
}): Promise<Message> {
  const message: Message = {
    id: makeId('msg'),
    meshId: args.meshId,
    fromType: args.fromType,
    fromId: args.fromId,
    fromMeshId: null,
    toType: args.toType,
    toId: args.toId,
    topic: args.topic ?? 'coding-task',
    kind: args.kind ?? 'TASK',
    replyToMessageId: null,
    threadId: args.threadId,
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: args.priority ?? 'NORMAL',
    status: 'DELIVERED',
    deliveredAt: args.createdAt,
    readAt: args.createdAt,
    processedAt: null,
    createdAt: args.createdAt,
    subject: args.subject,
    body: args.body,
  };
  await args.store.saveMessage(message);
  return message;
}

/**
 * Creates and saves a backlog item with scenario defaults.
 *
 * @param args.store State store used to persist the backlog item.
 * @param args.agentId Owning agent id.
 * @param args.title Backlog title.
 * @param args.description Backlog description.
 * @param args.createdAt Creation timestamp.
 * @param args.priority Optional priority override.
 * @param args.originType Optional origin-type override.
 * @param args.originRef Optional origin reference.
 * @param args.estimatedEffort Optional effort estimate.
 * @returns Persisted backlog item.
 */
async function saveBacklogItem(args: {
  store: StateStore;
  agentId: string;
  title: string;
  description: string;
  createdAt: string;
  priority?: BacklogItem['priority'];
  originType?: BacklogItem['originType'];
  originRef?: string | null;
  estimatedEffort?: string;
}): Promise<BacklogItem> {
  const item: BacklogItem = {
    id: makeId('bl'),
    agentId: args.agentId,
    priority: args.priority ?? 'NORMAL',
    status: 'PROPOSED',
    originType: args.originType ?? 'MESSAGE',
    originRef: args.originRef ?? null,
    blockedOnMessageId: null,
    blockedOnGrantRequestId: null,
    blockedOnPromotionRequestId: null,
    blockedOnAccountBindingRequestId: null,
    estimatedEffort: args.estimatedEffort ?? 'PT1H',
    deadline: null,
    acceptedAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: args.createdAt,
    title: args.title,
    description: args.description,
  };
  await args.store.saveBacklogItem(item);
  return item;
}

/**
 * Schedules a single heartbeat tick for the supplied agent.
 *
 * @param args.store State store used to save the heartbeat tick.
 * @param args.agent Agent that should process the scheduled tick.
 * @param args.workerId Scheduler worker identifier.
 * @param args.scheduledFor Scheduled execution timestamp.
 * @returns Persisted heartbeat tick.
 */
async function scheduleTickFor(args: {
  store: StateStore;
  agent: LiveAgent;
  workerId: string;
  scheduledFor: string;
}): Promise<HeartbeatTick> {
  const tick: HeartbeatTick = {
    id: makeId(`tick-${args.agent.id}`),
    agentId: args.agent.id,
    scheduledFor: args.scheduledFor,
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
  return tick;
}

// ---------------------------------------------------------------------------
// Main scenario
// ---------------------------------------------------------------------------

/**
 * Runs the full coding-team scenario end-to-end, including mesh bootstrap,
 * contracts, account binding, capability grants, promotion flow, and heartbeat.
 */
async function main() {
  const store = weaveInMemoryStateStore();
  const T0 = '2026-05-01T09:00:00.000Z';
  const T1 = '2026-05-01T09:05:00.000Z';
  const T2 = '2026-05-01T09:10:00.000Z';
  const T3 = '2026-05-01T09:20:00.000Z';
  const T4 = '2026-05-01T09:30:00.000Z';
  const T5 = '2026-05-01T09:45:00.000Z';
  const ctx = weaveContext({ userId: 'human:giby', tenantId: 'tenant-weaveintel' });

  banner('1. Mesh + Agents');

  const mesh: Mesh = {
    id: 'mesh-coding-team',
    tenantId: 'tenant-weaveintel',
    name: 'weaveIntel Engineering',
    charter: 'Design, build, review, and ship changes to the weaveIntel codebase.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: T0,
  };
  await store.saveMesh(mesh);

  const architect: LiveAgent = {
    id: 'agent-architect',
    meshId: mesh.id,
    name: 'Ada',
    role: 'Architect',
    contractVersionId: 'contract-architect-v1',
    status: 'ACTIVE',
    createdAt: T0,
    archivedAt: null,
  };
  const coder: LiveAgent = {
    id: 'agent-coder',
    meshId: mesh.id,
    name: 'Cody',
    role: 'Coder',
    contractVersionId: 'contract-coder-v1',
    status: 'ACTIVE',
    createdAt: T0,
    archivedAt: null,
  };
  const designer: LiveAgent = {
    id: 'agent-designer',
    meshId: mesh.id,
    name: 'Dana',
    role: 'Designer',
    contractVersionId: 'contract-designer-v1',
    status: 'ACTIVE',
    createdAt: T0,
    archivedAt: null,
  };
  const reviewer: LiveAgent = {
    id: 'agent-reviewer',
    meshId: mesh.id,
    name: 'Rex',
    role: 'Reviewer',
    contractVersionId: 'contract-reviewer-v1',
    status: 'ACTIVE',
    createdAt: T0,
    archivedAt: null,
  };

  for (const agent of [architect, coder, designer, reviewer]) {
    await store.saveAgent(agent);
  }
  flow('mesh', `Saved mesh ${mesh.name} with 4 agents`);

  banner('2. Contracts with real compressor policies');

  await store.saveContract(
    contractForCodingAgent({
      id: 'contract-architect-v1',
      agentId: architect.id,
      role: 'architect',
      version: 1,
      createdAt: T0,
      grantAuthority: true,
      contractAuthority: true,
    }),
  );
  await store.saveContract(
    contractForCodingAgent({
      id: 'contract-coder-v1',
      agentId: coder.id,
      role: 'coder',
      version: 1,
      createdAt: T0,
    }),
  );
  await store.saveContract(
    contractForCodingAgent({
      id: 'contract-designer-v1',
      agentId: designer.id,
      role: 'designer',
      version: 1,
      createdAt: T0,
    }),
  );
  await store.saveContract(
    contractForCodingAgent({
      id: 'contract-reviewer-v1',
      agentId: reviewer.id,
      role: 'reviewer',
      version: 1,
      createdAt: T0,
    }),
  );
  flow('contracts', 'v1 contracts saved for all four agents');

  banner('3. Delegation edges (reporting structure)');

  const edges: DelegationEdge[] = [
    {
      id: 'edge-arch-coder',
      meshId: mesh.id,
      fromAgentId: architect.id,
      toAgentId: coder.id,
      relationship: 'DIRECTS',
      relationshipProse: 'Ada directs Cody on implementation work.',
      effectiveFrom: T0,
      effectiveTo: null,
    },
    {
      id: 'edge-arch-designer',
      meshId: mesh.id,
      fromAgentId: architect.id,
      toAgentId: designer.id,
      relationship: 'COLLABORATES_WITH',
      relationshipProse: 'Ada and Dana collaborate on design decisions.',
      effectiveFrom: T0,
      effectiveTo: null,
    },
    {
      id: 'edge-reviewer-coder',
      meshId: mesh.id,
      fromAgentId: reviewer.id,
      toAgentId: coder.id,
      relationship: 'MENTORS',
      relationshipProse: 'Rex mentors Cody on code quality.',
      effectiveFrom: T0,
      effectiveTo: null,
    },
  ];
  for (const edge of edges) {
    await store.saveDelegationEdge(edge);
  }
  flow('delegation', `${edges.length} delegation edges saved`);

  banner('4. CSE account + binding (fixture MCP)');

  const { sessionProvider } = await buildFixtureCseMcp();

  const cseAccount: Account = {
    id: 'account-cse-workspace-1',
    meshId: mesh.id,
    provider: 'cse',
    accountIdentifier: 'workspace://weaveintel-main',
    description: 'CSE workspace bound to the weaveintel main repo.',
    mcpServerRef: { type: 'http', url: 'fixture://cse', version: '1.0.0' },
    credentialVaultRef: 'vault://cse/fixture',
    upstreamScopesDescription: 'read/write repo, run tests, open PRs',
    ownerHumanId: 'human:giby',
    status: 'ACTIVE',
    createdAt: T0,
    revokedAt: null,
  };
  await store.saveAccount(cseAccount);

  // Only the coder is bound — architects and reviewers coordinate via messages.
  const coderBinding: AccountBinding = {
    id: 'binding-coder-cse',
    agentId: coder.id,
    accountId: cseAccount.id,
    purposeProse: 'Cody needs CSE workspace access to implement and test features.',
    scopeProse: 'Write to feature branches, run tests, open PRs against main.',
    grantedByHumanId: 'human:giby',
    grantedAt: T0,
    expiresAt: null,
    revokedAt: null,
    revokedByHumanId: null,
    revocationReason: null,
  };
  await store.saveAccountBinding(coderBinding);
  flow('binding', `Coder bound to CSE workspace account (only humans can grant)`);

  banner('5. Human files a task — architect gets the inbound message');

  const threadId = 'thread-oauth-feature';
  await saveTaskMessage({
    store,
    meshId: mesh.id,
    threadId,
    fromType: 'HUMAN',
    fromId: 'human:giby',
    toType: 'AGENT',
    toId: architect.id,
    kind: 'ASK',
    subject: 'Implement OAuth login flow',
    body: 'Add GitHub OAuth to geneweave login. Must work on mobile, needs design review.',
    createdAt: T0,
    priority: 'HIGH',
  });
  flow('1/9 ingress', 'Human -> Architect: OAuth feature request');

  banner('6. Architect decomposes into tasks + creates backlog');

  const designTask = await saveTaskMessage({
    store,
    meshId: mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: architect.id,
    toType: 'AGENT',
    toId: designer.id,
    kind: 'TASK',
    subject: 'Design OAuth sign-in UI',
    body: 'Component spec + mobile layout + error states for GitHub OAuth button.',
    createdAt: T1,
    priority: 'HIGH',
  });
  const codeTask = await saveTaskMessage({
    store,
    meshId: mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: architect.id,
    toType: 'AGENT',
    toId: coder.id,
    kind: 'TASK',
    subject: 'Implement OAuth handlers + callback route',
    body: 'POST /auth/github/start, GET /auth/github/callback, session bootstrap.',
    createdAt: T1,
    priority: 'HIGH',
  });

  const designItem = await saveBacklogItem({
    store,
    agentId: designer.id,
    title: 'Design OAuth sign-in UI',
    description: 'Component spec + mobile layout + error states.',
    createdAt: T1,
    priority: 'HIGH',
    originType: 'MESSAGE',
    originRef: designTask.id,
    estimatedEffort: 'PT2H',
  });
  const codeItem = await saveBacklogItem({
    store,
    agentId: coder.id,
    title: 'Implement OAuth handlers + callback route',
    description: 'Server routes and session bootstrap.',
    createdAt: T1,
    priority: 'HIGH',
    originType: 'MESSAGE',
    originRef: codeTask.id,
    estimatedEffort: 'PT4H',
  });

  await store.transitionBacklogItemStatus(designItem.id, 'ACCEPTED', T1);
  await store.transitionBacklogItemStatus(codeItem.id, 'ACCEPTED', T1);
  flow('2/9 delegate', 'Architect -> Designer + Coder: tasks delegated, backlog accepted');

  banner('7. Coder requests capability; architect issues grant');

  const executor = createActionExecutor();

  // Coder asks for a wider authority because writing to main-adjacent branches
  // needs an authority extension beyond the default role.
  await executor.execute(
    {
      type: 'RequestCapability',
      capability: {
        kindHint: 'AUTHORITY_EXTENSION',
        descriptionProse: 'Authority to push to feature/oauth-* branches and open PRs.',
        reasonProse: 'Assigned OAuth implementation requires branch-write + PR-create scope.',
        evidenceMessageIds: [codeTask.id],
      },
    } satisfies AttentionAction,
    {
      tickId: 'tick-coder-req-1',
      nowIso: T2,
      stateStore: store,
      agent: coder,
      activeBindings: [coderBinding],
    },
    ctx,
  );
  flow('3/9 request', 'Coder -> RequestCapability(AUTHORITY_EXTENSION)');

  // Architect has grantAuthority in the contract, so can issue.
  await executor.execute(
    {
      type: 'IssueGrant',
      recipientAgentId: coder.id,
      capability: {
        kindHint: 'AUTHORITY_EXTENSION',
        descriptionProse: 'Push to feature/oauth-* branches, open PRs to main.',
        scopeProse: 'Scoped to OAuth work; expires at PR merge.',
        durationHint: 'PT24H',
        reasonProse: 'Approved by architect to unblock implementation.',
        evidenceMessageIds: [codeTask.id],
      },
    } satisfies AttentionAction,
    {
      tickId: 'tick-arch-grant-1',
      nowIso: T2,
      stateStore: store,
      agent: architect,
      activeBindings: [],
    },
    ctx,
  );
  flow('4/9 grant', 'Architect -> IssueGrant to Coder');

  const coderGrants = await store.listCapabilityGrantsForRecipient('AGENT', coder.id);
  console.log(`  Active grants for ${coder.name}: ${coderGrants.length}`);

  banner('8. Designer + Coder execute, report back');

  await store.transitionBacklogItemStatus(designItem.id, 'IN_PROGRESS', T3);
  await store.transitionBacklogItemStatus(codeItem.id, 'IN_PROGRESS', T3);

  await saveTaskMessage({
    store,
    meshId: mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: designer.id,
    toType: 'AGENT',
    toId: architect.id,
    kind: 'REPORT',
    subject: 'Design spec: OAuth sign-in',
    body:
      'GitHubAuthButton component (uses tokens.brand.primary, 44px touch target), error state uses tokens.semantic.danger, spec attached.',
    createdAt: T3,
  });
  await store.transitionBacklogItemStatus(designItem.id, 'COMPLETED', T3);
  flow('5/9 report', 'Designer reported design spec');

  await saveTaskMessage({
    store,
    meshId: mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: coder.id,
    toType: 'AGENT',
    toId: architect.id,
    kind: 'REPORT',
    subject: 'Implementation: OAuth handlers wired',
    body: 'Routes implemented, session persists via JWT, 42 tests pass, 0 fail.',
    createdAt: T3,
  });
  await store.transitionBacklogItemStatus(codeItem.id, 'COMPLETED', T3);
  flow('6/9 report', 'Coder reported implementation done, tests pass');

  banner('9. Coder executes outbound MCP action (open PR)');

  // This path uses the AccountSessionProvider to open a real MCP session to the
  // fixture server. The ActionExecutor records an OutboundActionRecord.
  const session = await sessionProvider.getSession({
    account: cseAccount,
    agent: coder,
    ctx,
  });
  const toolList = await session.listTools();
  console.log(`  MCP tools available to ${coder.name}: ${toolList.map((t) => t.name).join(', ')}`);

  const prResult = await session.callTool(ctx, {
    name: 'github.create_pull_request',
    arguments: {
      branch: 'feature/oauth-github',
      title: 'OAuth GitHub login',
      body: 'Implements OAuth per architect spec; design reviewed by Dana.',
    },
  });
  const prText =
    (prResult.content ?? []).find((c) => c.type === 'text')?.text ?? '(no text)';
  console.log(`  PR result: ${prText}`);

  // Record the outbound action as an audit trail entry.
  await store.saveOutboundActionRecord({
    id: makeId('outbound'),
    agentId: coder.id,
    accountId: cseAccount.id,
    mcpToolName: 'github.create_pull_request',
    idempotencyKey: `${threadId}:pr-oauth-1`,
    requiresHumanApproval: true,
    approvalTaskId: null,
    status: 'SENT',
    sentAt: T4,
    externalRef: 'github://repo/weaveintel/pull/999',
    createdAt: T4,
    purposeProse: 'Open PR for OAuth implementation for human + reviewer approval.',
    summaryProse: 'PR #999 opened against main from feature/oauth-github.',
    errorProse: null,
  });
  flow('7/9 outbound', 'Coder -> MCP github.create_pull_request; OutboundActionRecord logged');

  banner('10. Reviewer approves, architect summarises to human');

  await saveTaskMessage({
    store,
    meshId: mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: reviewer.id,
    toType: 'AGENT',
    toId: architect.id,
    kind: 'REPORT',
    subject: 'Review: PR #999 approved',
    body: 'Tests green, diff clean, no regression flags. Approved.',
    createdAt: T4,
  });
  await saveTaskMessage({
    store,
    meshId: mesh.id,
    threadId,
    fromType: 'AGENT',
    fromId: architect.id,
    toType: 'HUMAN',
    toId: 'human:giby',
    kind: 'REPORT',
    subject: 'Delivered: OAuth GitHub login',
    body:
      'PR #999 opened, tests green, reviewed by Rex, design by Dana, implemented by Cody. Ready to merge.',
    createdAt: T4,
  });
  flow('8/9 deliver', 'Architect -> Human: delivery summary');

  banner('11. Compression maintainer runs — working memory snapshots');

  const maintainer = createCompressionMaintainer({ stateStore: store, runOnce: true });
  await maintainer.run(ctx);
  console.log('  Compression pass completed.');

  // Inspect the coder's working memory after compression.
  const coderMemory = await store.loadWorkingMemory?.(coder.id);
  if (coderMemory) {
    const entries = (coderMemory as { artefacts?: unknown[] }).artefacts ?? [];
    console.log(`  Coder working-memory artefacts: ${entries.length}`);
  }

  banner('12. Promotion flow — Coder gets a v2 contract');

  const promotionRequestId = makeId('prreq');
  const promotionRequest: PromotionRequest = {
    id: promotionRequestId,
    meshId: mesh.id,
    recipientId: coder.id,
    requestedByType: 'AGENT',
    requestedById: coder.id,
    status: 'OPEN',
    reviewedByType: null,
    reviewedById: null,
    resolvedContractVersionId: null,
    createdAt: T5,
    resolvedAt: null,
    expiresAt: null,
    targetRole: 'Senior Coder',
    scopeDeltaProse: 'Expand delivery ownership to feature-level execution and mentoring.',
    reasonProse: 'Delivered OAuth feature end-to-end with clean review.',
    resolutionReasonProse: null,
    evidenceRefs: [codeTask.id],
  };
  await store.savePromotionRequest(promotionRequest);
  flow('9/9 promote', 'Coder -> PromotionRequest (Senior Coder)');

  // Architect has contractAuthority; issues the v2 contract.
  const coderV2 = contractForCodingAgent({
    id: 'contract-coder-v2',
    agentId: coder.id,
    role: 'coder',
    version: 2,
    createdAt: T5,
    grantAuthority: true, // elevated: can issue colleague introductions
  });
  // Bump objectives/success to reflect promotion
  coderV2.objectives = `${coderV2.objectives} Mentor newer coders and own feature-level delivery.`;
  await store.saveContract(coderV2);

  await store.resolvePromotionRequest(
    promotionRequest.id,
    'APPROVED',
    'AGENT',
    architect.id,
    T5,
    'Earned via OAuth delivery.',
    coderV2.id,
  );

  const promotion: Promotion = {
    id: makeId('prom'),
    agentId: coder.id,
    fromContractVersionId: 'contract-coder-v1',
    toContractVersionId: coderV2.id,
    trigger: 'REQUESTED',
    issuedByType: 'AGENT',
    issuedById: architect.id,
    issuedAt: T5,
    scopeDeltaSummaryProse: 'Expanded scope to mentor peers and own feature-level delivery.',
    evidenceRefs: [codeTask.id],
  };
  await store.savePromotion(promotion);
  flow('promotion', `Coder promoted to Senior Coder (contract ${coderV2.id})`);

  banner('13. Heartbeat ticks — let the standard attention policy run');

  // Schedule a tick for each agent so the heartbeat has something to claim.
  for (const agent of [architect, coder, designer, reviewer]) {
    await scheduleTickFor({
      store,
      agent,
      workerId: 'scheduler',
      scheduledFor: T5,
    });
  }

  const attentionPolicy: AttentionPolicy = createStandardAttentionPolicy();
  const heartbeat = createHeartbeat({
    stateStore: store,
    workerId: 'worker-coding-1',
    concurrency: 4,
    attentionPolicy,
    actionExecutor: executor,
    now: () => T5,
  });

  const tickResult = await heartbeat.tick(ctx);
  console.log(`  Processed ticks: ${tickResult.processed}`);

  banner('14. Final state summary');

  const [
    agentsFinal,
    threadMessages,
    allGrants,
    coderBacklog,
    designerBacklog,
    outboundRecords,
    latestCoderContract,
  ] = await Promise.all([
    store.listAgents(mesh.id),
    store.listThreadMessages(threadId),
    store.listCapabilityGrantsForRecipient('AGENT', coder.id),
    store.listBacklogForAgent(coder.id),
    store.listBacklogForAgent(designer.id),
    store.listOutboundActionRecords(coder.id),
    store.loadLatestContractForAgent(coder.id),
  ]);

  console.log(`  Agents in mesh: ${agentsFinal.length}`);
  console.log(`  Thread messages: ${threadMessages.length}`);
  console.log(`  Grants held by Coder: ${allGrants.length}`);
  console.log(
    `  Coder backlog statuses: ${coderBacklog.map((b) => `${b.title}=${b.status}`).join('; ')}`,
  );
  console.log(
    `  Designer backlog statuses: ${designerBacklog.map((b) => `${b.title}=${b.status}`).join('; ')}`,
  );
  console.log(`  Outbound action records (Coder): ${outboundRecords.length}`);
  console.log(
    `  Latest contract for Coder: ${latestCoderContract?.id} v${latestCoderContract?.version}`,
  );

  console.log('\nLive-agents coding-team example completed successfully.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});