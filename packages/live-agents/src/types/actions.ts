import type { Model, ExecutionContext } from '@weaveintel/core';
import type { GrantKind } from './grants.js';
import type { LiveAgent, AgentContract } from './mesh.js';
import type { Message, MessageKind, BacklogItem } from './messaging.js';
import type { AccountBinding } from './accounts.js';

export interface Recipient {
  type: 'HUMAN' | 'AGENT' | 'TEAM' | 'BROADCAST';
  id: string | null;
}

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
  evidenceMessageIds?: string[];
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
  actionOutcomeStatus: 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED' | null;
  status: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
}

export interface AttentionContext {
  nowIso: string;
  agent: LiveAgent;
  contract: AgentContract | null;
  inbox: Message[];
  backlog: BacklogItem[];
  activeBindings: AccountBinding[];
  model: Model;
}

export interface AttentionPolicy {
  key: string;
  decide(context: AttentionContext, ctx: ExecutionContext): Promise<AttentionAction>;
}
