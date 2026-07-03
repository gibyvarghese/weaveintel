// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — Public API (weaveNotes Phase 0).
 *
 * The seam in front of note storage: the {@link NoteRepository} PORT + an
 * in-memory reference adapter, the shared {@link noteRepositoryContract}, and pure
 * content-extraction helpers. geneWeave provides the SQL adapter; later phases add
 * a CRDT co-editing adapter behind the SAME port. See
 * `NOTES_CRDT_AND_ARTIFACTS_ROADMAP_2026.md` for the full roadmap.
 */
export {
  type DiagramVerdict,
  type ImageVerdict,
  DIAGRAM_WEIGHTS,
  DEFAULT_DIAGRAM_THRESHOLD,
  DEFAULT_MAX_VERIFY_RETRIES,
  VERIFY_EARLY_STOP_DELTA,
  DEFAULT_IMAGE_MIN_CONFIDENCE,
  buildDiagramJudge,
  parseDiagramVerdict,
  diagramRegenFeedback,
  diagramAccept,
  buildImageVerify,
  parseImageVerdict,
  imageAccept,
} from './visual-verify.js';
export {
  type NoteSensitivity,
  type NoteLinkTargetKind,
  type NoteDatabaseSource,
  type NoteDatabaseViewType,
  type Note,
  type NoteLink,
  type NoteDatabase,
  type NoteDbRow,
  type NoteListFilter,
  type CreateNoteInput,
  type UpdateNotePatch,
  type CreateNoteLinkInput,
  type CreateNoteDatabaseInput,
  type CreateNoteDbRowInput,
  type NoteRepository,
  type InMemoryNoteRepositoryOptions,
  createInMemoryNoteRepository,
} from './note-repository.js';

export {
  type ContractTestApi,
  noteRepositoryContract,
} from './note-repository-contract.js';

export {
  extractTaskItems,
  extractPlainText,
} from './extract.js';

// weaveNotes Phase 5 — knowledge graph: wiki-link parsing + unlinked-mention detection.
export {
  type WikiLink,
  type UnlinkedMention,
  type FindUnlinkedOptions,
  type LinkSuggestion,
  parseWikiLinks,
  findUnlinkedMentions,
  titleKey,
  buildLinkSuggestions,
  linkifyFirstMention,
} from './wiki-links.js';

// weaveNotes Phase 3 — GraphRAG quality: entity resolution/disambiguation + batching.
export {
  type EntityMention,
  type CanonicalEntity,
  canonicalizeEntityName,
  resolveEntities,
  chunk,
} from './entities.js';

// weaveNotes Phase 5 — background memory ("second brain"): distil durable memories from notes.
export {
  type NoteMemoryKind,
  type NoteMemory,
  buildMemoryExtractionPrompt,
  parseMemoryExtraction,
  memoryKey,
  dedupeAgainstExisting,
  formatRecall,
  relativeWhen,
} from './note-memory.js';

// weaveNotes Phase 4 — meeting / voice capture: transcript → structured note + anchored citations.
export {
  type TranscriptSegment,
  type TranscriptCitation,
  type MeetingActionItem,
  type MeetingHighlight,
  type MeetingStructured,
  formatTimestamp,
  formatTranscript,
  transcriptDuration,
  locateInTranscript,
  buildMeetingPrompt,
  parseMeetingReply,
  verifyMeetingCitations,
  citationCoverage,
  buildMeetingNoteMarkdown,
} from './meeting.js';

// weaveNotes Phase 6 — typed database properties, validation + rollups.
export {
  type PropertyType,
  type RollupFn,
  type PropertyDef,
  type DatabaseViewType,
  VIEW_TYPES,
  isViewType,
  parseSchema,
  coerceValue,
  validateRow,
  computeRollup,
} from './note-database.js';

// weaveNotes Phase 7 — capture helpers (email parsing + provenance note assembly).
export {
  type CaptureSource,
  type EmailFields,
  type ParsedEmail,
  parseEmail,
  buildCaptureNote,
  dailyNoteTitle,
} from './capture.js';

