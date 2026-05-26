import type { LiveAgent, LiveAgentStatus, Mesh, DelegationEdge, Team, TeamMembership, CrossMeshBridge, AgentContract } from './mesh.js';
import type { Account, AccountBinding, AccountBindingRequest } from './accounts.js';
import type { Message, MessageStatus, BacklogItem, OutboundActionRecord, ExternalEvent, EventRoute } from './messaging.js';
import type { CapabilityGrant, GrantRequest, BreakGlassInvocation, PromotionRequest, Promotion } from './grants.js';
import type { HeartbeatTick } from './actions.js';

export interface ActionExecutionContext {
  tickId: string;
  nowIso: string;
  stateStore: StateStore;
  agent: LiveAgent;
  activeBindings: AccountBinding[];
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

  saveCrossMeshBridge(bridge: CrossMeshBridge): Promise<void>;
  loadCrossMeshBridge(id: string): Promise<CrossMeshBridge | null>;
  listCrossMeshBridges(fromMeshId: string, toMeshId?: string): Promise<CrossMeshBridge[]>;
  revokeCrossMeshBridge(bridgeId: string, revokedAt: string): Promise<CrossMeshBridge | null>;

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
  claimNextTicks(workerId: string, nowIso: string, limit: number, leaseDurationMs?: number): Promise<HeartbeatTick[]>;

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

  saveCapabilityGrant(grant: CapabilityGrant): Promise<void>;
  loadCapabilityGrant(id: string): Promise<CapabilityGrant | null>;
  listCapabilityGrantsForRecipient(recipientType: CapabilityGrant['recipientType'], recipientId: string): Promise<CapabilityGrant[]>;
  revokeCapabilityGrant(
    grantId: string,
    revokedByType: CapabilityGrant['revokedByType'],
    revokedById: string,
    revocationReasonProse: string,
    at: string,
  ): Promise<CapabilityGrant | null>;

  saveGrantRequest(request: GrantRequest): Promise<void>;
  loadGrantRequest(id: string): Promise<GrantRequest | null>;
  listGrantRequests(meshId: string): Promise<GrantRequest[]>;
  resolveGrantRequest(
    requestId: string,
    status: 'APPROVED' | 'REJECTED' | 'EXPIRED',
    resolvedByType: 'HUMAN' | 'AGENT',
    resolvedById: string,
    resolvedAt: string,
    resolutionReasonProse: string,
    resolvedGrantId?: string | null,
  ): Promise<GrantRequest | null>;

  saveBreakGlassInvocation(invocation: BreakGlassInvocation): Promise<void>;
  loadBreakGlassInvocation(id: string): Promise<BreakGlassInvocation | null>;
  listBreakGlassInvocations(agentId: string): Promise<BreakGlassInvocation[]>;
  reviewBreakGlassInvocation(
    invocationId: string,
    reviewOutcome: 'APPROVED' | 'REJECTED',
    reviewedAt: string,
  ): Promise<BreakGlassInvocation | null>;

  savePromotionRequest(request: PromotionRequest): Promise<void>;
  loadPromotionRequest(id: string): Promise<PromotionRequest | null>;
  listPromotionRequests(meshId: string): Promise<PromotionRequest[]>;
  resolvePromotionRequest(
    requestId: string,
    status: 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED',
    reviewedByType: 'HUMAN' | 'AGENT',
    reviewedById: string,
    resolvedAt: string,
    resolutionReasonProse: string,
    resolvedContractVersionId?: string | null,
  ): Promise<PromotionRequest | null>;

  savePromotion(promotion: Promotion): Promise<void>;
  loadPromotion(id: string): Promise<Promotion | null>;
  listPromotionsForAgent(agentId: string): Promise<Promotion[]>;
}

export interface InMemoryStateStore extends StateStore {
  __kind: 'in-memory';
}

export interface RedisStateStore extends StateStore {
  __kind: 'redis';
  mode: 'coordination-only' | 'durable-explicit';
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresStateStore extends StateStore {
  __kind: 'postgres';
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export interface SqliteStateStore extends StateStore {
  __kind: 'sqlite';
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export interface MongoDbStateStore extends StateStore {
  __kind: 'mongodb';
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export interface CloudNoSqlStateStore extends StateStore {
  __kind: 'cloud-nosql';
  provider: 'dynamodb';
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export interface DynamoDbStateStore extends CloudNoSqlStateStore {
  provider: 'dynamodb';
}
