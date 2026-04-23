import type {
  ExecutionContext,
  AccessTokenResolver,
  MCPToolCallRequest,
  MCPToolCallResponse,
  MCPToolDefinition,
  MCPTransport,
  RuntimeIdentity,
  SecretScope,
} from '@weaveintel/core';
import type { ContextCompressor } from '@weaveintel/core';

export type LiveAgentStatus =
  | 'HIRING'
  | 'ONBOARDING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'SUSPENDED'
  | 'TERMINATING'
  | 'ARCHIVED';

export interface Mesh {
  id: string;
  tenantId: string;
  name: string;
  charter: string;
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  dualControlRequiredFor: string[];
  createdAt: string;
}

export interface LiveAgent {
  id: string;
  meshId: string;
  name: string;
  role: string;
  contractVersionId: string;
  status: LiveAgentStatus;
  createdAt: string;
  archivedAt: string | null;
}

export interface DelegationEdge {
  id: string;
  meshId: string;
  fromAgentId: string;
  toAgentId: string;
  relationship: 'DIRECTS' | 'COLLABORATES_WITH' | 'MENTORS';
  relationshipProse: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface Team {
  id: string;
  meshId: string;
  name: string;
  charter: string;
  leadAgentId: string | null;
}

export interface TeamMembership {
  id: string;
  teamId: string;
  agentId: string;
  roleInTeam: string;
  joinedAt: string;
  leftAt: string | null;
}

export interface AgentContract {
  id: string;
  agentId: string;
  version: number;
  persona: string;
  objectives: string;
  successIndicators: string;
  budget: {
    monthlyUsdCap: number;
    perActionUsdCap: number;
  };
  workingHoursSchedule: {
    timezone: string;
    cronActive: string;
  };
  accountBindingRefs: string[];
  attentionPolicyRef: string;
  reviewCadence: string;
  contextPolicy: ContextPolicy;
  createdAt: string;
}

export interface ContextPolicy {
  compressors: Array<{
    id: string;
    schedule?: string;
    onEvent?: string;
    onDemand?: boolean;
  }>;
  weighting: Array<{ id: string }>;
  budgets: {
    attentionTokensMax: number;
    actionTokensMax: number;
    handoffTokensMax: number;
    reportTokensMax: number;
    monthlyCompressionUsdCap: number;
  };
  defaultsProfile?: 'standard' | 'knowledge-worker' | 'operational' | null;
}

export interface Account {
  id: string;
  meshId: string;
  provider: string;
  accountIdentifier: string;
  description: string;
  mcpServerRef: McpServerRef;
  credentialVaultRef: string;
  upstreamScopesDescription: string;
  ownerHumanId: string;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  createdAt: string;
  revokedAt: string | null;
}

export interface AccountBinding {
  id: string;
  agentId: string;
  accountId: string;
  purpose: string;
  constraints: string;
  grantedByHumanId: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByHumanId: string | null;
  revocationReason: string | null;
}

export interface AccountBindingRequest {
  id: string;
  meshId: string;
  agentId: string;
  accountId: string | null;
  requestedByType: 'AGENT' | 'HUMAN';
  requestedById: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  resolvedByHumanId: string | null;
  resolvedAccountBindingId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
  purposeProse: string;
  reasonProse: string;
  resolutionReasonProse: string | null;
  evidenceRefs: string[];
}

export interface McpServerRef {
  url: string;
  serverType: 'STDIO' | 'HTTP' | 'WEBSOCKET';
  discoveryHint: string | null;
}

export interface HeartbeatTick {
  id: string;
  agentId: string;
  scheduledFor: string;
  pickedUpAt: string | null;
  completedAt: string | null;
  workerId: string;
  leaseExpiresAt: string | null;
  actionChosen: AttentionAction | null;
  actionOutcomeProse: string | null;
  actionOutcomeStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | null;
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
}

export type MessageKind =
  | 'ASK'
  | 'TELL'
  | 'TASK'
  | 'REPORT'
  | 'ESCALATION'
  | 'REPLY'
  | 'BROADCAST'
  | 'GRANT_REQUEST'
  | 'GRANT_NOTICE'
  | 'PROMOTION_REQUEST'
  | 'PROMOTION_NOTICE'
  | 'CONTEXT_HANDOFF';

export type MessagePriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export type MessageStatus = 'PENDING' | 'DELIVERED' | 'READ' | 'PROCESSED' | 'EXPIRED' | 'FAILED';

export interface Message {
  id: string;
  meshId: string;
  fromType: 'HUMAN' | 'AGENT' | 'SYSTEM' | 'INGRESS';
  fromId: string;
  fromMeshId: string | null;
  toType: 'HUMAN' | 'AGENT' | 'BROADCAST' | 'TEAM';
  toId: string | null;
  topic: string | null;
  kind: MessageKind;
  replyToMessageId: string | null;
  threadId: string;
  contextRefs: string[];
  contextPacketRef: string | null;
  expiresAt: string | null;
  priority: MessagePriority;
  status: MessageStatus;
  deliveredAt: string | null;
  readAt: string | null;
  processedAt: string | null;
  createdAt: string;
  subject: string;
  body: string;
}

export interface BacklogItem {
  id: string;
  agentId: string;
  priority: MessagePriority;
  status: 'PROPOSED' | 'ACCEPTED' | 'IN_PROGRESS' | 'BLOCKED' | 'COMPLETED' | 'DROPPED';
  originType: 'SELF' | 'MESSAGE' | 'MANAGER' | 'SYSTEM' | 'SCHEDULE' | 'INGRESS';
  originRef: string | null;
  blockedOnMessageId: string | null;
  blockedOnGrantRequestId: string | null;
  blockedOnPromotionRequestId: string | null;
  blockedOnAccountBindingRequestId: string | null;
  estimatedEffort: string;
  deadline: string | null;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  title: string;
  description: string;
}

export interface OutboundActionRecord {
  id: string;
  agentId: string;
  accountId: string;
  mcpToolName: string;
  idempotencyKey: string;
  requiresHumanApproval: boolean;
  approvalTaskId: string | null;
  status: 'DRAFTED' | 'APPROVED' | 'REJECTED' | 'SENT' | 'FAILED';
  sentAt: string | null;
  externalRef: string | null;
  createdAt: string;
  purposeProse: string;
  summaryProse: string;
  errorProse: string | null;
}

export interface ExternalEvent {
  id: string;
  accountId: string;
  sourceType: string;
  sourceRef: string;
  receivedAt: string;
  payloadSummary: string;
  payloadContextRef: string;
  processedAt: string | null;
  producedMessageIds: string[];
  processingStatus: 'RECEIVED' | 'ROUTED' | 'NO_MATCH' | 'FAILED';
  error: string | null;
}

export interface EventRoute {
  id: string;
  meshId: string;
  accountId: string;
  matchDescriptionProse: string;
  matchExpr: string;
  targetType: 'AGENT' | 'TEAM' | 'BROADCAST';
  targetId: string | null;
  targetTopic: string | null;
  priorityOverride: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | null;
  enabled: boolean;
  createdAt: string;
}

export interface StateStore {
  saveMesh(mesh: Mesh): Promise<void>;
  loadMesh(id: string): Promise<Mesh | null>;
  listMeshes(tenantId: string): Promise<Mesh[]>;

