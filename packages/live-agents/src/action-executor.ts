import type {
  Account,
  AccountSessionProvider,
  ActionExecutionContext,
  ActionExecutionResult,
  ActionExecutor,
  AttentionAction,
  CapabilityGrant,
  LiveAgentsObservability,
  GrantRequest,
  ExternalActionAdapter,
  ExternalActionToolCall,
  Message,
  OutboundActionRecord,
  Promotion,
  PromotionRequest,
} from './types.js';
import type { ExecutionContext, MCPToolCallResponse } from '@weaveintel/core';
import { weaveResolveTracer } from '@weaveintel/core';
import {
  BreakGlassPolicyViolationError,
  ContractAuthorityViolationError,
  NoAuthorisedAccountError,
} from './errors.js';
import { createLiveAgentsRunLogger } from './replay.js';

function makeId(prefix: string, nowIso: string, suffix: string): string {
  return `${prefix}_${Date.parse(nowIso)}_${suffix}`;
}

function messageRecipientToFields(action: Extract<AttentionAction, { type: 'DraftMessage' }>): {
  toType: Message['toType'];
  toId: string | null;
} {
  if (action.to.type === 'BROADCAST') {
    return { toType: 'BROADCAST', toId: null };
  }
  if (action.to.type === 'TEAM') {
    return { toType: 'TEAM', toId: action.to.id };
  }
  if (action.to.type === 'HUMAN') {
    return { toType: 'HUMAN', toId: action.to.id };
  }
  return { toType: 'AGENT', toId: action.to.id };
}

async function saveOutboundStub(
  context: ActionExecutionContext,
  toolName: string,
  purposeProse: string,
  summaryProse: string,
  executionCtx?: ExecutionContext,
  observability?: LiveAgentsObservability,
): Promise<string> {
  const accountId = context.activeBindings[0]?.accountId ?? 'unbound-account';
  const id = makeId('outbound', context.nowIso, Math.random().toString(36).slice(2, 10));
  const record: OutboundActionRecord = {
    id,
    agentId: context.agent.id,
    accountId,
    mcpToolName: toolName,
    idempotencyKey: `${context.tickId}:${id}`,
    requiresHumanApproval: false,
    approvalTaskId: null,
    status: 'DRAFTED',
    sentAt: null,
    externalRef: null,
    createdAt: context.nowIso,
    purposeProse,
    summaryProse,
    errorProse: null,
  };
  await withObservedSpan(
    observability,
    executionCtx,
    'live_agents.outbound.save',
    {
      actionType: 'stub',
      toolName,
      status: record.status,
      agentId: context.agent.id,
    },
    () => context.stateStore.saveOutboundActionRecord(record),
  );
  return id;
}

async function saveOutboundRecord(
  context: ActionExecutionContext,
  accountId: string,
  toolName: string,
  purposeProse: string,
  summaryProse: string,
  status: OutboundActionRecord['status'],
  externalRef: string | null,
  errorProse: string | null,
  executionCtx?: ExecutionContext,
  observability?: LiveAgentsObservability,
): Promise<string> {
  const id = makeId('outbound', context.nowIso, Math.random().toString(36).slice(2, 10));
  const record: OutboundActionRecord = {
    id,
    agentId: context.agent.id,
    accountId,
    mcpToolName: toolName,
    idempotencyKey: `${context.tickId}:${id}`,
    requiresHumanApproval: false,
    approvalTaskId: null,
    status,
    sentAt: status === 'SENT' ? context.nowIso : null,
    externalRef,
    createdAt: context.nowIso,
    purposeProse,
    summaryProse,
    errorProse,
  };
  await withObservedSpan(
    observability,
    executionCtx,
    'live_agents.outbound.save',
    {
      actionType: 'external',
      toolName,
      status,
      agentId: context.agent.id,
    },
    () => context.stateStore.saveOutboundActionRecord(record),
  );
  return id;
}

async function withObservedSpan<T>(
  observability: LiveAgentsObservability | undefined,
  executionCtx: ExecutionContext | undefined,
  name: string,
  attributes: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const tracer = executionCtx ? weaveResolveTracer(executionCtx, observability?.tracer) : observability?.tracer;
  if (!tracer || !executionCtx) {
    return fn();
  }
  return tracer.withSpan(executionCtx, name, () => fn(), attributes);
}

