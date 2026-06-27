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
| `extractTaskItems(docJson)` | Pure helper: the text of every unchecked to-do in a ProseMirror doc (→ tasks). |
| `extractPlainText(docJson)` | Pure helper: all text in a ProseMirror doc (search/preview). |
| `parseWikiLinks` / `findUnlinkedMentions` / `titleKey` | Phase 5 knowledge-graph helpers: `[[wiki-link]]` parsing + unlinked-mention detection. |
| `PropertyDef` / `parseSchema` / `coerceValue` / `validateRow` / `computeRollup` / `VIEW_TYPES` | Phase 6 typed-database model (columns, validation, rollups, view types). |
| `parseEmail` / `buildCaptureNote` / `dailyNoteTitle` | Phase 7 capture helpers: parse an email (fields or raw RFC822 → text), assemble a provenance-stamped capture note, and the daily-jots inbox title. |
| `snippetAround` / `reciprocalRankFusion` / `buildCitedContext` / `parseCitedIds` | Phase 8 workspace-RAG helpers: query-centred excerpts, rank-fusion of multiple corpora, numbered "[n]" cited context for the LLM, and citation-marker parsing. |
| `AGENCY_PALETTE` / `authorStyle` / `aiByline` / `aiContentPalette` | Phase 0 "colour encodes agency" contract: the geneWeave palette + the rule that user content is calm neutral, AI content is mint with a woven mark + byline, and human ink is coral. One source of truth for web/desktop/mobile. |
| `PAGE_THEME_TOKENS` / `pageThemeTokens` / `HIGHLIGHTER_SWATCHES` / `CALLOUT_TONES` / `STICKER_PRESETS` / `sanitizeColor` | Phase 1 creative layer: the Pro ↔ Creative page-theme tokens (surface, title font, highlighter treatment, sticker tool — spec §10.6), the four-colour highlighter set, the callout tones, the sticker presets, and one strict `sanitizeColor` gate the editor + AI + share-renderer all pass colours through (so a "colour" can never carry CSS/script). |
| `HIGHLIGHT_PALETTE` / `TEXT_COLOR_PALETTE` / `COLOR_SCHEMES` / `schemeColor` / `assignTopicColors` / `locatePhrase` | Phase 2 AI colour-coding: a **pre-validated WCAG-AA** highlight + text-colour palette and the semantic schemes (topic / importance / status / sentiment). The AI never picks a raw colour — it picks a meaning LABEL and `schemeColor`/`assignTopicColors` map it to a safe colour; `locatePhrase` finds the span to paint. (Accessibility is enforced by a test that runs the palette through `@geneweave/tokens`' real contrast maths.) |
| `strokeToPath` / `strokesToSvg` / `validateStrokes` / `inkFromPrimitives` / `recolorStrokes` | Phase 4 INK model + renderer: a freehand stroke is plain data (points + colour + width + tool); `strokeToPath` smooths it into an SVG path (the lightweight cousin of perfect-freehand), `strokesToSvg` renders a whole set, `inkFromPrimitives` turns the AI's intent ("underline", "arrow", "circle") into real editable strokes, and `validateStrokes` is the strict gate (bounded points, safe colour). |
| `validateDiagramScene` / `layoutDiagram` / `diagramToSvg` | Phase 4 native DIAGRAM model + renderer: a diagram is structured `{nodes, edges}` JSON the AI emits; `validateDiagramScene` sanitises it + resolves every node colour to a WCAG-AA pastel, `layoutDiagram` does a dependency-free layered layout, and `diagramToSvg` renders it (rounded coloured nodes + arrowed edges, plus process/business shapes: cylinder, parallelogram, hexagon). Native + editable — no Excalidraw/React. |
| `sanitizeSvg` / `svgToDataUri` / `svgToSafeDataUri` | Phase 4 SVG ILLUSTRATION sanitiser: for a real picture the boxes-and-arrows tools can't express (a heart, a leaf, a logo), the AI authors a detailed SVG — and this is the strict gate that makes untrusted SVG safe to store + render (strip `<script>`/`<foreignObject>`/event handlers/external `href`s/XXE, cap size). Render only via an inert `<img src="data:image/svg+xml…">`. |
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
