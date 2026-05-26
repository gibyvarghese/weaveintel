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
