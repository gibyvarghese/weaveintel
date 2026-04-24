import type {
  ExecutionContext,
  Model,
  ModelRouter,
  RoutingDecision,
  RoutingPolicy,
  Message as ModelMessage,
} from '@weaveintel/core';
import type {
  AttentionAction,
  AttentionContext,
  AttentionPolicy,
  BacklogItem,
  GrantKind,
  Message,
  MessageKind,
  Recipient,
} from './types.js';

const ALLOWED_MESSAGE_KINDS = new Set([
  'ASK',
  'TASK',
  'REPORT',
  'ESCALATION',
  'GRANT_REQUEST',
  'GRANT_NOTICE',
  'PROMOTION_REQUEST',
  'PROMOTION_NOTICE',
  'BREAK_GLASS',
]);

const ALLOWED_GRANT_KINDS = new Set([
  'BUDGET_INCREASE',
  'WORKING_HOURS_OVERRIDE',
  'AUTHORITY_EXTENSION',
  'COLLEAGUE_INTRODUCTION',
  'MESH_BRIDGE',
]);

function nextTickIso(nowIso: string, minutes: number): string {
  return new Date(Date.parse(nowIso) + minutes * 60_000).toISOString();
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string');
}

function extractJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function summarizeMessage(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    fromType: message.fromType,
    fromId: message.fromId,
    toType: message.toType,
    toId: message.toId,
    kind: message.kind,
    status: message.status,
    priority: message.priority,
    subject: message.subject,
    body: message.body,
    createdAt: message.createdAt,
  };
}

function summarizeBacklog(item: BacklogItem): Record<string, unknown> {
  return {
    id: item.id,
    status: item.status,
    priority: item.priority,
    title: item.title,
    description: item.description,
    originType: item.originType,
    originRef: item.originRef,
    blockedOnMessageId: item.blockedOnMessageId,
    blockedOnGrantRequestId: item.blockedOnGrantRequestId,
    blockedOnPromotionRequestId: item.blockedOnPromotionRequestId,
    blockedOnAccountBindingRequestId: item.blockedOnAccountBindingRequestId,
    createdAt: item.createdAt,
    deadline: item.deadline,
  };
}