  saveAgent(agent: LiveAgent): Promise<void>;
  loadAgent(id: string): Promise<LiveAgent | null>;
  listAgents(meshId: string): Promise<LiveAgent[]>;
  transitionAgentStatus(agentId: string, nextStatus: LiveAgentStatus, at: string): Promise<LiveAgent | null>;

  saveDelegationEdge(edge: DelegationEdge): Promise<void>;
  listDelegationEdges(meshId: string): Promise<DelegationEdge[]>;

  saveTeam(team: Team): Promise<void>;
  loadTeam(id: string): Promise<Team | null>;
  listTeams(meshId: string): Promise<Team[]>;
  saveTeamMembership(membership: TeamMembership): Promise<void>;
  listTeamMemberships(teamId: string): Promise<TeamMembership[]>;
  listTeamsForAgent(agentId: string): Promise<Team[]>;

  saveContract(contract: AgentContract): Promise<void>;
  loadContract(id: string): Promise<AgentContract | null>;
  loadLatestContractForAgent(agentId: string): Promise<AgentContract | null>;

  saveAccount(account: Account): Promise<void>;
  loadAccount(id: string): Promise<Account | null>;
  listAccounts(meshId: string): Promise<Account[]>;
  transitionAccountStatus(accountId: string, nextStatus: Account['status'], at: string): Promise<Account | null>;

