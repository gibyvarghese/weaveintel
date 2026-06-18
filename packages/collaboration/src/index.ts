// SPDX-License-Identifier: MIT
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

// Phase 4 — durable variants backed by `runtime.persistence.kv`.
export {
  type DurableHandoffManager,
  createDurableHandoffManager,
  type DurableSharedSessionManager,
  createDurableSharedSessionManager,
  type DurableRunSubscriptionManager,
  createDurableRunSubscriptionManager,
} from './durable.js';

// W3 — Durable run registry (persists RunHandle, tenant-isolated, lifecycle events).
export {
  createRunRegistry,
  type RunRegistry,
  type RunRegistryOptions,
  type RunListFilter,
} from './run-registry.js';

// W3 — Run event journal (append-only, resumable via RunEventCursor).
export {
  createRunJournal,
  type RunJournal,
  type RunJournalOptions,
} from './run-journal.js';