function buildModelMessages(
  context: AttentionContext,
  opts: Required<Pick<ModelAttentionPolicyOptions, 'maxInboxItems' | 'maxBacklogItems'>>,
  systemPromptOverride?: string,
): ModelMessage[] {
  const pendingMessages = context.inbox.filter((m) => m.status === 'PENDING' || m.status === 'DELIVERED');
  const inboxSlice = context.inbox.slice(0, opts.maxInboxItems).map(summarizeMessage);
  const backlogSlice = context.backlog.slice(0, opts.maxBacklogItems).map(summarizeBacklog);

  const payload = {
    nowIso: context.nowIso,
    agent: {
      id: context.agent.id,
      meshId: context.agent.meshId,
      name: context.agent.name,
      role: context.agent.role,
      status: context.agent.status,
    },
    contract: context.contract
      ? {
          id: context.contract.id,
          version: context.contract.version,
          persona: context.contract.persona,
          objectives: context.contract.objectives,
          successIndicators: context.contract.successIndicators,
          attentionPolicyRef: context.contract.attentionPolicyRef,
          reviewCadence: context.contract.reviewCadence,
          budget: context.contract.budget,
          workingHoursSchedule: context.contract.workingHoursSchedule,
          contextPolicy: context.contract.contextPolicy,
          grantAuthority: context.contract.grantAuthority,
          contractAuthority: context.contract.contractAuthority,
          breakGlass: context.contract.breakGlass,
        }
      : null,
    pendingMessageIds: pendingMessages.map((m) => m.id),
    inbox: inboxSlice,
    backlog: backlogSlice,
    activeBindings: context.activeBindings.map((binding) => ({
      id: binding.id,
      agentId: binding.agentId,
      accountId: binding.accountId,
      purpose: binding.purpose,
      constraints: binding.constraints,
      grantedAt: binding.grantedAt,
      expiresAt: binding.expiresAt,
    })),
  };

  const system = systemPromptOverride ?? [
    'You are the live-agents attention planner.',
    'Pick the NEXT best AttentionAction based on contract, inbox, backlog, and bindings.',
    'Respond ONLY with strict JSON object: {"action": AttentionAction, "reason": string}.',
    'Rules:',
    '- Prefer ProcessMessage for PENDING/DELIVERED inbox messages.',
    '- Use existing messageId/backlogItemId values from the input context.',
    '- Only emit supported action types from the AttentionAction union.',
    '- If there is no work, use CheckpointAndRest with a valid ISO nextTickAt.',
    '- Do not invent IDs or unsupported enum values.',
  ].join('\n');

  const user = [
    'Determine one next action.',
    'Context JSON:',
    JSON.stringify(payload),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function chooseSafeMessageId(context: AttentionContext, preferred: unknown): string | null {
  if (typeof preferred === 'string' && context.inbox.some((m) => m.id === preferred)) {
    return preferred;
  }
  const firstPending = context.inbox.find((m) => m.status === 'PENDING' || m.status === 'DELIVERED');
  return firstPending?.id ?? null;
}

function chooseSafeBacklogId(context: AttentionContext, preferred: unknown, statuses: BacklogItem['status'][]): string | null {
  if (
    typeof preferred === 'string' &&
    context.backlog.some((b) => b.id === preferred && statuses.includes(b.status))
  ) {
    return preferred;
  }
  const found = context.backlog.find((b) => statuses.includes(b.status));
  return found?.id ?? null;
}

function normalizeRecipient(value: unknown): Recipient | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const type = rec['type'];
  const id = rec['id'];
  if (
    (type === 'HUMAN' || type === 'AGENT' || type === 'TEAM' || type === 'BROADCAST') &&
    (typeof id === 'string' || id === null)
  ) {
    return { type, id };
  }
  return null;
}

function normalizeModelAction(raw: unknown, context: AttentionContext): AttentionAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const wrapped = raw as Record<string, unknown>;
  const source = (wrapped['action'] && typeof wrapped['action'] === 'object'
    ? wrapped['action']
    : wrapped) as Record<string, unknown>;

  const type = source['type'];
  if (typeof type !== 'string') {
    return null;
  }

  switch (type) {
    case 'ProcessMessage': {
      const messageId = chooseSafeMessageId(context, source['messageId']);
      return messageId ? { type, messageId } : null;
    }
    case 'ContinueTask': {
      const backlogItemId = chooseSafeBacklogId(context, source['backlogItemId'], ['IN_PROGRESS']);
      return backlogItemId ? { type, backlogItemId } : null;
    }
    case 'StartTask': {
      const backlogItemId = chooseSafeBacklogId(context, source['backlogItemId'], ['PROPOSED', 'ACCEPTED']);
      return backlogItemId ? { type, backlogItemId } : null;
    }
    case 'DraftMessage': {
      const to = normalizeRecipient(source['to']);
      const kind = asString(source['kind']);
      const subject = asString(source['subject']);
      const bodySeed = asString(source['bodySeed']);
      if (!to || !ALLOWED_MESSAGE_KINDS.has(kind) || subject.length === 0 || bodySeed.length === 0) {
        return null;
      }
      return { type, to, kind: kind as MessageKind, subject, bodySeed };
    }
    case 'RequestCapability': {
      const capabilityRaw = source['capability'];
      if (!capabilityRaw || typeof capabilityRaw !== 'object') return null;
      const capability = capabilityRaw as Record<string, unknown>;
      const kindHint = asString(capability['kindHint']);
      const descriptionProse = asString(capability['descriptionProse']);
      const reasonProse = asString(capability['reasonProse']);
      const evidenceMessageIds = asStringArray(capability['evidenceMessageIds']);
      if (!ALLOWED_GRANT_KINDS.has(kindHint) || !descriptionProse || !reasonProse) return null;
      return {
        type,
        capability: {
          kindHint: kindHint as GrantKind,
          descriptionProse,
          reasonProse,
          evidenceMessageIds,
        },
      } as AttentionAction;
    }
    case 'RequestAccountBinding': {
      const account = asString(source['account']);
      const purposeProse = asString(source['purposeProse']);
      return account && purposeProse ? { type, account, purposeProse } : null;
    }
    case 'RequestPromotion': {
      const targetRole = asString(source['targetRole']);
      const reasonProse = asString(source['reasonProse']);
      const evidenceMessageIds = asStringArray(source['evidenceMessageIds']);
      if (!targetRole || !reasonProse) return null;
      return { type, targetRole, reasonProse, evidenceMessageIds };
    }
    case 'IssueGrant': {
      const recipientAgentId = asString(source['recipientAgentId']);
      const capabilityRaw = source['capability'];
      if (!recipientAgentId || !capabilityRaw || typeof capabilityRaw !== 'object') return null;
      const capability = capabilityRaw as Record<string, unknown>;
      const kindHint = asString(capability['kindHint']);
      const descriptionProse = asString(capability['descriptionProse']);
      const scopeProse = asString(capability['scopeProse']);
      const durationHintRaw = capability['durationHint'];
      const reasonProse = asString(capability['reasonProse']);
      const durationHint = typeof durationHintRaw === 'string' ? durationHintRaw : null;
      const evidenceMessageIds = asStringArray(capability['evidenceMessageIds']);
      if (!ALLOWED_GRANT_KINDS.has(kindHint) || !descriptionProse || !scopeProse || !reasonProse) return null;
      return {
        type,
        recipientAgentId,
        capability: {
          kindHint: kindHint as GrantKind,
          descriptionProse,
          scopeProse,
          durationHint,
          reasonProse,
          evidenceMessageIds,
        },
      } as AttentionAction;
    }
    case 'IssuePromotion': {
      const recipientAgentId = asString(source['recipientAgentId']);
      const newContractDraftRaw = source['newContractDraft'];
      const reasonProse = asString(source['reasonProse']);
      if (!recipientAgentId || !newContractDraftRaw || typeof newContractDraftRaw !== 'object' || !reasonProse) return null;
      const draft = newContractDraftRaw as Record<string, unknown>;
      const role = asString(draft['role']);
      const objectives = asString(draft['objectives']);
      const successIndicators = asString(draft['successIndicators']);
      if (!role || !objectives || !successIndicators) return null;
      return { type, recipientAgentId, newContractDraft: { role, objectives, successIndicators }, reasonProse };
    }
    case 'EscalateToHuman': {
      const reasonProse = asString(source['reasonProse']);
      const optionsProse = asString(source['optionsProse']);
      return reasonProse && optionsProse ? { type, reasonProse, optionsProse } : null;
    }
    case 'InvokeBreakGlass': {
      const emergencyReasonProse = asString(source['emergencyReasonProse']);
      const capabilityRaw = source['capability'];
      if (!emergencyReasonProse || !capabilityRaw || typeof capabilityRaw !== 'object') return null;
      const capability = capabilityRaw as Record<string, unknown>;
      const kindHint = asString(capability['kindHint']);
      const descriptionProse = asString(capability['descriptionProse']);
      const reasonProse = asString(capability['reasonProse']);
      const evidenceMessageIds = asStringArray(capability['evidenceMessageIds']);
      if (!ALLOWED_GRANT_KINDS.has(kindHint) || !descriptionProse || !reasonProse) return null;
      return {
        type,
        capability: {
          kindHint: kindHint as GrantKind,
          descriptionProse,
          reasonProse,
          evidenceMessageIds,
        },
        emergencyReasonProse,
      } as AttentionAction;
    }
    case 'EmitEpisodicMarker': {
      const summaryProse = asString(source['summaryProse']);
      const tags = asStringArray(source['tags']);
      return summaryProse ? { type, summaryProse, tags } : null;
    }
    case 'RequestCompressionRefresh':
      return { type };
    case 'CheckpointAndRest': {
      const candidate = asString(source['nextTickAt']);
      return { type, nextTickAt: isIsoDate(candidate) ? candidate : nextTickIso(context.nowIso, 15) };
    }
    case 'NoopRest': {
      const candidate = asString(source['nextTickAt']);
      return { type, nextTickAt: isIsoDate(candidate) ? candidate : nextTickIso(context.nowIso, 15) };
    }
    default:
      return null;
  }
}