function responseSummary(response: MCPToolCallResponse): string {
  return response.content
    .map((part: MCPToolCallResponse['content'][number]) => {
      if (part.type === 'text') {
        return part.text;
      }
      if (part.type === 'resource') {
        return part.text ?? part.uri;
      }
      return `${part.mimeType}:${part.data.slice(0, 24)}`;
    })
    .join('\n')
    .trim();
}

function responseExternalRef(response: MCPToolCallResponse): string | null {
  const resourceRef = response.content.find((part: MCPToolCallResponse['content'][number]) => part.type === 'resource');
  if (resourceRef && resourceRef.type === 'resource') {
    return resourceRef.uri;
  }
  const textRef = response.content.find((part: MCPToolCallResponse['content'][number]) => part.type === 'text');
  return textRef && textRef.type === 'text' ? textRef.text : null;
}

async function loadPrimaryAccount(context: ActionExecutionContext, purpose: string): Promise<Account> {
  const binding = context.activeBindings[0];
  if (!binding) {
    throw new NoAuthorisedAccountError(context.agent.id, purpose);
  }
  const account = await context.stateStore.loadAccount(binding.accountId);
  if (!account || account.status !== 'ACTIVE' || account.revokedAt !== null) {
    throw new NoAuthorisedAccountError(context.agent.id, purpose);
  }
  return account;
}

function createDefaultExternalActionAdapter(): ExternalActionAdapter {
  return {
    async resolve(action, _context, account): Promise<ExternalActionToolCall | null> {
      switch (action.type) {
        case 'DraftMessage': {
          if (action.to.type !== 'HUMAN' || action.to.id === null) {
            return null;
          }
          return {
            toolName: account.provider === 'slack' ? 'slack.post' : `${account.provider}.send`,
            arguments:
              account.provider === 'slack'
                ? { channel: action.to.id, text: `${action.subject}\n\n${action.bodySeed}` }
                : { to: action.to.id, subject: action.subject, body: action.bodySeed },
            purposeProse: `Deliver message to ${action.to.id}`,
            summaryProse: action.subject,
          };
        }
        case 'IssueGrant':
          return {
            toolName: `${account.provider}.issue_grant`,
            arguments: {
              recipientAgentId: action.recipientAgentId,
              kind: action.capability.kindHint,
              description: action.capability.descriptionProse,
              scope: action.capability.scopeProse,
              durationHint: action.capability.durationHint,
              reason: action.capability.reasonProse,
            },
            purposeProse: `Issue grant to ${action.recipientAgentId}`,
            summaryProse: action.capability.descriptionProse,
          };
        case 'IssuePromotion':
          return {
            toolName: `${account.provider}.issue_promotion`,
            arguments: {
              recipientAgentId: action.recipientAgentId,
              role: action.newContractDraft.role,
              objectives: action.newContractDraft.objectives,
              successIndicators: action.newContractDraft.successIndicators,
              reason: action.reasonProse,
            },
            purposeProse: `Issue promotion to ${action.recipientAgentId}`,
            summaryProse: action.reasonProse,
          };
        case 'InvokeBreakGlass':
          return {
            toolName: `${account.provider}.invoke_break_glass`,
            arguments: {
              kind: action.capability.kindHint,
              description: action.capability.descriptionProse,
              reason: action.capability.reasonProse,
              emergencyReason: action.emergencyReasonProse,
              evidenceMessageIds: action.capability.evidenceMessageIds,
            },
            purposeProse: action.emergencyReasonProse,
            summaryProse: action.capability.descriptionProse,
          };
        default:
          return null;
      }
    },
  };
}

function includesEmergencyCondition(requiredConditionDescription: string, emergencyReasonProse: string): boolean {
  const requiredTokens = requiredConditionDescription
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
  if (requiredTokens.length === 0) {
    return true;
  }
  const reason = emergencyReasonProse.toLowerCase();
  return requiredTokens.some((token) => reason.includes(token));
}