// weaveNotes Phase 8 — workspace RAG helpers (snippets, rank fusion, cited context).
export {
  type RagHit,
  type CitedSource,
  snippetAround,
  reciprocalRankFusion,
  buildCitedContext,
  parseCitedIds,
  type CitableSource,
  type RawCitation,
  type Citation,
  locateQuote,
  buildCitedAnswerPrompt,
  parseCitedAnswer,
  verifyCitations,
  type AnswerCitationCoverage,
  answerCitationCoverage,
  enforceCitationStrictness,
  type ExpandedQueries,
  MAX_QUERY_VARIANTS,
  buildQueryExpansionPrompt,
  parseExpandedQueries,
} from './rag.js';

// weaveNotes Phase 0 — foundation: the "colour encodes agency" contract.
export {
  type Author,
  type AgencyStyle,
  AGENCY_PALETTE,
  authorStyle,
  AI_BYLINE_PREFIX,
  aiByline,
  isAiSignalColor,
  aiContentPalette,
} from './agency.js';

// weaveNotes Phase 0 — the AI-suggestion (tracked-changes) state machine.
export {
  type SuggestionKind,
  type SuggestionState,
  type Suggestion,
  type SuggestionMap,
  emptySuggestions,
  addSuggestion,
  resolveSuggestion,
  acceptSuggestion,
  rejectSuggestion,
  resolveAll,
  clearResolved,
  pendingCount,
  pendingQueue,
  decisionTag,
} from './suggestions.js';

// weaveNotes Phase 0 — the weaveNotes capability configuration (DB-backed, Builder-editable).
export {
  type NotesTheme,
  type WeaveNotesConfig,
  WEAVENOTES_AI_TOOLS,
  DEFAULT_WEAVENOTES_CONFIG,
  validateWeaveNotesConfig,
} from './notes-config.js';

// weaveNotes Phase 0 — the note content-node registry (shared editor schema).
export {
  type NoteNodeType,
  type NoteMarkType,
  type NoteNodeSpec,
  NOTE_NODE_REGISTRY,
  noteNodeSpec,
  aiCreatableNodes,
  editableNodes,
} from './note-nodes.js';

// weaveNotes Phase 1 — the creative layer: page themes, highlighter swatches, callout
// tones, sticker presets, and the shared `sanitizeColor` colour gate.
export {
  type PageTheme,
  type HighlighterTreatment,
  type PageThemeTokens,
  type Swatch,
  type CalloutTone,
  type CalloutToneSpec,
  PAGE_THEMES,
  PAGE_THEME_TOKENS,
  pageThemeTokens,
  coercePageTheme,
  HIGHLIGHTER_SWATCHES,
  DEFAULT_HIGHLIGHT,
  CALLOUT_TONES,
  coerceCalloutTone,
  STICKER_PRESETS,
  sanitizeColor,
  isKnownSwatch,
} from './creative.js';

// weaveNotes Phase 2 — the AI colour-coding contract: a pre-validated WCAG-AA palette,
// the semantic colour schemes (topic/importance/status/sentiment), and phrase location.
export {
  type ColorScheme,
  type SchemeBucket,
  READING_INK,
  HIGHLIGHT_PALETTE,
  TEXT_COLOR_PALETTE,
  COLOR_SCHEMES,
  isColorScheme,
  schemeLabels,
  schemeColor,
  assignTopicColors,
  locatePhrase,
} from './colorize.js';

// weaveNotes Phase 4 — the creative INK model + renderer (freehand strokes → SVG).
export {
  type InkPoint,
  type InkTool,
  type InkStroke,
  type InkPrimitive,
  strokeToPath,
  strokesToSvg,
  strokesBounds,
  validateStrokes,
  inkFromPrimitives,
  recolorStrokes,
} from './ink.js';

// weaveNotes Phase 4 — the native DIAGRAM model + renderer (nodes/edges → laid-out SVG).
export {
  type DiagramKind,
  type NodeShape,
  type DiagramNode,
  type DiagramEdge,
  type DiagramScene,
  type PlacedNode,
  type DiagramLayout,
  type DiagramStyle,
  validateDiagramScene,
  layoutDiagram,
  diagramToSvg,
} from './diagram.js';

// weaveNotes Phase 4 (creative expansion) — the SVG ILLUSTRATION sanitiser (AI-authored vector art).
export {
  sanitizeSvg,
  svgToDataUri,
  svgToSafeDataUri,
} from './svg.js';

// weaveNotes Phase 8 — the SHARED desktop quick-capture + offline-session model.
export {
  type QuickCapture,
  type RecentNote,
  type SnapshotNote,
  type NotesSnapshot,
  DEFAULT_RECENTS_LIMIT,
  SNAPSHOT_VERSION,
  parseQuickCapture,
  pushRecent,
  resolveLastNote,
  buildNotesSnapshot,
  readNotesSnapshot,
  snapshotNote,
} from './desktop.js';