function getRoutingPrompt(context: AttentionContext): string {
  const primary = context.inbox.find((m) => m.status === 'PENDING' || m.status === 'DELIVERED') ?? context.inbox[0];
  if (!primary) {
    return `${context.agent.role} attention planning with no pending inbox messages.`;
  }
  return `${context.agent.role} attention planning for message kind=${primary.kind}, subject=${primary.subject}, body=${primary.body.slice(0, 500)}`;
}

export interface ModelAttentionPolicyOptions {
  key?: string;
  fallbackPolicy?: AttentionPolicy;
  systemPrompt?: string;
  maxInboxItems?: number;
  maxBacklogItems?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Creates an attention policy that invokes an LLM every tick and converts the
 * model output into a validated AttentionAction.
 *
 * The model is passed via AttentionContext (set by createHeartbeat), so this
 * policy simply uses context.model directly. Model routing should be done
 * externally before creating the heartbeat (same pattern as weaveAgent).
 */
export function createModelAttentionPolicy(opts: ModelAttentionPolicyOptions): AttentionPolicy {
  const fallbackPolicy = opts.fallbackPolicy ?? createStandardAttentionPolicy();
  const key = opts.key ?? 'model-attention-v1';
  const maxInboxItems = clampPositiveInt(opts.maxInboxItems, 25);
  const maxBacklogItems = clampPositiveInt(opts.maxBacklogItems, 25);

  return {
    key,
    async decide(context: AttentionContext, ctx: ExecutionContext): Promise<AttentionAction> {
      try {
        const modelMessages = buildModelMessages(
          context,
          { maxInboxItems, maxBacklogItems },
          opts.systemPrompt,
        );
        const response = await context.model.generate(ctx, {
          messages: modelMessages,
          responseFormat: { type: 'json_object' },
          temperature: opts.temperature ?? 0,
          maxTokens: opts.maxTokens ?? 700,
          metadata: {
            component: 'live-agents.attention',
            policyKey: key,
            agentId: context.agent.id,
          },
        });

        const parsed = extractJsonObject(response.content);
        const action = normalizeModelAction(parsed, context);
        
        if (action) {
          return action;
        }
        return fallbackPolicy.decide(context, ctx);
      } catch {
        return fallbackPolicy.decide(context, ctx);
      }
    },
  };
}

export function createStandardAttentionPolicy(): AttentionPolicy {
  return {
    key: 'standard-v1',
    async decide(context): Promise<AttentionAction> {
      const pendingMessage = context.inbox.find((message) => message.status === 'PENDING' || message.status === 'DELIVERED');
      if (pendingMessage) {
        return { type: 'ProcessMessage', messageId: pendingMessage.id };
      }

      const inProgress = context.backlog.find((item) => item.status === 'IN_PROGRESS');
      if (inProgress) {
        return { type: 'ContinueTask', backlogItemId: inProgress.id };
      }

      const accepted = context.backlog.find((item) => item.status === 'ACCEPTED' || item.status === 'PROPOSED');
      if (accepted) {
        return { type: 'StartTask', backlogItemId: accepted.id };
      }

      return {
        type: 'CheckpointAndRest',
        nextTickAt: nextTickIso(context.nowIso, 15),
      };
    },
  };
}
