import type {
  Account,
  AccountSessionProvider,
  ActionExecutionContext,
  ActionExecutionResult,
  ActionExecutor,
  AttentionAction,
  ExternalActionAdapter,
  ExternalActionToolCall,
  Message,
  OutboundActionRecord,
} from './types.js';
import type { ExecutionContext, MCPToolCallResponse } from '@weaveintel/core';
import { NoAuthorisedAccountError } from './errors.js';

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
  await context.stateStore.saveOutboundActionRecord(record);
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
): Promise<string> {
  const id = makeId('outbound', context.nowIso, Math.random().toString(36).slice(2, 10));
  await context.stateStore.saveOutboundActionRecord({
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
  });
  return id;
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

async function tryExecuteExternalAction(
  action: AttentionAction,
  context: ActionExecutionContext,
  ctx: ExecutionContext,
  sessionProvider: AccountSessionProvider,
  externalActionAdapter: ExternalActionAdapter,
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
  const tools = await session.listTools();
  if (!tools.some((tool) => tool.name === plan.toolName)) {
    return null;
  }

  const response = await session.callTool(ctx, {
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
  );

  return { recordId, response };
}

export function createActionExecutor(opts?: {
  sessionProvider?: AccountSessionProvider;
  externalActionAdapter?: ExternalActionAdapter;
}): ActionExecutor {
  const externalActionAdapter = opts?.externalActionAdapter ?? createDefaultExternalActionAdapter();
  return {
    async execute(action, context, ctx): Promise<ActionExecutionResult> {
      const createdMessageIds: string[] = [];
      const createdOutboundRecordIds: string[] = [];
      const updatedBacklogItemIds: string[] = [];

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
          await context.stateStore.saveMessage(message);
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
            contextRefs: action.capability.evidenceMessageIds,
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
          await context.stateStore.saveMessage(message);
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
          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          await context.stateStore.saveMessage({
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
            contextRefs: action.evidenceMessageIds,
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
          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          await context.stateStore.saveMessage({
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
            contextRefs: [],
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
          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          await context.stateStore.saveMessage({
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
            contextRefs: [],
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
              ),
            );
          }
          return {
            status: 'SUCCESS',
            summaryProse: `Issued promotion for ${action.recipientAgentId}`,
            createdMessageIds,
            createdOutboundRecordIds,
            updatedBacklogItemIds,
          };
        }
        case 'EscalateToHuman': {
          const messageId = makeId('msg', context.nowIso, Math.random().toString(36).slice(2, 10));
          await context.stateStore.saveMessage({
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
          if (opts?.sessionProvider) {
            const externalResult = await tryExecuteExternalAction(
              action,
              context,
              ctx,
              opts.sessionProvider,
              externalActionAdapter,
            );
            if (externalResult) {
              createdOutboundRecordIds.push(externalResult.recordId);
            } else {
              createdOutboundRecordIds.push(
                await saveOutboundStub(
                  context,
                  'external.breakglass.invoke.stub',
                  action.emergencyReasonProse,
                  action.capability.descriptionProse,
                ),
              );
            }
          } else {
            createdOutboundRecordIds.push(
              await saveOutboundStub(
                context,
                'external.breakglass.invoke.stub',
                action.emergencyReasonProse,
                action.capability.descriptionProse,
              ),
            );
          }
          return {
            status: 'PARTIAL',
            summaryProse: 'Created break-glass outbound stub for manual follow-through',
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
  };
}