  saveAccountBinding(binding: AccountBinding): Promise<void>;
  loadAccountBinding(id: string): Promise<AccountBinding | null>;
  listAccountBindings(agentId: string): Promise<AccountBinding[]>;
  listActiveAccountBindingsForAgent(agentId: string, at: string): Promise<AccountBinding[]>;
  revokeAccountBinding(
    bindingId: string,
    revokedByHumanId: string,
    revocationReason: string,
    at: string,
  ): Promise<AccountBinding | null>;
  saveAccountBindingRequest(request: AccountBindingRequest): Promise<void>;
  loadAccountBindingRequest(id: string): Promise<AccountBindingRequest | null>;
  listAccountBindingRequests(meshId: string): Promise<AccountBindingRequest[]>;
  resolveAccountBindingRequest(
    requestId: string,
    status: 'APPROVED' | 'REJECTED' | 'EXPIRED',
    resolvedByHumanId: string,
    resolvedAt: string,
    resolutionReasonProse: string,
    resolvedAccountBindingId?: string | null,
  ): Promise<AccountBindingRequest | null>;

  saveHeartbeatTick(tick: HeartbeatTick): Promise<void>;
  loadHeartbeatTick(id: string): Promise<HeartbeatTick | null>;
  claimNextTicks(workerId: string, nowIso: string, limit: number): Promise<HeartbeatTick[]>;

  saveMessage(message: Message): Promise<void>;
  loadMessage(id: string): Promise<Message | null>;
  listMessagesForRecipient(recipientType: Message['toType'], recipientId: string | null): Promise<Message[]>;
  listThreadMessages(threadId: string): Promise<Message[]>;
  transitionMessageStatus(messageId: string, status: MessageStatus, at: string): Promise<Message | null>;

  saveBacklogItem(item: BacklogItem): Promise<void>;
  loadBacklogItem(id: string): Promise<BacklogItem | null>;
  listBacklogForAgent(agentId: string): Promise<BacklogItem[]>;
  transitionBacklogItemStatus(
    backlogItemId: string,
    status: BacklogItem['status'],
    at: string,
  ): Promise<BacklogItem | null>;

  saveExternalEvent(event: ExternalEvent): Promise<void>;
  findExternalEvent(accountId: string, sourceType: string, sourceRef: string): Promise<ExternalEvent | null>;
  saveEventRoute(route: EventRoute): Promise<void>;
  listEventRoutes(accountId: string): Promise<EventRoute[]>;

