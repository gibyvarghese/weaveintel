// @weaveintel/collaboration — Collaboration events & presence

export type CollaborationEventType =
  | 'session:created'
  | 'session:closed'
  | 'participant:joined'
  | 'participant:left'
  | 'presence:changed'
  | 'message:sent'
  | 'cursor:moved'
  | 'handoff:requested'
  | 'handoff:accepted'
  | 'handoff:rejected';

export interface CollaborationEvent {
  readonly type: CollaborationEventType;
  readonly sessionId: string;
  readonly userId: string;
  readonly timestamp: number;
  readonly data: Record<string, unknown>;
}

export function createCollaborationEvent(
  type: CollaborationEventType,
  sessionId: string,
  userId: string,
  data: Record<string, unknown> = {},
): CollaborationEvent {
  return { type, sessionId, userId, timestamp: Date.now(), data };
}

export function isPresenceEvent(event: CollaborationEvent): boolean {
  return event.type === 'presence:changed';
}

export function isHandoffEvent(event: CollaborationEvent): boolean {
  return event.type.startsWith('handoff:');
}
