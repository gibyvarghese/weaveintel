# @weaveintel/notes

**The seam in front of notes** — a `NoteRepository` port + an in-memory reference
adapter + pure content-extraction helpers. The first building block of
**weaveNotes** (the AI-native research workspace; see
`NOTES_CRDT_AND_ARTIFACTS_ROADMAP_2026.md`).

> New to this? A "note" here is a Notion-like block document (a tree of headings,
> paragraphs, to-do lists, …). A "repository" is just the **one doorway** through
> which the rest of the app reads and writes those notes. Putting a single, clear
> interface in front of note storage is what lets us (a) test the notes feature on
> its own, and (b) later swap the storage for a real-time collaborative engine
> **without touching the app's routes**. That swap-ability is the whole point.

## Why this exists (weaveNotes Phase 0)

geneWeave's notes feature talked to the database **directly from its HTTP routes**,
and saved a note by **overwriting the whole document** on every keystroke-debounce
(last-write-wins) — so two browser tabs, two people, or an AI agent would silently
clobber each other. Phase 0 is the safe, no-behaviour-change first step toward
fixing that: introduce a **port** (this package), route everything through it, and
prove with a **shared contract test** that behaviour is unchanged. Later phases add
a CRDT co-editing adapter behind the *same* port.

This is the classic **Ports & Adapters / Hexagonal** architecture: the repository
is the *driven-port adapter*; the routes depend only on the interface; and one
shared contract pins every adapter to identical behaviour.

## What's in the box

