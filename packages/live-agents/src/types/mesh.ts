import type { GrantKind } from './grants.js';

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

export interface CrossMeshBridge {
  id: string;
  fromMeshId: string;
  toMeshId: string;
  allowedAgentPairs: Array<{ fromAgentId: string; toAgentId: string }> | null;
  allowedTopics: string[] | null;
  rateLimitPerHour: number | null;
  authorisedByType: 'HUMAN' | 'AGENT';
  authorisedById: string;
  coAuthorisedByType: 'HUMAN' | 'AGENT' | null;
  coAuthorisedById: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  revokedAt: string | null;
  purposeProse: string;
  constraintsProse: string;
}

export interface GrantAuthorityConstraints {
  mayIssueKinds: GrantKind[];
  scopePredicate: string;
  maxBudgetIncreaseUsd: number | null;
  requiresEvidence: boolean;
  dualControl: boolean;
}

export interface BreakGlassConstraints {
  allowedCapabilityKinds: GrantKind[];
  maxDurationMinutes: number;
  requiredEmergencyConditionsDescription: string;
}

export interface ContractAuthorityConstraints {
  canIssueContracts: boolean;
  canIssuePromotions: boolean;
  scopePredicate: string;
  requiresEvidence: boolean;
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
  grantAuthority?: GrantAuthorityConstraints | null;
  contractAuthority?: ContractAuthorityConstraints | null;
  breakGlass?: BreakGlassConstraints | null;
  accountBindingRefs: string[];
  attentionPolicyRef: string;
  reviewCadence: string;
  contextPolicy: ContextPolicy;
  createdAt: string;
}
