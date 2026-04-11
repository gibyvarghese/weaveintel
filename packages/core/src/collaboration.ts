/**
 * @weaveintel/core — Collaboration contracts
 */

// ─── Shared Session ──────────────────────────────────────────

export interface SharedSession {
  id: string;
  name?: string;
  participants: SessionParticipant[];
  agentId?: string;
  workflowRunId?: string;
  status: 'active' | 'paused' | 'ended';
  createdAt: string;
  updatedAt: string;
}

export interface SessionParticipant {
  id: string;
  type: 'user' | 'agent';
  name: string;
  role: 'owner' | 'contributor' | 'observer';
  joinedAt: string;
  presence: PresenceState;
}

// ─── Events ──────────────────────────────────────────────────

export type CollaborationEventType =
  | 'participant:joined'
  | 'participant:left'
  | 'message:sent'
  | 'context:updated'
  | 'handoff:initiated'
  | 'handoff:completed';

export interface CollaborationEvent {
  id: string;
  sessionId: string;
  type: CollaborationEventType;
  participantId: string;
  data?: unknown;
  timestamp: string;
}

// ─── Context ─────────────────────────────────────────────────

export interface SharedContext {
  sessionId: string;
  variables: Record<string, unknown>;
  history: CollaborationEvent[];
  lastUpdated: string;
}

// ─── Subscriptions ───────────────────────────────────────────

export interface RunSubscription {
  id: string;
  sessionId: string;
  subscriberId: string;
  events: string[];
  active: boolean;
}

// ─── Presence ────────────────────────────────────────────────

export type PresenceState = 'online' | 'idle' | 'busy' | 'offline';
