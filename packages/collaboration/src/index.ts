// @weaveintel/collaboration — Public API
export {
  type SessionParticipant,
  type PresenceState,
  type SharedSession,
  type SessionUpdate,
  type SharedSessionManager,
  createSharedSessionManager,
} from './session.js';

export {
  type CollaborationEventType,
  type CollaborationEvent,
  createCollaborationEvent,
  isPresenceEvent,
  isHandoffEvent,
} from './events.js';

export {
  type RunStatus,
  type RunSubscription,
  type RunSubscriptionManager,
  createRunSubscriptionManager,
} from './subscription.js';

export {
  type HandoffStatus,
  type HandoffRequest,
  type HandoffManager,
  createHandoffManager,
} from './handoff.js';
