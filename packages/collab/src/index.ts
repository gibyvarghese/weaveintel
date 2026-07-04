// SPDX-License-Identifier: MIT
/**
 * @weaveintel/collab — real-time collaboration + CRDT co-editing (one package).
 *
 * Two layers, one home:
 *   • CO-EDITING (CRDT): a zero-dependency toolkit so a human and an AI agent can edit ONE document
 *     concurrently and always converge — the RGA sequence + the BlockDoc rich-text CRDT, awareness
 *     (live cursors), the AI-as-editing-peer, and the trusted-relay op validators.
 *   • MULTIPLAYER: presence ("who's here"), shared sessions + roles, durable run subscriptions,
 *     comments/annotations, unified handoff, message feedback, and suggested prompts.
 *
 * Each capability is a PORT (interface) + an in-memory reference adapter with a shared contract test;
 * a consuming application supplies the SQL adapter. (Formerly the separate @weaveintel/coedit +
 * @weaveintel/collaboration packages.)
 */

export {
  RgaDoc,
  idGreater,
  idEqual,
  idKey,
  opIdOf,
  type RgaId,
  type RgaOp,
  type StateVector,
  type RgaSnapshot,
} from './rga.js';

export {
  Awareness,
  cursorFromIndex,
  indexFromCursor,
  type RelativePosition,
  type AwarenessState,
  type AwarenessEntry,
  type AwarenessOptions,
} from './awareness.js';

// Live-presence helpers: stable per-peer cursor colours, the
// synthetic AI participant identity, and a strict sanitiser for incoming awareness.
export {
  CURSOR_COLORS,
  peerColor,
  AI_PARTICIPANT,
  aiPeerId,
  isAiPeerId,
  aiAwarenessState,
  sanitizeAwarenessState,
} from './presence-helpers.js';

export {
  createAgentPeer,
  agentSiteId,
  isAgentSite,
  AGENT_SITE_PREFIX,
  type AgentPeer,
  type AgentPeerOptions,
} from './agent-peer.js';

export {
  validateClientOps,
  siteOwnedBy,
  type OpValidationOptions,
  type OpValidationResult,
} from './validation.js';

// The BLOCK-document CRDT (rich text / notes) on top of the
// same RGA. A flat sequence of char|block-marker elements + LWW block attrs +
// Peritext-lite marks; converges identically. Plus ProseMirror ⇄ blocks
// conversion + schema repair, Markdown/HTML serializers, and the agent block-peer.
export {
  BlockDoc,
  blockOpId,
  type BlockType,
  type BlockAttrs,
  type MarkType,
  type RenderedBlock,
  type BlockOp,
  type BlockSpec,
  type BlockDocSnapshot,
  type StateVector as BlockStateVector,
} from './block-doc.js';
export {
  pmToBlocks,
  blocksToProseMirror,
  normalizeBlocks,
  type NormalBlock,
} from './prosemirror.js';
export {
  blocksToMarkdown,
  blocksToHtml,
  safeCssColor,
} from './block-markdown.js';

export {
  markdownToBlocks,
  appendBlocksToDoc,
  createBlockAgentPeer,
  type BlockAgentPeer,
  type BlockAgentPeerOptions,
} from './block-agent.js';

// The TRUSTED-RELAY block-op validator (anti-forgery + caps
// for BlockOps) and `diffBlocks` (turn a whole edited document into convergent
// block ops for the "diff-on-save" client path). These power a consuming app's notes
// co-editing relay + collaborative editor.
export {
  validateClientBlockOps,
  type BlockOpValidationOptions,
  type BlockOpValidationResult,
} from './block-validation.js';
export { diffBlocks } from './block-diff.js';

// ─────────────────────────── MULTIPLAYER ───────────────────────────
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
// adapter (a consuming application provides the SQL adapter over `run_presence`). Both pass
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
// reference adapter; a consuming application provides the SQL adapter over `shared_sessions` +
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
// if I close the tab"). The PORT + in-memory reference adapter; a consuming application
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
// in-memory reference adapters; a consuming application provides SQL adapters over
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
// audited lifecycle PORT + in-memory reference adapter; a consuming application provides the
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