async function tryExecuteExternalAction(
  action: AttentionAction,
  context: ActionExecutionContext,
  ctx: ExecutionContext,
  sessionProvider: AccountSessionProvider,
  externalActionAdapter: ExternalActionAdapter,
  observability?: LiveAgentsObservability,
): Promise<{
  recordId: string;
  response: MCPToolCallResponse;
} | null> {
  const account = await loadPrimaryAccount(context, `execute ${action.type}`);
  const plan = await externalActionAdapter.resolve(action, context, account);
  if (!plan) {
    return null;
  }

  const session = await sessionProvider.getSession({
    account,
    agent: context.agent,
    ctx,
  });
  if (!(await sessionHasTool(session, plan.toolName))) {
    return null;
  }

  const response = await executeSessionTool(session, ctx, {
    name: plan.toolName,
    arguments: plan.arguments,
  });

  const recordId = await saveOutboundRecord(
    context,
    account.id,
    plan.toolName,
    plan.purposeProse,
    responseSummary(response) || plan.summaryProse,
    response.isError ? 'FAILED' : 'SENT',
    responseExternalRef(response),
    response.isError ? responseSummary(response) || 'MCP tool returned an error.' : null,
    ctx,
    observability,
  );

  return { recordId, response };
}

async function sessionHasTool(
  session: Awaited<ReturnType<AccountSessionProvider['getSession']>>,
  toolName: string,
): Promise<boolean> {
  if (session.discoverCapabilities) {
    const namespacePrefix = toolName.includes('.') ? toolName.slice(0, toolName.indexOf('.')) : undefined;
    let cursor: string | undefined;

    do {
      const page = await session.discoverCapabilities({
        cursor,
        namespacePrefix,
        limit: 100,
      });
      if (page.items.some((item) => item.kind === 'tool' && item.name === toolName)) {
        return true;
      }
      cursor = page.nextCursor;
    } while (cursor);

    return false;
  }

  const tools = await session.listTools();
  return tools.some((tool) => tool.name === toolName);
}

async function executeSessionTool(
  session: Awaited<ReturnType<AccountSessionProvider['getSession']>>,
  ctx: ExecutionContext,
  request: { name: string; arguments: Record<string, unknown> },
): Promise<MCPToolCallResponse> {
  if (session.streamToolCall) {
    let finalOutput: MCPToolCallResponse | undefined;
    for await (const event of session.streamToolCall(ctx, request)) {
      if (event.output) {
        finalOutput = event.output;
      }
      if (event.type === 'final_output' && event.output) {
        return event.output;
      }
    }
    if (finalOutput) {
      return finalOutput;
    }
  }

  return session.callTool(ctx, request);
}