  saveOutboundActionRecord(record: OutboundActionRecord): Promise<void>;
  listOutboundActionRecords(agentId: string): Promise<OutboundActionRecord[]>;
}

export interface InMemoryStateStore extends StateStore {
  __kind: 'in-memory';
}

export interface RedisStateStore extends StateStore {
  __kind: 'redis';
}

export interface Heartbeat {
  tick(ctx: ExecutionContext): Promise<{ processed: number }>;
  run(ctx: ExecutionContext): Promise<void>;
  stop(): Promise<void>;
}

export interface CompressionMaintainer {
  run(ctx: ExecutionContext): Promise<void>;
  stop(): Promise<void>;
}

export interface ExternalEventHandler {
  process(event: ExternalEvent, ctx: ExecutionContext): Promise<{ routedMessageCount: number }>;
}

export interface LiveAgentsRuntime {
  readonly stateStore: StateStore;
  readonly compressors: Map<string, ContextCompressor>;
}

export interface Recipient {
  type: 'HUMAN' | 'AGENT' | 'TEAM' | 'BROADCAST';
  id: string | null;
}

export type GrantKind =
  | 'BUDGET_INCREASE'
  | 'WORKING_HOURS_OVERRIDE'
  | 'AUTHORITY_EXTENSION'
  | 'COLLEAGUE_INTRODUCTION'
  | 'MESH_BRIDGE';

export interface CapabilityRequestBody {
  kindHint: GrantKind;
  descriptionProse: string;
  reasonProse: string;
  evidenceMessageIds: string[];
}

export interface CapabilityIssueBody {
  kindHint: GrantKind;
  descriptionProse: string;
  scopeProse: string;
  durationHint: string | null;
  reasonProse: string;
}

export interface AgentContractDraft {
  role: string;
  objectives: string;
  successIndicators: string;
}

export type AttentionAction =
  | { type: 'ProcessMessage'; messageId: string }
  | { type: 'ContinueTask'; backlogItemId: string }
  | { type: 'StartTask'; backlogItemId: string }
  | { type: 'DraftMessage'; to: Recipient; kind: MessageKind; subject: string; bodySeed: string }
  | { type: 'RequestCapability'; capability: CapabilityRequestBody }
  | { type: 'RequestAccountBinding'; account: string; purposeProse: string }
  | { type: 'RequestPromotion'; targetRole: string; reasonProse: string; evidenceMessageIds: string[] }
  | { type: 'IssueGrant'; recipientAgentId: string; capability: CapabilityIssueBody }
  | { type: 'IssuePromotion'; recipientAgentId: string; newContractDraft: AgentContractDraft; reasonProse: string }
  | { type: 'EscalateToHuman'; reasonProse: string; optionsProse: string }
  | { type: 'InvokeBreakGlass'; capability: CapabilityRequestBody; emergencyReasonProse: string }
  | { type: 'EmitEpisodicMarker'; summaryProse: string; tags: string[] }
  | { type: 'RequestCompressionRefresh' }
  | { type: 'CheckpointAndRest'; nextTickAt: string }
  | { type: 'NoopRest'; nextTickAt: string };

export interface AttentionContext {
  nowIso: string;
  agent: LiveAgent;
  contract: AgentContract | null;
  inbox: Message[];
  backlog: BacklogItem[];
  activeBindings: AccountBinding[];
}

export interface AttentionPolicy {
  key: string;
  decide(context: AttentionContext, ctx: ExecutionContext): Promise<AttentionAction>;
}

export interface ActionExecutionContext {
  tickId: string;
  nowIso: string;
  stateStore: StateStore;
  agent: LiveAgent;
  activeBindings: AccountBinding[];
}

export interface ExternalActionToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  purposeProse: string;
  summaryProse: string;
}

export interface ExternalActionAdapter {
  resolve(action: AttentionAction, context: ActionExecutionContext, account: Account): Promise<ExternalActionToolCall | null>;
}

export interface AccountToolSession {
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(ctx: ExecutionContext, request: MCPToolCallRequest): Promise<MCPToolCallResponse>;
  disconnect(): Promise<void>;
}

export interface AccountSessionProvider {
  getSession(args: {
    account: Account;
    agent: LiveAgent;
    ctx: ExecutionContext;
  }): Promise<AccountToolSession>;
  disconnectAccount?(accountId: string): Promise<void>;
  disconnectAll?(): Promise<void>;
}

export interface McpTransportFactoryInput {
  account: Account;
  agent: LiveAgent;
  token: string;
  identity: RuntimeIdentity;
  ctx: ExecutionContext;
}

export interface McpTransportFactory {
  createTransport(input: McpTransportFactoryInput): Promise<MCPTransport>;
}

export interface McpAccountSessionProviderOptions {
  tokenResolver: AccessTokenResolver;
  transportFactory: McpTransportFactory;
  scopeFactory?: (account: Account, agent: LiveAgent) => SecretScope;
  identityFactory?: (agent: LiveAgent) => RuntimeIdentity;
}

export interface ActionExecutionResult {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  summaryProse: string;
  createdMessageIds: string[];
  createdOutboundRecordIds: string[];
  updatedBacklogItemIds: string[];
}

export interface ActionExecutor {
  execute(action: AttentionAction, context: ActionExecutionContext, ctx: ExecutionContext): Promise<ActionExecutionResult>;
}
