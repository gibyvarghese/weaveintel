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

// Phase 4 — Collaborative run timeline: comments + annotations. The PORTS +
// in-memory reference adapters; geneWeave provides SQL adapters over
// `run_comments` / `run_annotations`. Both pass their contracts. Comments anchor
// to a STABLE part id; markdown renders to SAFE html via `renderCommentMarkdown`.
export {
  type CommentAnchor,
  type RunComment,
  type CreateCommentInput,
  type CommentManager,
  type InMemoryCommentManagerOptions,
  createInMemoryCommentManager,
  renderCommentMarkdown,
} from './run-comment.js';
export {
  commentManagerContract,
} from './run-comment-contract.js';
export {
  type AnnotationDataType,
  type AnnotationSource,
  type RunAnnotation,
  type CreateAnnotationInput,
  type EvalExample,
  type AnnotationManager,
  type InMemoryAnnotationManagerOptions,
  createInMemoryAnnotationManager,
  normalizeAnnotationValue,
  summarizeAnnotations,
  annotationsToEvalExamples,
} from './run-annotation.js';
export {
  type FeedbackRating,
  type FeedbackCategory,
  type MessageFeedbackInput,
  type ValidatedMessageFeedback,
  type FeedbackRow,
  type FeedbackSummary,
  FEEDBACK_CATEGORIES,
  ANSWER_RATING_METRIC,
  FEEDBACK_COMMENT_MAX,
  validateMessageFeedback,
  sanitizeFeedbackCategories,
  signalToRating,
  feedbackToAnnotationValue,
  summarizeMessageFeedback,
} from './message-feedback.js';
export {
  type PromptSource,
  type PromptCategory,
  type SuggestedPrompt,
  type RecentNoteSignal,
  type RecentChatSignal,
  type SuggestionInput,
  TITLE_MAX as SUGGESTED_PROMPT_TITLE_MAX,
  PROMPT_MAX as SUGGESTED_PROMPT_MAX,
  CURATED_PROMPTS,
  sanitizePromptText,
  normalizeKey as normalizePromptKey,
  buildNoteCandidates,
  buildChatCandidates,
  dedupePrompts,
  selectSuggestions,
  buildSuggestPromptsPrompt,
  parseSuggestedPromptsReply,
} from './suggested-prompts.js';
export {
  type AnswerVariant,
  type VariantStack,
  DEFAULT_MAX_VARIANTS,
  makeVariantStack,
  addVariant,
  selectVariant,
  activeVariant,
  variantLabel,
} from './answer-variants.js';
export {
  type AnnounceMode,
  type AnnounceInput,
  type AnnounceResult,
  DEFAULT_ANNOUNCE_MIN_INTERVAL_MS,
  GENERATING_MESSAGE,
  STOPPED_MESSAGE,
  computeAppendedText,
  lastSentenceBoundary,
  nextStreamAnnouncement,
} from './stream-announce.js';
export {
  annotationManagerContract,
} from './run-annotation-contract.js';

// Phase 5 — Unified handoff (user↔user, agent↔human, agent↔agent). The durable,
// audited lifecycle PORT + in-memory reference adapter; geneWeave provides the
// SQL adapter over `session_handoffs` + `handoff_events`. Both pass
// `handoffManagerContract`. Supersedes the in-memory `createHandoffManager`
// prototype above (kept for back-compat).
export {
  type HandoffScope,
  type HandoffState,
  type HandoffActor,
  type HandoffBriefing,
  type Handoff,
  type HandoffEvent,
  type RequestHandoffInput,
  type UnifiedHandoffManager,
  type InMemoryHandoffManagerOptions,
  createInMemoryHandoffManager,
  canTransition,
  isTerminalHandoffState,
} from './unified-handoff.js';
export {
  handoffManagerContract,
} from './unified-handoff-contract.js';
