export type GrantTrigger =
  | 'REQUEST'
  | 'DELEGATE'
  | 'SCOPE_CHANGE'
  | 'RECOMMENDATION'
  | 'PROBATION'
  | 'BREAK_GLASS'
  | 'ROLE_CHANGE'
  | 'SUCCESSION'
  | 'USER_INITIATED'
  | 'REFUSAL_REMEDIATION';

export type GrantKind =
  | 'BUDGET_INCREASE'
  | 'WORKING_HOURS_OVERRIDE'
  | 'AUTHORITY_EXTENSION'
  | 'COLLEAGUE_INTRODUCTION'
  | 'MESH_BRIDGE';

export interface CapabilityGrant {
  id: string;
  meshId: string;
  recipientType: 'AGENT' | 'TEAM';
  recipientId: string;
  issuerType: 'HUMAN' | 'AGENT' | 'SYSTEM';
  issuerId: string;
  kind: GrantKind;
  trigger: GrantTrigger;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByType: 'HUMAN' | 'AGENT' | 'SYSTEM' | null;
  revokedById: string | null;
  probation: boolean;
  probationUntil: string | null;
  descriptionProse: string;
  scopeProse: string;
  reasonProse: string;
  revocationReasonProse: string | null;
  probationConditionsProse: string | null;
  limits: {
    extraBudgetMonthlyUsd?: number;
    workingHoursExtensionMinutes?: number;
  };
  evidenceRefs: string[];
}

export interface GrantRequest {
  id: string;
  meshId: string;
  recipientType: 'AGENT' | 'TEAM';
  recipientId: string;
  requestedByType: 'AGENT' | 'HUMAN';
  requestedById: string;
  kindHint: GrantKind;
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  resolvedByType: 'HUMAN' | 'AGENT' | null;
  resolvedById: string | null;
  resolvedGrantId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
  descriptionProse: string;
  reasonProse: string;
  resolutionReasonProse: string | null;
  evidenceRefs: string[];
}

export interface BreakGlassInvocation {
  id: string;
  agentId: string;
  grantId: string;
  invokedAt: string;
  expiresAt: string;
  postReviewTaskId: string;
  reviewOutcome: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  reviewedAt: string | null;
  capabilityDescriptionProse: string;
  emergencyReasonProse: string;
  evidenceRefs: string[];
}

export interface PromotionRequest {
  id: string;
  meshId: string;
  recipientId: string;
  requestedByType: 'AGENT' | 'HUMAN';
  requestedById: string;
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED';
  reviewedByType: 'HUMAN' | 'AGENT' | null;
  reviewedById: string | null;
  resolvedContractVersionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
  targetRole: string;
  scopeDeltaProse: string;
  reasonProse: string;
  resolutionReasonProse: string | null;
  evidenceRefs: string[];
}

export interface Promotion {
  id: string;
  agentId: string;
  fromContractVersionId: string;
  toContractVersionId: string;
  trigger: 'REQUESTED' | 'RECOMMENDED' | 'ROLE_CHANGE' | 'SUCCESSION' | 'USER_INITIATED';
  issuedByType: 'HUMAN' | 'AGENT';
  issuedById: string;
  issuedAt: string;
  scopeDeltaSummaryProse: string;
  evidenceRefs: string[];
}