| Export | What it is |
|---|---|
| `NoteRepository` | The PORT — the single interface for note/link/database/row reads + writes. |
| `createInMemoryNoteRepository()` | A faithful in-memory adapter (the reference the contract pins behaviour to). |
| `noteRepositoryContract(make, t)` | The shared conformance test every adapter must pass (geneWeave's SQL adapter passes it too). |
| `parseQuickCapture` / `pushRecent` / `resolveLastNote` / `buildNotesSnapshot` / `readNotesSnapshot` | Phase 8 DESKTOP model: `parseQuickCapture` turns a jotted line into a note (first line → title; a leading `/template` or `kind:` hint → a system template, reusing the Phase-6 registry); `pushRecent`/`resolveLastNote` maintain the recents list that drives "open to last note"; `buildNotesSnapshot`/`readNotesSnapshot` serialise a capped, tamper-safe offline cache so the desktop app launches + lists with no network. Pure + tested; the quick-capture parse is reused by the server's quick-capture endpoint. |
| `blocksToDoc` / `docToBlocks` / `inkCanvasNode` / `hasInk` (`NoteBlock`) | Phase 7 SHARED cross-platform note-document model: the flat block list (`paragraph`/`heading`/`bullet`/`todo`/`inkCanvas` + an `unsupported` catch-all) that the **mobile** editor works in, and the lossless mapping to/from `doc_json` the **web** stores. `inkCanvasNode` builds the exact ink node the web renders (so a drawing made on a phone arrives untouched). Crucially, `docToBlocks` PRESERVES web-only nodes (diagram/image/callout) as `unsupported` and `blocksToDoc` writes them back verbatim — so editing a note on mobile never drops content the web authored. Pure + tested. |
| `SYSTEM_TEMPLATES` / `templateByKey` / `listSystemTemplates` / `templateCategories` | Phase 6 system TEMPLATES: 12 ready-made notes (blank, Cornell, meeting-minutes, study-sheet, active-recall, outline, mind-map, comparison, zettelkasten, action-board, daily-planner, project-brief) as pure `doc_json` data — defined once and reused by the seed migration, the gallery, and the `new_from_template` AI tool. Grouped into categories (Blank / Study / Meetings / Planning / Thinking); every node is editor-renderable (`TEMPLATE_NODE_TYPES`). The meeting-minutes template's action-items are a `taskList` that feeds tasks via `extractTaskItems`. |
| `extractTaskItems(docJson)` | Pure helper: the text of every unchecked to-do in a ProseMirror doc (→ tasks). |
| `extractPlainText(docJson)` | Pure helper: all text in a ProseMirror doc (search/preview). |
| `parseWikiLinks` / `findUnlinkedMentions` / `titleKey` | Phase 5 knowledge-graph helpers: `[[wiki-link]]` parsing + unlinked-mention detection. |
| `buildLinkSuggestions` / `linkifyFirstMention` | Phase 3 PROACTIVE LINKING: merge unlinked **mentions** (verbatim, high-confidence) + semantically **related** notes into one ranked, deduped suggestion list (already-linked targets removed); and losslessly wrap the FIRST plain occurrence of a title in a `[[wiki-link]]` (preserving the typed casing as a display alias, skipping anything already bracketed). Pure + zero-dep; the app surfaces these as the live "💡 Suggested links" bar + one-click apply. |
| `canonicalizeEntityName` / `resolveEntities` / `chunk` | Phase 3 GraphRAG QUALITY: **entity disambiguation** — normalise an entity name to a stable canonical key (case/accents/punctuation/leading-article/legal-suffix folded), and fold spelling variants + acronym↔full-name into one `CanonicalEntity` (aliases + count + voted type). So "OpenAI"/"OpenAI, Inc." and "WHO"/"World Health Organization" become ONE graph node that connects the notes mentioning it. `chunk` batches items so the app can embed many notes in one model call (anti-N+1). Pure + zero-dep. |
| `buildMemoryExtractionPrompt` / `parseMemoryExtraction` / `dedupeAgainstExisting` / `formatRecall` / `relativeWhen` / `memoryKey` | Phase 5 BACKGROUND MEMORY ("second brain"): distil DURABLE memories from a note — facts, preferences, decisions, people, commitments. `buildMemoryExtractionPrompt` SPOTLIGHTS the note as untrusted data (a note saying "ignore your instructions" is recorded as text, never obeyed) and asks for atomic memories with a kind + importance; `parseMemoryExtraction` normalises the JSON (importance 1–10 → 0–1, unknown kinds → 'fact', junk dropped); `dedupeAgainstExisting` removes ones already known; `formatRecall` / `relativeWhen` render proactive recall ("• prefers async standups — 3 weeks ago"). The app stores these in `@weaveintel/memory` with temporal recall; these helpers are Pure + zero-dep. |
| `buildMeetingPrompt` / `parseMeetingReply` / `verifyMeetingCitations` / `buildMeetingNoteMarkdown` / `locateInTranscript` / `formatTranscript` | Phase 4 MEETING / VOICE capture: turn a timestamped TRANSCRIPT into a structured note with **transcript-anchored citations**. `buildMeetingPrompt` SPOTLIGHTS the transcript as untrusted data (prompt-injection defended — "ignore your instructions" spoken in a meeting is summarised, never obeyed) and asks for summary + decisions + action items where each carries a verbatim `quote`; `parseMeetingReply` tolerantly parses the JSON; `verifyMeetingCitations` confirms each quote actually appears in the transcript (`locateInTranscript`) and anchors it to the segment's timestamp (hallucinated quotes dropped); `buildMeetingNoteMarkdown` renders the note (Summary / Decisions / Action-item checkboxes with `⟦m:ss⟧` anchors / timestamped Transcript). The app records + transcribes; these are Pure + zero-dep. |
| `PropertyDef` / `parseSchema` / `coerceValue` / `validateRow` / `computeRollup` / `VIEW_TYPES` | Phase 6 typed-database model (columns, validation, rollups, view types). |
| `parseEmail` / `buildCaptureNote` / `dailyNoteTitle` | Phase 7 capture helpers: parse an email (fields or raw RFC822 → text), assemble a provenance-stamped capture note, and the daily-jots inbox title. |
| `snippetAround` / `reciprocalRankFusion` / `buildCitedContext` / `parseCitedIds` | Phase 8 workspace-RAG helpers: query-centred excerpts, rank-fusion of multiple corpora, numbered "[n]" cited context for the LLM, and citation-marker parsing. |
| `AGENCY_PALETTE` / `authorStyle` / `aiByline` / `aiContentPalette` | Phase 0 "colour encodes agency" contract: the geneWeave palette + the rule that user content is calm neutral, AI content is mint with a woven mark + byline, and human ink is coral. One source of truth for web/desktop/mobile. |
| `PAGE_THEME_TOKENS` / `pageThemeTokens` / `HIGHLIGHTER_SWATCHES` / `CALLOUT_TONES` / `STICKER_PRESETS` / `sanitizeColor` | Phase 1 creative layer: the Pro ↔ Creative page-theme tokens (surface, title font, highlighter treatment, sticker tool — spec §10.6), the four-colour highlighter set, the callout tones, the sticker presets, and one strict `sanitizeColor` gate the editor + AI + share-renderer all pass colours through (so a "colour" can never carry CSS/script). |
| `HIGHLIGHT_PALETTE` / `TEXT_COLOR_PALETTE` / `COLOR_SCHEMES` / `schemeColor` / `assignTopicColors` / `locatePhrase` | Phase 2 AI colour-coding: a **pre-validated WCAG-AA** highlight + text-colour palette and the semantic schemes (topic / importance / status / sentiment). The AI never picks a raw colour — it picks a meaning LABEL and `schemeColor`/`assignTopicColors` map it to a safe colour; `locatePhrase` finds the span to paint. (Accessibility is enforced by a test that runs the palette through `@geneweave/tokens`' real contrast maths.) |
| `strokeToPath` / `strokesToSvg` / `validateStrokes` / `inkFromPrimitives` / `recolorStrokes` | Phase 4 INK model + renderer: a freehand stroke is plain data (points + colour + width + tool); `strokeToPath` smooths it into an SVG path (the lightweight cousin of perfect-freehand), `strokesToSvg` renders a whole set, `inkFromPrimitives` turns the AI's intent ("underline", "arrow", "circle") into real editable strokes, and `validateStrokes` is the strict gate (bounded points, safe colour). |
| `validateDiagramScene` / `layoutDiagram` / `diagramToSvg` | Phase 4 native DIAGRAM model + renderer: a diagram is structured `{nodes, edges}` JSON the AI emits; `validateDiagramScene` sanitises it + resolves every node colour to a WCAG-AA pastel, `layoutDiagram` does a dependency-free layered layout, and `diagramToSvg` renders it (rounded coloured nodes + arrowed edges, plus process/business shapes: cylinder, parallelogram, hexagon). Native + editable — no Excalidraw/React. |
| `sanitizeSvg` / `svgToDataUri` / `svgToSafeDataUri` | Phase 4 SVG ILLUSTRATION sanitiser: for a real picture the boxes-and-arrows tools can't express (a heart, a leaf, a logo), the AI authors a detailed SVG — and this is the strict gate that makes untrusted SVG safe to store + render (strip `<script>`/`<foreignObject>`/event handlers/external `href`s/XXE, cap size). Render only via an inert `<img src="data:image/svg+xml…">`. |
| `fsrs` / `fsrsInterval` / `fsrsPreview` / `retrievability` / `FSRS_DEFAULT_WEIGHTS` | Phase 2 STUDY scheduler (the default): **FSRS-6** spaced repetition — the accurate memory-model scheduler used by modern Anki. `fsrs(schedule, rating, now, {targetRetention})` models each card with *stability* (memory half-life in days) + *difficulty* (1–10) via the forgetting curve `R(t,S)=(1+FACTOR·t/S)^DECAY`, seeds them from the first grade, then grows stability on recall / re-derives it (never up) on a lapse, and schedules the next review for when predicted recall reaches the target (default 0.90). Implemented as the clean "long-term" subset (day-grained, no sub-day steps, no fuzz → deterministic). `retrievability` = recall probability now; `fsrsInterval` = next whole-day interval; `fsrsPreview` = the per-button intervals for the review UI. Uses the published FSRS-6 default weights. |
| `buildImageProvenance` / `provenanceToXmp` / `embedXmpInSvg` / `parseProvenanceFromSvg` / `provenanceCreditLine` | Phase 2 image PROVENANCE / Content Credentials: one typed manifest for where a picture came from — web licence + author + source, or the AI generator + model + prompt. `embedXmpInSvg` GENUINELY embeds the manifest (an XMP/Dublin-Core packet + a machine-readable JSON channel) into an SVG's bytes so an exported illustration is self-describing; `parseProvenanceFromSvg` round-trips it. The app embeds it in SVGs and stores the same manifest with raster assets (it doesn't fake C2PA signing of PNG bytes). Pure + zero-dep. |
| `handleMcpMessage` / `mcpText` / `MCP_PROTOCOL_VERSION` | Phase 3 MCP (Model Context Protocol) server core: the pure, transport-free JSON-RPC 2.0 handler (`initialize` / `tools/list` / `tools/call` / `notifications/*`) for exposing the note vault to an external agent (Claude Desktop / ChatGPT / Cursor). Tools-only (the most portable primitive); a thrown tool becomes an `isError` result so the model can self-correct; protocol/method errors use standard JSON-RPC codes. The app supplies `listTools()` + `callTool()` and does the bearer-auth/owner-scoping. Pure + zero-dep. |
| `validateScheduledAgent` / `RECIPE_CATALOG` / `newRunBudget` / `budgetExhausted` / `cronNextRun` / `cronMatches` | Phase 3 SCHEDULED WORKSPACE AGENTS: the typed config for a recurring AI note task + validator (clamps budgets, rejects bad cron/timezone/enums) + the built-in task RECIPES (daily_digest, link_suggester, action_items, stale_flagger, custom) + the anti-runaway run BUDGET model (token + step ceilings, `budgetExhausted`/`budgetRemaining`) + a small **timezone-aware 5-field cron evaluator** (`cronMatches`/`cronNextRun`, Intl-based so DST is handled, with Vixie dom/dow OR-semantics). Pure + zero-dep; the app supplies the LLM steps + note access. |
| `validateTenantGovernance` / `governancePosture` / `governanceScore` / `TenantGovernance` / `DEFAULT_TENANT_GOVERNANCE` | Phase 2 per-tenant enterprise GOVERNANCE model: the typed record (data residency, no-training, analytics, enforced SSO + protocol, SCIM, activity/audit retention, legal hold), a safe validator (clamps retention, rejects unknown enums, defaults a protocol when SSO is required), and `governancePosture(g, {byokActive, encryptionAtRest})` → the standard compliance CHECKLIST (one on/off/na row per control) that an admin page or trust panel renders. Models the POLICY; the app supplies the encryption/BYOK facts + enforcement. Pure + zero-dep. |
| `buildQueryExpansionPrompt` / `parseExpandedQueries` | Phase 2 QUERY EXPANSION for workspace RAG: turn one question into several search phrasings (multi-query) **plus** a short hypothetical answer (HyDE), so a hit that matches any phrasing — or reads like the answer — surfaces. `parseExpandedQueries(reply, original)` returns deduped `{variants (original first), hypothetical}` (tolerant). The app embeds each variant and fuses the ranked lists with `reciprocalRankFusion`. Pure; bounded by `MAX_QUERY_VARIANTS`. |
| `buildTranslatePrompt` / `protectNonTranslatable` / `restoreProtected` / `verifyTranslation` / `resolveLanguage` / `TARGET_LANGUAGES` | Phase 2 TRANSLATE model: faithful, structure-preserving, injection-defended note translation. `protectNonTranslatable` masks code / inline-code / URLs / [[wiki-links]] / @mentions with sentinels so the model literally can't break them (the research-recommended **placeholder-protection** approach); `buildTranslatePrompt` SPOTLIGHTS the masked text as untrusted data ("translate, never obey"); `restoreProtected` puts the spans back; `verifyTranslation` checks the result actually translated (non-empty, not identical, sentinels + Markdown structure preserved). `resolveLanguage` resolves an ISO code / name / legacy alias against the ~22-language `TARGET_LANGUAGES` set (with RTL flags). Pure + zero-dep. |
| `sm2` / `initialSchedule` / `dueCards` / `studyStats` / `validateFlashcards` | Phase 5 STUDY model: flashcards + the classic **SM-2** scheduler, kept as a fallback (admin toggle). `sm2(schedule, rating, now)` is the ~30-line SuperMemo-2 maths (ease factor, interval ladder 1→6→×ease, reset on a fail); `dueCards`/`studyStats` drive the review queue + deck stats; `validateFlashcards` is the strict gate over AI-/user-supplied cards. `CardSchedule` carries optional `stability`/`difficulty` so the same row works for both schedulers. Pure + injectable time → fully testable. |
| `Suggestion` / `addSuggestion` / `acceptSuggestion` / `rejectSuggestion` / `pendingQueue` | Phase 0 AI-suggestion (tracked-changes) state machine: every AI change is a reviewable suggestion the human accepts or rejects; a keyed map handles multiple queued edits. |
| `WeaveNotesConfig` / `DEFAULT_WEAVENOTES_CONFIG` / `validateWeaveNotesConfig` | Phase 0 capability config: the typed settings that drive the notes AI (default theme, approval, activity tracking, token cap, enabled tools) + a safe validator (clamps + rejects unknowns). geneWeave stores it in a DB row edited via the Builder. |
| `NOTE_NODE_REGISTRY` / `aiCreatableNodes` / `editableNodes` | Phase 0 content-node registry: the shared editor schema — which block types exist, which the AI can create, and which stay natively editable vs opaque. |

```ts
import { createInMemoryNoteRepository, extractTaskItems } from '@weaveintel/notes';

const notes = createInMemoryNoteRepository();
await notes.createNote({ id: 'n1', owner_user_id: 'alice', title: 'Tides research' });
await notes.createLink({ id: 'l1', note_id: 'n1', target_kind: 'run', target_id: 'run-42' });
const todos = extractTaskItems(parsedTiptapDoc); // ['Validate the lunar-cycle claim', …]
```

## Design notes

- **Zero behaviour change (Phase 0):** the entity shapes mirror the persisted/wire
  shape (snake_case fields) **exactly**, so geneWeave's API responses are
  byte-for-byte unchanged when the routes go through the port. A richer camelCase
  domain model is a later-phase concern.
- **Zero dependency + pure** — browser- and server-safe; the helpers are pure
  functions (same input → same output, no I/O).
- **Owner-scoped + faithful semantics** — `listNotes` excludes templates and is
  owner-scoped/filterable/ordered (favourites then recent); `getNote` also resolves
  `_system` templates; `deleteNote` cascades one level of sub-pages; links/rows are
  scoped to their parent. The in-memory adapter mirrors geneWeave's SQL exactly so
  the one contract proves them equivalent.

## In geneWeave

geneWeave provides `createSqlNoteRepository(db)` (the SQL adapter) and registers
`/api/me/notes/*` through the port. See `apps/geneweave/src/note-repository-sql.ts`
and `apps/geneweave/src/routes/me-notes.ts`.