export function createActionExecutor(opts?: {
  sessionProvider?: AccountSessionProvider;
  externalActionAdapter?: ExternalActionAdapter;
  observability?: LiveAgentsObservability;
}): ActionExecutor {
  const resolvedObservability = {
    ...opts?.observability,
    runLogger: opts?.observability?.runLogger ?? createLiveAgentsRunLogger(),
  };
  const externalActionAdapter = opts?.externalActionAdapter ?? createDefaultExternalActionAdapter();
  return {
    async execute(action, context, ctx): Promise<ActionExecutionResult> {
      const runLogger = resolvedObservability.runLogger;
      runLogger?.startRun(ctx.executionId);
      const executeStart = Date.now();
      const createdMessageIds: string[] = [];
      const createdOutboundRecordIds: string[] = [];
      const updatedBacklogItemIds: string[] = [];
      const saveMessageObserved = (message: Message) => withObservedSpan(
        resolvedObservability,
        ctx,
        'live_agents.message.save',
        {
          actionType: action.type,
          kind: message.kind,
          toType: message.toType,
          agentId: context.agent.id,
        },
        () => context.stateStore.saveMessage(message),
      );
      const saveGrantObserved = (grant: CapabilityGrant) => withObservedSpan(
        resolvedObservability,
        ctx,
        'live_agents.grant.save',
        {
          actionType: action.type,
          grantKind: grant.kind,
          recipientId: grant.recipientId,
          agentId: context.agent.id,
        },
        () => context.stateStore.saveCapabilityGrant(grant),
      );
      const savePromotionObserved = (promotion: Promotion) => withObservedSpan(
        resolvedObservability,
        ctx,
        'live_agents.promotion.save',
        {
          actionType: action.type,
          promotionId: promotion.id,
          agentId: context.agent.id,
        },
        () => context.stateStore.savePromotion(promotion),
      );

      return withObservedSpan<ActionExecutionResult>(
        resolvedObservability,
        ctx,
        'live_agents.action.execute',
        {
          actionType: action.type,
          agentId: context.agent.id,
          tickId: context.tickId,
        },
        async () => {

      switch (action.type) {
        case 'ProcessMessage': {
          await context.stateStore.transitionMessageStatus(action.messageId, 'PROCESSED', context.nowIso);
          return {
            status: 'SUCCESS',
            summaryProse: `Processed message ${action.messageId}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'ContinueTask': {
          await context.stateStore.transitionBacklogItemStatus(action.backlogItemId, 'IN_PROGRESS', context.nowIso);
          updatedBacklogItemIds.push(action.backlogItemId);
          return {
            status: 'SUCCESS',
            summaryProse: `Continued backlog item ${action.backlogItemId}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'StartTask': {
          await context.stateStore.transitionBacklogItemStatus(action.backlogItemId, 'IN_PROGRESS', context.nowIso);
          updatedBacklogItemIds.push(action.backlogItemId);
          return {
            status: 'SUCCESS',
            summaryProse: `Started backlog item ${action.backlogItemId}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'DraftMessage': {
          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          const recipient = messageRecipientToFields(action);
          let messageStatus: Message['status'] = 'PENDING';
          let deliveredAt: string | null = null;

          if (opts?.sessionProvider) {
            const externalResult = await tryExecuteExternalAction(
              action,
              context,
              ctx,
              opts.sessionProvider,
              externalActionAdapter,
              opts?.observability,
            );
            if (externalResult) {
              createdOutboundRecordIds.push(externalResult.recordId);
              messageStatus = externalResult.response.isError ? 'FAILED' : 'DELIVERED';
              deliveredAt = externalResult.response.isError ? null : context.nowIso;
            }
          }

          const message: Message = {
            id: messageId,
            meshId: context.agent.meshId,
            fromType: 'AGENT',
            fromId: context.agent.id,
            fromMeshId: context.agent.meshId,
            toType: recipient.toType,
            toId: recipient.toId,
            topic: null,
            kind: action.kind,
            replyToMessageId: null,
            threadId: messageId,
            contextRefs: [],
            contextPacketRef: null,
            expiresAt: null,
            priority: 'NORMAL',
            status: messageStatus,
            deliveredAt,
            readAt: null,
            processedAt: null,
            createdAt: context.nowIso,
            subject: action.subject,
            body: action.bodySeed,
          };
          await saveMessageObserved(message);
          createdMessageIds.push(messageId);
          return {
            status: messageStatus === 'FAILED' ? 'FAILED' : 'SUCCESS',
            summaryProse: messageStatus === 'DELIVERED' ? `Delivered message ${messageId}` : `Drafted message ${messageId}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'RequestCapability': {
          const requestId = makeId('grant_request', context.nowIso, Math.random().toString(36).slice(2, 10));
          const request: GrantRequest = {
            id: requestId,
            meshId: context.agent.meshId,
            recipientType: 'AGENT',
            recipientId: context.agent.id,
            requestedByType: 'AGENT',
            requestedById: context.agent.id,
            kindHint: action.capability.kindHint,
            status: 'OPEN',
            resolvedByType: null,
            resolvedById: null,
            resolvedGrantId: null,
            createdAt: context.nowIso,
            resolvedAt: null,
            expiresAt: null,
            descriptionProse: action.capability.descriptionProse,
            reasonProse: action.capability.reasonProse,
            resolutionReasonProse: null,
            evidenceRefs: action.capability.evidenceMessageIds,
          };
          await context.stateStore.saveGrantRequest(request);

          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          const message: Message = {
            id: messageId,
            meshId: context.agent.meshId,
            fromType: 'AGENT',
            fromId: context.agent.id,
            fromMeshId: context.agent.meshId,
            toType: 'HUMAN',
            toId: null,
            topic: 'capability-request',
            kind: 'GRANT_REQUEST',
            replyToMessageId: null,
            threadId: messageId,
            contextRefs: [requestId, ...action.capability.evidenceMessageIds],
            contextPacketRef: null,
            expiresAt: null,
            priority: 'HIGH',
            status: 'PENDING',
            deliveredAt: null,
            readAt: null,
            processedAt: null,
            createdAt: context.nowIso,
            subject: `Capability request: ${action.capability.kindHint}`,
            body: `${action.capability.descriptionProse}\n\nReason: ${action.capability.reasonProse}`,
          };
          await saveMessageObserved(message);
          createdMessageIds.push(messageId);
          return {
            status: 'SUCCESS',
            summaryProse: `Requested capability ${action.capability.kindHint}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'RequestAccountBinding': {
          const requestId = makeId('binding_request', context.nowIso, Math.random().toString(36).slice(2, 10));
          await context.stateStore.saveAccountBindingRequest({
            id: requestId,
            meshId: context.agent.meshId,
            agentId: context.agent.id,
            accountId: action.account,
            requestedByType: 'AGENT',
            requestedById: context.agent.id,
            status: 'OPEN',
            resolvedByHumanId: null,
            resolvedAccountBindingId: null,
            createdAt: context.nowIso,
            resolvedAt: null,
            expiresAt: null,
            purposeProse: action.purposeProse,
            reasonProse: action.purposeProse,
            resolutionReasonProse: null,
            evidenceRefs: [],
          });
          return {
            status: 'SUCCESS',
            summaryProse: `Requested account binding for ${action.account}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'RequestPromotion': {
          const requestId = makeId('promotion_request', context.nowIso, Math.random().toString(36).slice(2, 10));
          const request: PromotionRequest = {
            id: requestId,
            meshId: context.agent.meshId,
            recipientId: context.agent.id,
            requestedByType: 'AGENT',
            requestedById: context.agent.id,
            status: 'OPEN',
            reviewedByType: null,
            reviewedById: null,
            resolvedContractVersionId: null,
            createdAt: context.nowIso,
            resolvedAt: null,
            expiresAt: null,
            targetRole: action.targetRole,
            scopeDeltaProse: action.reasonProse,
            reasonProse: action.reasonProse,
            resolutionReasonProse: null,
            evidenceRefs: action.evidenceMessageIds,
          };
          await context.stateStore.savePromotionRequest(request);

          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          await saveMessageObserved({
            id: messageId,
            meshId: context.agent.meshId,
            fromType: 'AGENT',
            fromId: context.agent.id,
            fromMeshId: context.agent.meshId,
            toType: 'HUMAN',
            toId: null,
            topic: 'promotion-request',
            kind: 'PROMOTION_REQUEST',
            replyToMessageId: null,
            threadId: messageId,
            contextRefs: [requestId, ...action.evidenceMessageIds],
            contextPacketRef: null,
            expiresAt: null,
            priority: 'HIGH',
            status: 'PENDING',
            deliveredAt: null,
            readAt: null,
            processedAt: null,
            createdAt: context.nowIso,
            subject: `Promotion request to ${action.targetRole}`,
            body: action.reasonProse,
          });
          createdMessageIds.push(messageId);
          return {
            status: 'SUCCESS',
            summaryProse: `Requested promotion to ${action.targetRole}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'IssueGrant': {
          const grantId = makeId('grant', context.nowIso, Math.random().toString(36).slice(2, 10));
          const capabilityGrant: CapabilityGrant = {
            id: grantId,
            meshId: context.agent.meshId,
            recipientType: 'AGENT',
            recipientId: action.recipientAgentId,
            issuerType: 'AGENT',
            issuerId: context.agent.id,
            kind: action.capability.kindHint,
            trigger: 'DELEGATE',
            grantedAt: context.nowIso,
            expiresAt: null,
            revokedAt: null,
            revokedByType: null,
            revokedById: null,
            probation: false,
            probationUntil: null,
            descriptionProse: action.capability.descriptionProse,
            scopeProse: action.capability.scopeProse,
            reasonProse: action.capability.reasonProse,
            revocationReasonProse: null,
            probationConditionsProse: null,
            limits: {},
            evidenceRefs: [],
          };
          await saveGrantObserved(capabilityGrant);

          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          await saveMessageObserved({
            id: messageId,
            meshId: context.agent.meshId,
            fromType: 'AGENT',
            fromId: context.agent.id,
            fromMeshId: context.agent.meshId,
            toType: 'AGENT',
            toId: action.recipientAgentId,
            topic: 'grant-notice',
            kind: 'GRANT_NOTICE',
            replyToMessageId: null,
            threadId: messageId,
            contextRefs: [grantId],
            contextPacketRef: null,
            expiresAt: null,
            priority: 'NORMAL',
            status: 'PENDING',
            deliveredAt: null,
            readAt: null,
            processedAt: null,
            createdAt: context.nowIso,
            subject: `Grant issued: ${action.capability.kindHint}`,
            body: action.capability.descriptionProse,
          });
          createdMessageIds.push(messageId);
          if (opts?.sessionProvider) {
            const externalResult = await tryExecuteExternalAction(
              action,
              context,
              ctx,
              opts.sessionProvider,
              externalActionAdapter,
              opts?.observability,
            );
            if (externalResult) {
              createdOutboundRecordIds.push(externalResult.recordId);
            } else {
              createdOutboundRecordIds.push(
                await saveOutboundStub(
                  context,
                  'external.grants.issue.stub',
                  `Issue grant to ${action.recipientAgentId}`,
                  action.capability.reasonProse,
                  ctx,
                  opts?.observability,
                ),
              );
            }
          } else {
            createdOutboundRecordIds.push(
              await saveOutboundStub(
                context,
                'external.grants.issue.stub',
                `Issue grant to ${action.recipientAgentId}`,
                action.capability.reasonProse,
                ctx,
                opts?.observability,
              ),
            );
          }
          return {
            status: 'SUCCESS',
            summaryProse: `Issued grant for ${action.recipientAgentId}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'IssuePromotion': {
          const issuerContract = await context.stateStore.loadLatestContractForAgent(context.agent.id);
          if (!issuerContract?.contractAuthority?.canIssuePromotions) {
            throw new ContractAuthorityViolationError(
              `Agent ${context.agent.id} is not allowed to issue promotions.`,
            );
          }

          const recipient = await context.stateStore.loadAgent(action.recipientAgentId);
          if (!recipient) {
            throw new ContractAuthorityViolationError(
              `Cannot issue promotion because recipient agent ${action.recipientAgentId} was not found.`,
            );
          }

          const currentRecipientContract = await context.stateStore.loadLatestContractForAgent(recipient.id);
          if (!currentRecipientContract) {
            throw new ContractAuthorityViolationError(
              `Cannot issue promotion because recipient ${recipient.id} has no active contract.`,
            );
          }

          const nextContractVersion = currentRecipientContract.version + 1;
          const promotedContractId = makeId('contract', context.nowIso, Math.random().toString(36).slice(2, 10));
          await context.stateStore.saveContract({
            ...currentRecipientContract,
            id: promotedContractId,
            version: nextContractVersion,
            persona: currentRecipientContract.persona,
            objectives: action.newContractDraft.objectives,
            successIndicators: action.newContractDraft.successIndicators,
            createdAt: context.nowIso,
          });

          await context.stateStore.saveAgent({
            ...recipient,
            role: action.newContractDraft.role,
            contractVersionId: promotedContractId,
          });

          const promotionId = makeId('promotion', context.nowIso, Math.random().toString(36).slice(2, 10));
          const promotion: Promotion = {
            id: promotionId,
            agentId: recipient.id,
            fromContractVersionId: currentRecipientContract.id,
            toContractVersionId: promotedContractId,
            trigger: 'REQUESTED',
            issuedByType: 'AGENT',
            issuedById: context.agent.id,
            issuedAt: context.nowIso,
            scopeDeltaSummaryProse: action.reasonProse,
            evidenceRefs: [],
          };
          await savePromotionObserved(promotion);

          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          await saveMessageObserved({
            id: messageId,
            meshId: context.agent.meshId,
            fromType: 'AGENT',
            fromId: context.agent.id,
            fromMeshId: context.agent.meshId,
            toType: 'AGENT',
            toId: action.recipientAgentId,
            topic: 'promotion-notice',
            kind: 'PROMOTION_NOTICE',
            replyToMessageId: null,
            threadId: messageId,
            contextRefs: [promotionId, promotedContractId],
            contextPacketRef: null,
            expiresAt: null,
            priority: 'NORMAL',
            status: 'PENDING',
            deliveredAt: null,
            readAt: null,
            processedAt: null,
            createdAt: context.nowIso,
            subject: `Promotion issued: ${action.newContractDraft.role}`,
            body: action.reasonProse,
          });
          createdMessageIds.push(messageId);
          if (opts?.sessionProvider) {
            const externalResult = await tryExecuteExternalAction(
              action,
              context,
              ctx,
              opts.sessionProvider,
              externalActionAdapter,
              opts?.observability,
            );
            if (externalResult) {
              createdOutboundRecordIds.push(externalResult.recordId);
            } else {
              createdOutboundRecordIds.push(
                await saveOutboundStub(
                  context,
                  'external.promotion.issue.stub',
                  `Issue promotion to ${action.recipientAgentId}`,
                  action.reasonProse,
                  ctx,
                  opts?.observability,
                ),
              );
            }
          } else {
            createdOutboundRecordIds.push(
              await saveOutboundStub(
                context,
                'external.promotion.issue.stub',
                `Issue promotion to ${action.recipientAgentId}`,
                action.reasonProse,
                ctx,
                opts?.observability,
              ),
            );
          }
          return {
            status: 'SUCCESS',
            summaryProse: `Issued promotion for ${action.recipientAgentId} with new contract ${promotedContractId}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'EscalateToHuman': {
          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          await saveMessageObserved({
            id: messageId,
            meshId: context.agent.meshId,
            fromType: 'AGENT',
            fromId: context.agent.id,
            fromMeshId: context.agent.meshId,
            toType: 'HUMAN',
            toId: null,
            topic: 'escalation',
            kind: 'ESCALATION',
            replyToMessageId: null,
            threadId: messageId,
            contextRefs: [],
            contextPacketRef: null,
            expiresAt: null,
            priority: 'URGENT',
            status: 'PENDING',
            deliveredAt: null,
            readAt: null,
            processedAt: null,
            createdAt: context.nowIso,
            subject: 'Escalation required',
            body: `${action.reasonProse}\n\nOptions: ${action.optionsProse}`,
          });
          createdMessageIds.push(messageId);
          return {
            status: 'SUCCESS',
            summaryProse: 'Escalated to human',
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'InvokeBreakGlass': {
          const contract = await context.stateStore.loadLatestContractForAgent(context.agent.id);
          if (!contract?.breakGlass) {
            throw new BreakGlassPolicyViolationError(
              `Agent ${context.agent.id} cannot invoke break-glass without contract breakGlass constraints.`,
            );
          }
          if (!contract.breakGlass.allowedCapabilityKinds.includes(action.capability.kindHint)) {
            throw new BreakGlassPolicyViolationError(
              `Break-glass kind ${action.capability.kindHint} is not allowed for agent ${context.agent.id}.`,
            );
          }
          if (
            !includesEmergencyCondition(
              contract.breakGlass.requiredEmergencyConditionsDescription,
              action.emergencyReasonProse,
            )
          ) {
            throw new BreakGlassPolicyViolationError(
              `Emergency reason does not satisfy contract emergency conditions for agent ${context.agent.id}.`,
            );
          }

          const nowMs = Date.parse(context.nowIso);
          const expiryMs = nowMs + contract.breakGlass.maxDurationMinutes * 60_000;
          const expiresAt = new Date(expiryMs).toISOString();
          const grantId = makeId('grant', context.nowIso, Math.random().toString(36).slice(2, 10));
          const reviewTaskId = makeId('bl', context.nowIso, Math.random().toString(36).slice(2, 10));
          const invocationId = makeId('breakglass', context.nowIso, Math.random().toString(36).slice(2, 10));

          await saveGrantObserved({
            id: grantId,
            meshId: context.agent.meshId,
            recipientType: 'AGENT',
            recipientId: context.agent.id,
            issuerType: 'AGENT',
            issuerId: context.agent.id,
            kind: action.capability.kindHint,
            trigger: 'BREAK_GLASS',
            grantedAt: context.nowIso,
            expiresAt,
            revokedAt: null,
            revokedByType: null,
            revokedById: null,
            probation: false,
            probationUntil: null,
            descriptionProse: action.capability.descriptionProse,
            scopeProse: 'Emergency-only temporary elevation.',
            reasonProse: action.emergencyReasonProse,
            revocationReasonProse: null,
            probationConditionsProse: null,
            limits: {},
            evidenceRefs: action.capability.evidenceMessageIds,
          });

          await context.stateStore.saveBacklogItem({
            id: reviewTaskId,
            agentId: context.agent.id,
            priority: 'HIGH',
            status: 'PROPOSED',
            originType: 'SYSTEM',
            originRef: invocationId,
            blockedOnMessageId: null,
            blockedOnGrantRequestId: null,
            blockedOnPromotionRequestId: null,
            blockedOnAccountBindingRequestId: null,
            estimatedEffort: 'PT30M',
            deadline: expiresAt,
            acceptedAt: null,
            startedAt: null,
            completedAt: null,
            createdAt: context.nowIso,
            title: 'Break-glass post-incident review',
            description: `Review required for break-glass invocation ${invocationId}.`,
          });

          await context.stateStore.saveBreakGlassInvocation({
            id: invocationId,
            agentId: context.agent.id,
            grantId,
            invokedAt: context.nowIso,
            expiresAt,
            postReviewTaskId: reviewTaskId,
            reviewOutcome: 'PENDING',
            reviewedAt: null,
            capabilityDescriptionProse: action.capability.descriptionProse,
            emergencyReasonProse: action.emergencyReasonProse,
            evidenceRefs: action.capability.evidenceMessageIds,
          });

          const reviewMessageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          await saveMessageObserved({
            id: reviewMessageId,
            meshId: context.agent.meshId,
            fromType: 'AGENT',
            fromId: context.agent.id,
            fromMeshId: context.agent.meshId,
            toType: 'HUMAN',
            toId: null,
            topic: 'break-glass-review',
            kind: 'ESCALATION',
            replyToMessageId: null,
            threadId: reviewMessageId,
            contextRefs: [grantId, invocationId, reviewTaskId],
            contextPacketRef: null,
            expiresAt: null,
            priority: 'URGENT',
            status: 'PENDING',
            deliveredAt: null,
            readAt: null,
            processedAt: null,
            createdAt: context.nowIso,
            subject: 'Break-glass invoked: human review required',
            body: action.emergencyReasonProse,
          });
          createdMessageIds.push(reviewMessageId);

          if (opts?.sessionProvider) {
            const externalResult = await tryExecuteExternalAction(
              action,
              context,
              ctx,
              opts.sessionProvider,
              externalActionAdapter,
              opts?.observability,
            );
            if (externalResult) {
              createdOutboundRecordIds.push(externalResult.recordId);
            } else {
              createdOutboundRecordIds.push(
                await saveOutboundStub(
                  context,
                  'external.breakglass.invoke.stub',
                  action.emergencyReasonProse,
                  `breakglass:${invocationId}`,
                  ctx,
                  opts?.observability,
                ),
              );
            }
          } else {
            createdOutboundRecordIds.push(
              await saveOutboundStub(
                context,
                'external.breakglass.invoke.stub',
                action.emergencyReasonProse,
                `breakglass:${invocationId}`,
                ctx,
                opts?.observability,
              ),
            );
          }
          return {
            status: 'SUCCESS',
            summaryProse: `Break-glass invoked with temporary grant ${grantId} and review task ${reviewTaskId}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'EmitEpisodicMarker': {
          return {
            status: 'SUCCESS',
            summaryProse: `Episodic marker emitted: ${action.summaryProse}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'RequestCompressionRefresh': {
          return {
            status: 'SUCCESS',
            summaryProse: 'Compression refresh requested',
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'CheckpointAndRest':
        case 'NoopRest': {
          await context.stateStore.saveHeartbeatTick({
            id: makeId('tick', context.nowIso, Math.random().toString(36).slice(2, 10)),
            agentId: context.agent.id,
            scheduledFor: action.nextTickAt,
            pickedUpAt: null,
            completedAt: null,
            workerId: 'scheduler',
            leaseExpiresAt: null,
            actionChosen: null,
            actionOutcomeProse: null,
            actionOutcomeStatus: null,
            status: 'SCHEDULED',
          });
          return {
            status: 'SUCCESS',
            summaryProse: `Scheduled next heartbeat tick at ${action.nextTickAt}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
      }
        },
      ).then((result) => {
        runLogger?.recordStep(ctx.executionId, {
          type: 'action',
          name: action.type,
          startTime: executeStart,
          endTime: Date.now(),
          input: {
            tickId: context.tickId,
            agentId: context.agent.id,
            actionType: action.type,
          },
          output: {
            status: result.status,
            summaryProse: result.summaryProse,
            createdMessageCount: result.createdMessageIds.length,
            createdOutboundCount: result.createdOutboundRecordIds.length,
          },
        });
        return result;
      });
    },
  };
}