// weaveNotes Phase 7 — the SHARED cross-platform note-document model (mobile ⇆ web doc_json).
export {
  type ParagraphBlock,
  type HeadingBlock,
  type BulletBlock,
  type TodoBlock,
  type InkBlock,
  type UnsupportedBlock,
  type NoteBlock,
  MOBILE_EDITABLE_BLOCKS,
  inkCanvasNode,
  blocksToDoc,
  docToBlocks,
  blocksPlainText,
  hasInk,
  emptyNoteDoc,
} from './note-doc.js';

// weaveNotes Phase 6 — the SYSTEM TEMPLATES (ready-made notes as shared doc_json data).
export {
  type PMNode,
  type PMDoc,
  type TemplateCategory,
  type NoteTemplate,
  SYSTEM_TEMPLATES,
  TEMPLATE_NODE_TYPES,
  templateByKey,
  templateCategories,
  listSystemTemplates,
} from './templates.js';

// weaveNotes Phase 5 — STUDY: flashcards + the SM-2 spaced-repetition scheduler.
export {
  type ReviewRating,
  type CardSchedule,
  type Flashcard,
  type StudyStats,
  type FsrsGrade,
  type FsrsOptions,
  MIN_EASE,
  INITIAL_EASE,
  ratingToQuality,
  initialSchedule,
  sm2,
  ratingToGrade,
  fsrs,
  fsrsInterval,
  fsrsPreview,
  retrievability,
  FSRS_DEFAULT_WEIGHTS,
  FSRS_DEFAULT_RETENTION,
  isDue,
  dueCards,
  studyStats,
  validateFlashcards,
} from './study.js';

// SCHEDULED WORKSPACE AGENTS (Phase 3): recurring multi-step note tasks, budget-bounded + HITL.
export type { ScheduleRecipe, ScheduleTriggerType, ScheduleScope, ScheduledAgentConfig, RecipeInfo, RunBudget } from './scheduled-agent.js';
export {
  SCHEDULE_RECIPES,
  RECIPE_CATALOG,
  recipeInfo,
  DEFAULT_SCHEDULED_AGENT,
  validateScheduledAgent,
  newRunBudget,
  chargeBudget,
  budgetExhausted,
  budgetRemaining,
  isValidCron,
  isValidTimezone,
  cronMatches,
  cronNextRun,
} from './scheduled-agent.js';

// IMAGE PROVENANCE (Phase 2): licence + AI-lineage credentials embedded with image assets.
export type { ImageSourceKind, ImageProvenance } from './provenance.js';
export {
  buildImageProvenance,
  provenanceCreditLine,
  provenanceToXmp,
  embedXmpInSvg,
  parseProvenanceFromSvg,
} from './provenance.js';

// GOVERNANCE model (Phase 2): per-tenant enterprise posture (residency/BYOK/no-training/SSO/retention).
export type { ResidencyRegion, SsoProtocol, TenantGovernance, PostureItem, PostureContext } from './governance.js';
export {
  RESIDENCY_REGIONS,
  SSO_PROTOCOLS,
  DEFAULT_TENANT_GOVERNANCE,
  validateTenantGovernance,
  governancePosture,
  governanceScore,
} from './governance.js';

// Free-to-use IMAGE SEARCH (pure helpers; the app does the hardened fetch + storage).
export type { ImageProvider, LicenseId, ImageResult } from './image-search.js';
export {
  DEFAULT_ALLOWED_LICENSES,
  PUBLIC_DOMAIN_LICENSES,
  LICENSE_LABELS,
  requiresAttribution,
  isLicenseAllowed,
  normalizeLicense,
  buildAttribution,
  rankImageResults,
  LANGUAGE_NAMES,
  normalizeLanguage,
  languageName,
  detectTitleLanguage,
  titleLanguageMismatch,
  applyLanguagePreference,
  buildOpenverseUrl,
  buildWikimediaUrl,
  buildUnsplashUrl,
  buildPexelsUrl,
  buildPixabayUrl,
  parseOpenverse,
  parseWikimedia,
  parseUnsplash,
  parsePexels,
  parsePixabay,
} from './image-search.js';
