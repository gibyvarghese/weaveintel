// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collaboration — Public API
 *
 * MULTIPLAYER collaboration primitives only. In Collaboration Phase 0 the
 * run-lifecycle substrate (run registry, run journal) was relocated to
 * `@weaveintel/core` (where `RunHandle`/`RunEventEnvelope` already live), and the
 * dead `events.ts` helpers + dormant `durable.ts` KV variants were removed. This
 * package is now scoped to its single, non-duplicative reason to exist:
 * **shared sessions, presence, run subscriptions, and user handoff** — the
 * mid-2026 "multiplayer for AI" layer (Phases 1–5 build the durable, DB-backed
 * versions on top of these in-memory prototypes).
 *
 * For run registry / run journal, import from `@weaveintel/core`:
 *   `createKvRunRegistry`, `createKvRunJournal`, `RunRegistry`, `RunJournal`.
 */
export {
  type SessionParticipant,
  type PresenceState,
  type SharedSession,
  type SessionUpdate,
  type SharedSessionManager,
  createSharedSessionManager,
} from './session.js';

export {
  type RunStatus,
  // Legacy in-memory prototype (the "live status broadcast" room model). Phase 3
  // supersedes it with the durable SubscriptionManager below; aliased to avoid a
  // name collision with the Phase 3 `RunSubscription`.
  type RunSubscription as LegacyRunSubscription,
  type RunSubscriptionManager,
  createRunSubscriptionManager,
} from './subscription.js';

export {
  type HandoffStatus,
  type HandoffRequest,
  type HandoffManager,
  createHandoffManager,
} from './handoff.js';

// Phase 1 — Presence ("who else is here"): the PORT + in-memory reference
// adapter (geneWeave provides the SQL adapter over `run_presence`). Both pass
// `presenceManagerContract`.
export {
  type PresenceScope,
  type PresenceHeartbeat,
  type PresenceManager,
  type PresenceManagerOptions,
  createInMemoryPresenceManager,
} from './presence.js';
export {
  type ContractTestApi as PresenceContractTestApi,
  type PresenceHarness,
  presenceManagerContract,
} from './presence-contract.js';

// Phase 2 — Shared sessions + roles (multi-user access). The PORT + in-memory
// reference adapter; geneWeave provides the SQL adapter over `shared_sessions` +
// `session_participants`. Both pass `sessionManagerContract`.
export {
  type SessionRole,
  type SharedSession as SharedRunSession,
  type SessionParticipant as SharedSessionParticipant,
  type CreateSessionInput,
  type SessionManager,
  type InMemorySessionManagerOptions,
  createInMemorySessionManager,
  roleAtLeast,
} from './shared-session.js';
export {
  type ContractTestApi as SessionContractTestApi,
  sessionManagerContract,
} from './shared-session-contract.js';

// Phase 3 — Durable run subscriptions ("notify me when this run finishes, even
// if I close the tab"). The PORT + in-memory reference adapter; geneWeave
// provides the SQL adapter over `run_subscriptions`. Both pass
// `subscriptionManagerContract`. Delivery is handled by `@weaveintel/notifications`
// (this only records WHO is interested and over WHICH channels).
export {
  type SubscriptionChannel,
  type RunSubscription,
  type SubscribeInput,
  type SubscriptionManager,
  type InMemorySubscriptionManagerOptions,
  createInMemorySubscriptionManager,
  normalizeChannels,
} from './run-subscription.js';
export {
  subscriptionManagerContract,
} from './run-subscription-contract.js';
