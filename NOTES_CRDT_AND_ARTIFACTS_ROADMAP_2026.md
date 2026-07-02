# weaveNotes — an AI-native research workspace (CRDT co-editing, voice, ink, agents) — Review & Phased Roadmap (mid-2026)

> **North star.** Turn geneWeave **Notes** into **weaveNotes**: a Notion / SharePoint-Pages-class
> workspace **built for AI agents and humans to co-manage research together** — where
> findings from chat runs, web research, meetings, files, and teammates are captured,
> structured, co-edited, cited, and published from one living document. It must do
> everything a best-in-class mid-2026 notes app does — block editing, real-time
> co-editing, voice capture + transcription, stylus/handwriting on iPad-class devices,
> AI-in-the-document, a workspace-wide RAG corpus with citations, and a great UI — and
> it must be **AI-native, not AI-bolted-on**: the agent is a first-class co-editor and
> the workspace is the agent's memory.
>
> **Scope of this doc.** (1) Review how Notes is implemented today. (2) Inventory the full
> feature set a 2026 AI notes app needs (researched). (3) Architect it as a **CRDT
> document spine** reusing weaveIntel's existing packages. (4) Decide **what is a
> package vs the app**. (5) Lay out a thorough **phased plan** (incl. emit-as-artifact,
> voice, ink, AI-in-doc, RAG, governance) with the **PWA-vs-native-iPad** boundary.

---

## 0. TL;DR / recommendation

- **Today, Notes is 100% app-only** (`apps/geneweave`), **no package**. A note is a
  Tiptap/ProseMirror JSON doc in one `notes.doc_json` column, **overwritten wholesale on
  every 1.5s autosave (last-write-wins)** → two tabs (let alone two users or the agent)
  **silently clobber each other**. No collaboration, no agent co-edit, no presence, no
  versioning, no voice, no ink, no RAG.
- **Yes — implement the reusable core at the package layer.** The CRDT document model,
  ProseMirror⇄blocks conversion, Markdown/HTML serialization, ink-stroke and
  transcript CRDT types, and the RAG/citation glue are app-agnostic, testable primitives
  → **extend `@weaveintel/coedit`** (and lean on `@weaveintel/retrieval`,
  `@weaveintel/memory`, `@weaveintel/voice`, `@weaveintel/graph`, `@weaveintel/artifacts`).
  The note feature, the trusted relay, persistence, UI, and capture connectors stay app-side.
- **The huge unlock: ~80% of an AI notes app is already built in weaveIntel.** We are
  mostly **assembling existing packages** (voice/STT, memory+retrieval RAG with
  field-level citations, knowledge graph, extraction, agents/workflows/triggers,
  artifacts + share/embed, the Phase 7 CRDT + trusted relay + presence + WS control
  channel, the `tools-*` capture connectors, governance) behind a block-editor shell —
  not building from scratch.
- **CRDT path (staged):** build a **home-grown block-document CRDT** on the Phase 7 RGA
  (zero-dep, fits our infra) for Notion-grade block editing + agent co-edit; keep
  **Yjs + y-prosemirror** as an isolated, opt-in **Phase 9 upgrade** for full
  rich-inline-formatting fidelity and 50+ concurrent editors. (mid-2026 research: Yjs is
  the only production Tiptap-collab binding and solves PM-position⇄CRDT mapping for you.)
- **PWA first, thin native iPad app later.** A PWA covers Apple-Pencil capture
  (pressure/tilt, ~120 Hz coalesced + predicted events shipped in Safari 18.2),
  mic-voice + streaming transcription, and all AI/CRDT (server-side). **Native iPad is
  only needed for** PencilKit-grade last-4 ms latency / Scribble, and **desktop/native is
  required for system-audio "ambient meeting" capture** (web `getDisplayMedia` only grabs
  tab audio).
- **The white space we can own:** no 2026 product unifies structured DBs + agents
  (Notion/Coda) **+** backlink/object knowledge-graph (Obsidian/Tana) **+** NotebookLM-grade
  source-grounded citations/provenance **+** Granola-style ambient meeting capture **+**
  GoodNotes-class stylus/ink. weaveIntel already has the parts to unify them.

---

## 1. How Notes is implemented today (evidence-based review)

### 1.1 Where the code lives — **app-only, no package**

| Concern | Location | Layer |
|---|---|---|
| Schema (5 tables) | `apps/geneweave/src/migrations/m46-agenda-notes.ts` | app |
| Row types + adapter interface | `apps/geneweave/src/db-types/adapter-agenda-notes.ts` | app |
| SQL implementation | `apps/geneweave/src/db-sqlite.ts` (`createNote`/`updateNote`/…) | app |
| REST API | `apps/geneweave/src/routes/me-notes.ts` | app |
| Editor (Tiptap) | `apps/geneweave-ui/src/ui/notes-editor.ts`, `notes-view.ts`, `notes-editor-bundle-entry.ts` | app UI |

There is **no `@weaveintel/notes` package**; nothing notes-related in `packages/*`. This is
the opposite of the Collaboration packages (presence/sessions/handoff/coedit) where the
reusable logic is a port + adapters and geneWeave is one host.

### 1.2 Data model (m46)
- `notes(id, owner_user_id, tenant_id, title, icon, cover, parent_note_id, sensitivity,
  doc_json, is_template, template_key, favorite, …)`. **`doc_json` = a full Tiptap/PM JSON
  tree.** Nesting via `parent_note_id`; templates via `is_template`; `sensitivity` ∈
  {normal, confidential, restricted}.
- `note_links(target_kind ∈ {note,run,agenda_item,task}, target_id)` — backlinks/@mentions.
- `note_databases` + `note_db_rows` — saved filtered/sorted views (table/board/calendar).
- Seeded **system templates** (meeting / weekly review / research) owned by `_system`.

### 1.3 Editing/save model — **last-write-wins overwrite (the core problem)**
- Tiptap editor (`@tiptap/starter-kit` + task-list/link/underline/placeholder/menus).
- **Autosave debounced 1.5 s** → `PATCH /api/me/notes/:id` writes the **whole `doc_json`**;
  `updateNote` overwrites it. **No merge, no base check, no op log.** Two tabs clobber.
- A `POST /notes/:id/extract` pipeline walks the doc for unchecked `taskItem`s → linked tasks.

### 1.4 The gap this roadmap closes
No concurrency safety; no agent co-edit; no presence; no offline reconcile / history; not
reusable; no voice; no ink; no in-doc AI; no workspace RAG; no publish-as-artifact.

---

## 2. Product vision — what "AI-native co-management" means

A weaveNotes document is a **shared context window** that humans and agents both read and
write. Concretely:

- **Agents are first-class co-editors,** not a chat box bolted on. An agent joins a note
  as a **CRDT peer** (Phase 7 pattern), draws on the **workspace RAG corpus** as memory,
  drafts **structured** content (headings, tables, to-dos — not just prose), cites its
  sources inline, and can run **scheduled / triggered** (a "research agent" that keeps a
  note current). It edits in **suggestion/track-changes** mode for big changes.
- **The workspace is the agent's memory.** Every note, run transcript, meeting, and file is
  chunked, embedded, and retrievable (hybrid vector + keyword) with **field-level
  citations** — so "summarize what we learned about X across all my research" works, and
  every claim links back to its source block.
- **Capture is ambient.** Findings flow in from chat runs (emit-to-note), web research, the
  web clipper, email, calendar, and **meeting recordings** (record → transcribe → AI turns
  the transcript into structured notes, Granola-style).
- **Input is universal.** Type, slash-command, dictate, or **handwrite with a stylus** on a
  tablet; handwriting and ink coexist with text and merge under the same CRDT.
- **Everything is publishable.** A note becomes an **artifact** (Markdown/HTML) with the
  existing **export / share / embed / public-link** machinery, redacted by `sensitivity`.

---

## 3. Complete feature inventory (researched) → priority + weaveIntel mapping

Legend: **P** = target phase (§9). **Pkg** = primary weaveIntel package(s) reused/extended.

### 3.1 Document model & editing
| Feature | P | Pkg |
|---|---|---|
| Block-based editing; drag-handle reorder; nesting/indent | 1 | coedit (BlockDoc) |
| Block types: heading, list, toggle, callout, code, quote, **table**, columns, divider, **embed**, **synced block**, **AI block** | 1–3 | coedit + app NodeViews |
| Slash commands (`/` insert block / database / AI) | 1 | app UI |
| Markdown shortcuts + paste-as-markdown | 1 | coedit/markdown |
| Rich inline: @mentions, dates, **equations/LaTeX**, **mermaid** | 2 | app UI |
| Wiki-links `[[…]]` + **backlinks / unlinked references** | 5 | graph + app |
| **Synced blocks / transclusion** (edit-once-update-everywhere) | 8 | coedit (shared block id) |
| Templates (system + user) | 1 | app (exists) |

### 3.2 Knowledge management
| Feature | P | Pkg |
|---|---|---|
| Bidirectional links + graph view | 5 | graph |
| Tags / typed properties / "supertags" (typed objects beneath prose) | 6 | graph + app |
| Databases with views: table / board / calendar / timeline / gallery | 6 | app (extend note_databases) |
| Relations & rollups; formulas | 6 | app |
| **Full-text + semantic search** across the workspace | 4 | retrieval + memory |
| Daily notes / quick capture inbox | 7 | app |
| **Version history / time-travel / restore** | 8 | coedit op log |

### 3.3 AI features (the differentiator)
| Feature | P | Pkg |
|---|---|---|
| **Ask-AI-in-doc / chat with this note** | 2 | models + routing + prompts |
| Inline **autocomplete / continue-writing**; rewrite / summarize / translate (selection actions) | 2 | models + prompts |
| **AI blocks** (live, auto-refreshing generated content — table/summary that re-runs) | 3 | app NodeView + artifacts refreshFn pattern |
| **Agentic research → structured doc** (`/research X` drafts sections + a table, cited) | 3 | agents + workflows + retrieval |
| **Chat with your workspace** (RAG over all notes/runs/files) | 4 | retrieval + memory |
| Auto-tagging / **auto-linking** (semantic backlinks) | 5 | memory (fusedMemorySearch) + graph |
| **Meeting-notes AI** (transcript → structured notes) | 11 | voice + models |
| **Citations / source grounding / provenance** (field-level, click-to-source) | 4 | retrieval (citations) + memory (provenance) |
| AI table auto-fill (fill DB properties from page + workspace + web) | 6 | agents + tools-search |
| Per-task **multi-model** selection; cost governance | all | routing + models + cost-governor |
| Knowledge-graph extraction (entities/relations from notes) | 5 | extraction + graph |

### 3.4 Capture & input
| Feature | P | Pkg |
|---|---|---|
| **Emit a chat run / research into a note** (the core AI→note flow) | 3 | app (run→BlockDoc) |
| Web clipper (browser extension → clean note) | 7 | tools-browser |
| Email-to-notes (forward → inbox) | 7 | tools-gmail/imap |
| Quick capture / daily jots | 7 | app |
| **Voice memo + streaming transcription** (dictate into a note) | 10 | voice |
| **Meeting recording + transcription + diarization + AI summary** | 11 | voice (+ native/desktop) |
| Calendar/file context (gcal, gdrive, onedrive, slack) | 7 | tools-gcal/gdrive/onedrive/slack |
| Photo/scan/**OCR**, PDF annotation | 12 | extraction + app |

### 3.5 Stylus / handwriting / tablet
| Feature | P | Pkg |
|---|---|---|
| **Apple Pencil / stylus ink block** (pressure/tilt, low-latency) | 12 | coedit (InkDoc) + app canvas |
| Handwriting recognition (ink→text) | 12 | app (HWR API / MyScript server / native PencilKit) |
| Infinite-canvas / whiteboard (tldraw/Excalidraw) + sketch blocks | 13 | app (embed) + coedit |
| Mixed ink + text, collaborative ink merge | 12 | coedit (stroke sequence CRDT) |

### 3.6 Collaboration
| Feature | P | Pkg |
|---|---|---|
| Real-time co-editing + presence/cursors | 1–2 | coedit + Phase 1/6 transport |
| Comments / threads on blocks | 8 | collaboration (Phase 4 comments — adapt to notes) |
| **Suggestions / track-changes** (esp. for AI edits) | 3 | app (suggest layer) |
| Sharing / permissions (note + workspace level), guest, public publish | 2,8 | collaboration (Phase 2 sessions/tokens) |

### 3.7 Organization & UX
Sidebar/workspaces, favorites, breadcrumbs, **command palette**, dark mode/theming,
mobile/tablet/desktop/web parity, offline (local-first), keyboard-driven. **P:** 1, 14.
**Pkg:** react-client + ui-primitives + app.

### 3.8 Integrations & platform
API/webhooks (exists), embeds, export (md/pdf/html/docx via artifacts), **automations /
triggers** (a note kept fresh by a scheduled agent), MCP. **P:** 7, 14. **Pkg:**
triggers + workflows + mcp-server + artifacts.

---

## 4. Architecture — the "one CRDT doc per note" spine

Everything hangs off **one collaborative document per note**, the Phase 7 trusted-relay
model generalized to rich blocks:

```
weaveNotes document (per note)
├── BlockDoc                      ← block-sequence CRDT (RGA over block ids) + per-block RGA text
│     ├── text / heading / list / todo / quote / code / callout blocks
│     ├── table block             ← rows/cells = nested CRDT maps
│     ├── ink block               ← InkDoc: append-only stroke-sequence CRDT (per-stroke ids)
│     ├── audio/transcript block  ← segments[{speaker,startMs,words[]}] + audioRef
│     ├── embed / synced block    ← references another block id (transclusion)
│     └── AI block                ← prompt + refreshFn + cached cited output
├── Awareness                     ← presence + coloured cursors (relative positions)  [Phase 7]
├── Op log + state vector         ← offline reconcile + version history               [Phase 7]
└── Peers: humans (u:<userId>:<device>) + agent (agent:<noteId>)                       [Phase 7]
```

- **Transport:** SSE ephemeral broadcast (`note.coedit.op`) + the Phase 6 **WS control
  channel** for cancel/steer/awareness; resumable via `Last-Event-ID`. (All shipped.)
- **Trusted relay:** the server holds the canonical `BlockDoc`, validates every op
  (anti-forgery namespace + size/flood caps — Phase 7 `validateClientOps`), persists,
  appends to the op log, and fans out. (Shipped pattern.)
- **The agent is a peer** (Phase 7 `createAgentPeer`) that emits **block-level ops** and
  reads the **workspace RAG corpus** as memory.
- **Materialized cache:** keep `notes.doc_json` as a read cache (ProseMirror JSON) updated
  on every applied op, so existing read paths and the editor keep working during migration.

### Package vs app placement (comprehensive)

**Package — extend `@weaveintel/coedit` (new modules):**
- `block-doc.ts` — `BlockDoc` CRDT (block-sequence + per-block `RgaDoc` + LWW attrs + ops:
  insertBlockAfter / **splitBlock** / mergeBlock / moveBlock / setBlockAttr; mark spans).
- `prosemirror.ts` — `pmToBlocks` / `blocksToPm` + deterministic **`normalize()` schema repair**.
- `markdown.ts` — `blocksToMarkdown` / `blocksToHtml` (+ `pmToMarkdown` legacy shim).
- `ink.ts` — `InkDoc` (append-only stroke-sequence CRDT; stroke = `{id, points[], pressure, tool}`).
- `transcript.ts` — transcript-segment types + merge helpers (segments are LWW-by-id).
- Contracts + fuzz convergence tests (mirror Phase 7).

**Reused packages (already exist):** `coedit` (RGA/awareness/agent-peer/validation),
`core` (SSE writer/parser, JSON Patch, ids), `retrieval` (chunker, **hybrid retriever**,
**citation extractor**, query rewriter), `memory` (pgvector/mongo, `fusedMemorySearch`,
**provenance**, dedup, corrections, retention, consolidation), `graph` (knowledge graph),
`extraction` (entities/tables/tasks), `voice` (STT pipeline + WS handler), `artifacts`
(emit + sqlite/fs backends), `collaboration` (Phase 2 sessions/tokens, Phase 4 comments),
`notifications` (@mention/share), `agents`/`workflows`/`triggers`/`skills`/`recipes`
(agentic), `routing`/`models`/`prompts`/`provider-*` (LLM), `cost-governor`/`guardrails`/
`redaction`/`scope`/`tenancy`/`identity`/`oauth`/`encryption`/`compliance` (governance),
`tools-browser`/`tools-gmail`/`tools-gcal`/`tools-gdrive`/`tools-onedrive`/`tools-slack`/
`tools-search` (capture), `react-client`/`ui-primitives` (UI), `mcp-server`/`mcp-client`.

**App — geneWeave (+ geneweave-ui, + a future native iPad shell):**
- `m100`: `note_docs` (BlockDoc snapshot + state vector) + `note_doc_ops` (op log); reuse/
  extend `notes`, `note_links`, `note_databases`. New: `note_shares` (or reuse Phase 2),
  `note_ink_assets`, `note_audio_assets`, `note_chunks` (RAG index) / reuse memory store.
- `note-coedit-sql.ts` trusted relay; `/api/me/notes/:id/coedit/*` endpoints.
- AI-in-doc endpoints (ask/continue/rewrite/summarize, AI-block refresh, `/research`).
- Workspace RAG endpoints (index a note on save; `/api/me/notes/search`; chat-with-workspace).
- Capture endpoints (emit run→note, clipper ingest, email ingest, voice/transcript ingest,
  meeting ingest).
- Emit-as-artifact endpoint (Markdown/HTML → `createArtifact`).
- UI: op-based Tiptap binding + NodeViews (ink/audio/AI/table/synced) + presence cursors +
  command palette + AI sidebar + capture surfaces + share/publish.

---

## 5. CRDT design (block-document) — recap + ink/voice

### 5.1 Block-document model (Option A, the default; mid-2026 BlockNote/Automerge shape)
```
BlockDoc = { order: SequenceCRDT<BlockId>, blocks: Map<BlockId, Block> }
Block    = { id, type, attrs: LWWMap, text: RgaDoc, marks: MarkSpan[] }
```
- **Convergence** reuses the Phase 7 RGA descending-id rule. **`splitBlock` is first-class**
  (allocate a new id, move tail chars **by id** — never string-concat) so a concurrent
  in-block insert at the split can't interleave the halves (Automerge's fix for the RGA
  interleaving weakness). If interleaving quality later matters, swap the order CRDT's
  tie-break to **Fugue** (a small delta on RGA) without touching the rest.
- **Schema repair:** `blocksToPm()` runs a deterministic `normalize()` (clamp cardinalities,
  wrap stray inline, coerce illegal nesting) so the editor never sees an invalid PM doc;
  **unknown block/mark types pass through verbatim** (no content loss on version skew).
- **Marks (bold/italic/link):** Peritext-lite spans `{startCharId, endCharId, type,
  expandLeft/Right}` anchored to text char-ids, so "bold a range" + "type inside it" commute.

### 5.2 Ink as a CRDT (Option A extends cleanly)
- `InkDoc` = an **append-only stroke sequence** (RGA over stroke ids); each stroke
  `{id:(counter,siteId), points:[[x,y,pressure,tiltX,tiltY,t]], color, width, tool}`.
  Concurrent appends are conflict-free; stroke edit/erase is LWW on the stroke object.
- Stored as a `BlockDoc` `inkCanvas` block whose attr points at the `InkDoc` (do **not**
  inline thousands of points in PM attrs). Rendered with **perfect-freehand**.

### 5.3 Voice/transcript as data (mostly LWW, not heavy CRDT)
- An `audioTranscript` block: `{audioRef, durationMs, segments:[{id, speaker, startMs,
  endMs, words:[{text,startMs,endMs}]}]}`. Segments are immutable-once-final (LWW by id);
  human edits to the rendered text become normal block-text ops. Click-a-word → seek audio.

### 5.4 Option B (Phase 9, frontier): Yjs + `y-prosemirror`
The only production Tiptap-collab binding; solves PM-offset⇄Yjs relative-position mapping,
schema-aware sync, awareness, undo. ~18 KB, no WASM. Adopt **behind the same `/coedit`
endpoints** for full rich-inline fidelity / 50+ editors; keep the home-grown path the
zero-dep default. (Reserve **Loro** — Fugue+Peritext, Rust/WASM, ~3× faster — for large-doc
perf walls.)

---

## 6. AI-in-document (reuse models / routing / agents / retrieval / memory)

- **Ask-AI / continue / rewrite / summarize / translate:** selection + doc context →
  `routing`-selected model via `prompts`; streamed back as **suggestions** (track-changes)
  so the human accepts/rejects. Schema-aware: the model emits **block ops**, not raw
  strings (avoids doc corruption).
- **AI blocks:** a NodeView with a stored prompt + a `refreshFn` (the Artifacts Live-Artifact
  pattern from the client roadmap) that re-runs against current doc + workspace context and
  caches a **cited** result.
- **Agentic `/research X`:** an `agents`+`workflows` flow — decompose → `tools-search` +
  workspace `retrieval` → synthesize a **structured** section (headings + a table) → write
  via block ops as the **agent peer**, every claim carrying a **citation mark** to its
  source block (provenance via `memory`/`retrieval` citations). Can be **scheduled** (a
  `triggers` job keeps the note fresh).
- **Workspace-as-RAG corpus:** on save, `retrieval.weaveChunker` chunks the note → embed →
  store (reuse `memory` pgvector); **hybrid** vector+BM25 retrieval (`weaveHybridRetriever`)
  with `weaveCitationExtractor` for grounded answers. Powers "chat with your workspace",
  **semantic backlinks/auto-linking** (`fusedMemorySearch`), and AI-block context.
- **Knowledge graph:** `extraction` (entities/relations) → `graph` for typed-object backlinks
  and multi-hop retrieval (LightRAG-style local+global).
- **Governance:** `cost-governor` budgets, `guardrails` + `redaction` on AI output,
  `scope`/`tenancy` isolation, provenance + confidence on every AI claim.

---

## 7. Emit notes as artifacts (Phase 4 — standalone, fast win)
- Package `markdown.ts`: `blocksToMarkdown` / `blocksToHtml` (+ `pmToMarkdown` legacy shim).
- App `POST /api/me/notes/:id/emit-artifact {format}` → `createArtifact({type,data,name,
  metadata:{source:'note',noteId,stateVector}})` via `@weaveintel/artifacts` →
  **instantly export / share / embed / public-link** (already shipped:
  `routes/artifacts.ts`, `routes/share.ts`). Respect `sensitivity` (a `restricted` note
  refuses public emission; reuse Phase 4 redaction); link back via a `note_links`
  (`target_kind:'artifact'`) row; re-emit = new artifact version. The agent can publish a
  co-written note via the existing `emit_artifact` tool path.

---

## 8. PWA vs native-iPad boundary (explicit)

| Capability | PWA (ship first) | Needs native iPad / desktop |
|---|---|---|
| Block editing, slash, command palette, dark mode | ✅ | — |
| Real-time co-edit, presence, offline (IndexedDB) | ✅ | — |
| AI-in-doc, agent-as-peer, RAG, citations (server-side) | ✅ | — |
| **Apple Pencil capture** (pressure/tilt, ~120 Hz coalesced + predicted, desync canvas) | ✅ (Safari 18.2+) | — |
| **Handwriting→text** | ✅ Chromium HWR API / server (MyScript) | Native **PencilKit/Scribble** for best on-device |
| Last ~4 ms ink latency, guaranteed ProMotion 120 Hz, Pencil hover | ⚠️ good-enough | ✅ native PencilKit |
| **Mic voice memo + streaming transcription + playback** | ✅ | — |
| **System-audio "ambient meeting" capture** | ❌ (tab-audio only) | ✅ **desktop/Electron** (Core Audio taps / ScreenCaptureKit) |
| Reliable **background** recording | ⚠️ iOS PWA limits | ✅ native |

**Plan:** Ship a high-quality **PWA** for everything except ambient-meeting capture and
PencilKit-grade latency; add a **thin native iPad app** (Track E) and a **desktop capture
helper** (Track D, Phase 11) as enhancements that talk to the same server/CRDT.

---

## 9. Phased plan

> Six tracks (A–F) interleaved into a phase sequence. Each phase is independently shippable,
> tested (positive/negative/stress/security), real-LLM Playwright e2e across modes, and
> committed — same discipline as the Collaboration roadmap. **Phase 4 (artifacts) and
> Phase 10 (voice) can start in parallel** with the foundation.

**Track A — Collaborative foundation**
- **Phase 0 — Notes substrate seam.** ✅ **delivered.** Built **`@weaveintel/notes`** —
  a `NoteRepository` PORT + an in-memory reference adapter + a shared
  `noteRepositoryContract` + pure `extractTaskItems`/`extractPlainText` helpers
  (lifted from the route). geneWeave provides `createSqlNoteRepository(db)` (a thin
  pass-through to the existing SQL, **passing the same contract**) and every
  `/api/me/notes/*` route now depends only on the port (injectable via
  `opts.noteRepository`). The legacy `doc_json` overwrite still works — **zero
  behaviour change** — so the Phase 2 CRDT relay can slot in as a new adapter behind
  the same seam. *Tested:* 25 package + SQL-contract units (round-trip, owner-scoping,
  cascade delete, search, links/databases, extraction positive/negative/stress); 8/8
  **real-LLM Playwright e2e** — a complex research run on **direct/agent/supervisor/
  ensemble** is captured into a note (from the seeded Research template), linked to
  the run, run through the to-do→task **extract** pipeline, plus databases/rows,
  favourites/search, owner-scoped security, the **Notes UI renders an API-created
  note**, and chat-stream regression. *Acceptance: identical behaviour — met.*
- **Phase 1 — `BlockDoc` CRDT (package).** ✅ **delivered.** Built the rich-text/block
  CRDT in **`@weaveintel/coedit`** on the **Automerge-style flat model** (one RGA
  sequence of `char | block-marker` elements, reusing the Phase 7 RGA verbatim — so
  split = insert a marker, merge = delete a marker; no trees, no char-moving). Two
  small LWW layers on top: block **attributes** (type/level/checked/listType, keyed
  by marker id) and inline **marks** (Peritext-lite spans anchored to char ids, so
  add/remove commute and survive concurrent edits). Plus `pmToBlocks` /
  `blocksToProseMirror` (+ deterministic `normalizeBlocks` **schema repair** — clamp
  heading levels, strip divider text, guarantee ≥1 valid block, **unknown
  nodes/marks pass through verbatim**), `blocksToMarkdown` / `blocksToHtml`
  (sanitized), and `createBlockAgentPeer` (the agent contributes its Markdown as
  block ops — Phase 7 agent-as-peer lifted to blocks). geneWeave wires a thin
  surface, **`GET /api/me/notes/:id/blocks?format=blocks|markdown|html`**, that runs
  a real note through the CRDT (via the Phase 0 `NoteRepository`). *Tested:* **18 new
  package units** — fuzz convergence (N replicas × random block+text ops shuffled +
  idempotent), concurrent block-insert + split-at-the-same-point convergence, **PM
  round-trip identity**, **adversarial-merge schema repair**, marks, Markdown/HTML
  serialization (incl. XSS-safe HTML), agent-as-block-peer, sync/snapshot (47/47
  coedit total). **7/7 real-LLM Playwright e2e** — a real research run on **direct/
  agent/supervisor/ensemble** is written as a rich note and round-trips through the
  BlockDoc with every block type, to-do checked-state, and bold/link marks intact,
  plus correct Markdown + sanitized HTML; owner-scoped security; malformed-note
  robustness; Notes-UI regression. *Acceptance: fuzz convergence + PM round-trip
  identity + adversarial-merge schema repair — all met.*
- **Phase 2 — geneWeave relay + co-edit + sharing + presence (app).** ✅ **delivered.**
  geneWeave is now the **trusted relay** for the Phase 1 `BlockDoc`: a note is co-editable
  by two humans (and, in Phase 3, the agent) at once. **`m100`** adds `note_coedit_docs`
  (canonical snapshot) + `note_coedit_ops` (append-only block-op log) + `note_shares`
  (membership) + `note_share_tokens` (256-bit, SHA-256-hashed invite links). **`note-coedit-sql`**
  holds the relay (`ensureDoc` seeds from the note's existing content, `submitOps` validates +
  applies + persists, `opsSince` for offline reconcile, `syncFromProseMirror` for diff-on-save)
  plus `resolveNoteAccess` (owner/collaborator/viewer) and the sharing manager. **`/coedit/*`
  endpoints**: `POST/GET /coedit`, `POST /coedit/ops` (collaborator+; viewers 403), `GET
  /coedit/ops?since=` (state-vector diff sync), `POST /coedit/sync` (diff-on-save), `POST
  /coedit/awareness`, `GET /coedit/events` (per-note **SSE** live broadcast via `NoteCoeditHub`),
  plus `POST /:id/share`, `GET /:id/share`, `POST /:id/share/revoke`, `POST /notes/join`. The
  legacy single-user `PATCH doc_json` is preserved for un-coedited notes and routed through the
  relay as a merge once a note is co-edited. **Package primitives** (reused, not app-specific):
  `validateClientBlockOps` (anti-forgery + caps for block ops) and `diffBlocks` (whole-doc →
  convergent ops). **UI**: the notes editor joins the live room, shows a "N editing" presence
  badge + a collaborator-edit refresh nudge, a **🔗 Share** button (mints a `?joinNote=` link),
  and routes saves through `/coedit/sync`; opening a share link auto-joins. *Tested:* a
  deterministic SQLite **relay integration suite** (9 — convergence, sharing/idempotent-join,
  revoke/expiry/exhaustion, offline reconcile, identity-forgery rejection, diff-on-save, a
  3-editor × 6-round **stress fuzz** that always converges) + **package units** (`validateClientBlockOps`
  positive/negative/security, `diffBlocks` structure + concurrent-no-clobber) + **real-LLM
  Playwright e2e (all four modes)**: two humans co-edit one real-LLM note → **converge, both
  edits survive**; viewer 403; forged site rejected; stranger 404; reload-no-loss + offline
  reconcile; legacy save still works; synced PATCH merges; **presence live over SSE**; and a
  **web-UI** test (Share button mints a link, saves route through the relay). *Acceptance: two
  humans co-edit → converge; reload mid-edit → no loss; offline reconcile; viewer 403; forged
  site rejected — all met.* (Known scope: live concurrent typing uses ops/`diffBlocks` from a
  synced replica; per-keystroke ProseMirror-step → op binding inside the Tiptap island and a
  Redis fan-out for multi-node SSE are documented follow-ups.)

**Track B — AI in the document**
- **Phase 3 — Agent-as-co-editor + AI actions + suggestions.** ✅ **delivered.** The AI
  now works INSIDE the note, two ways. (1) **Track-changes suggestions** (safe default):
  AI actions — *continue / rewrite / summarize / ask* — run the real LLM and STAGE the
  result as a pending suggestion a human **accepts** (ops applied + broadcast) or
  **rejects** (discarded); the AI never silently mutates a document (the defence against a
  prompt-injected agent). (2) **Direct co-editing**: the **`note_edit` agent tool** and
  **AI-block refresh** apply ops immediately through the Phase 2 relay under a distinct
  `agent:*` CRDT site, converging with concurrent human edits. **Package** (`@weaveintel/coedit`):
  `createBlockAgentPeer(doc, { mode: 'suggest' })` computes ops on a private clone (HITL) —
  staged under a unique site so two pending suggestions never collide, yet still apply on
  accept (RGA ops are id-anchored). **App** (`m101` `note_suggestions` + `note-ai-sql.ts`):
  the AI service (`propose`/`accept`/`reject`, `agentEdit` direct|suggest, `insertAiBlock`,
  `refreshAiBlock`) wired to the real model via `createModelTextGenerator(chatEngine.modelConfig)`;
  the `note_edit` tool added to the agent/supervisor/ensemble tool policies + `ToolRegistryOptions.noteEdit`
  (resolves the user's note access itself — no privilege escalation, viewers refused);
  endpoints `POST /ai/:action`, `GET /suggestions`, `POST /suggestions/:sid/accept|reject`,
  `POST /ai/insert-block`, `POST /ai/refresh-block` (all collaborator+, broadcast live over
  the Phase 2 SSE hub). **AI blocks** carry `aiPrompt`+`aiCitation`+`aiRefreshedAt` attrs;
  refresh re-generates the content, preserving the prompt + citation. to-do⇄task extraction
  is preserved (the relay keeps `doc_json` in sync). **UI**: an AI toolbar (Continue /
  Rewrite / Summarize / Ask / ＋AI block) + a suggestion-review panel (Accept / Reject).
  *Tested:* package units (suggest-mode no-mutate + two-suggestion-no-collision); a
  deterministic SQLite **integration suite** (10 — propose/accept/reject, rewrite-a-block,
  double-accept guard, agent-direct convergence with a human, agent-suggest staging, AI
  block insert+refresh preserving prompt, refresh refuses a non-AI block, viewer/stranger
  refused, an 8-suggestion stress); **real-LLM Playwright e2e**: continue→stage→accept,
  summarize→reject (doc untouched), rewrite-a-block, AI block insert+refresh, to-do
  extraction after an AI edit, viewer-403/stranger-404, **the agent co-writes a note via
  `note_edit` during a real run** (asserted strictly in single-agent **agent** mode →
  convergent merge with a human edit; the same path runs in **supervisor**/**ensemble**
  modes asserting the no-clobber safety invariant), and a web-UI test (toolbar →
  suggestion → Accept). *Acceptance: human + agent co-write → convergent merge; suggestion
  accept/reject; cited AI block refreshes — all met.* Honest scope notes: (a) `direct` mode
  has no tools by policy, so the agent can't call `note_edit` there — that path is the
  AI-action endpoints; (b) the multi-agent supervisor/ensemble loops invoke a single
  `note_edit` tool-call far less deterministically with a small model (gpt-4o-mini), so the
  *convergence* is asserted strictly only in agent mode — the mechanism itself is
  mode-independent and proven deterministically in `note-ai-sql.test.ts`; (c) the platform's
  prompt-injection guardrail correctly refuses agent note-edits phrased like "manipulate the
  system with id X", so the agent co-authors via natural, mundane requests.

**Track C — Workspace intelligence**
- **Phase 4 — Emit-as-artifact (package+app).** ✅ **delivered.** A note can now be
  PUBLISHED as a typed, versioned **artifact** (Markdown/HTML) and shared as a public,
  read-only link — reusing the Phase 1 `blocksToMarkdown`/`blocksToHtml` serializers, the
  artifacts store (`db.saveArtifact`), and the existing artifact share-token + public
  viewer (`/share/artifacts/:token`). The NEW Phase-4 piece is the **safety layer**:
  **`@weaveintel/artifacts`** gains `redactText` (a pure, zero-dep DLP scrubber — API
  keys/JWTs/private-keys/bearer tokens always; emails/phones/SSNs/cards for sensitive docs)
  and `publishPolicyForSensitivity` (`restricted` → refused; `confidential` → redact PII +
  secrets; `normal` → scrub secrets as a safety net). **geneWeave** adds `note-publish-sql.ts`
  (render the note → gate on sensitivity → redact → `saveArtifact` → optional share token),
  the **`POST /api/me/notes/:id/emit-artifact`** endpoint (collaborator+; `restricted` 403;
  emits markdown|html; optional `share`/`password`/`expiresInDays`), and a **`note_publish`
  agent tool** (added to the agent/supervisor/ensemble policies + `ToolRegistryOptions.notePublish`
  + chat wiring; resolves access itself, viewers refused) — the agent publishes PRIVATELY
  (it never auto-mints a public link; a human opts in). **UI**: a 📤 Publish button in the
  notes editor → public link (copied to clipboard, with a redaction count). *Tested:*
  **6 package units** (secrets/PII redaction levels, no over-redaction, sensitivity policy)
  + a deterministic SQLite **integration suite (8)** (normal scrubs secrets/keeps PII,
  confidential redacts PII, restricted refused, HTML format, verifiable share token incl.
  wrong-secret + password-hash, agent publishes privately + stranger refused, viewer-vs-
  collaborator) + **real-LLM Playwright e2e**: a real-LLM note → Markdown artifact → **public
  link with the secret REDACTED** (and the real key never on the page), confidential → PII
  redacted on the public link, **restricted → 403**, viewer-403/stranger-404, the **agent
  publishes via `note_publish` across agent/supervisor/ensemble** (asserted strictly in agent
  mode that the agent invokes the tool → publish-or-guardrail-gated; tolerant elsewhere), and
  a **web-UI** Publish-button test. *Acceptance: note→Markdown artifact→public redacted link;
  restricted refused; agent can publish — all met.* Honest scope note: the platform's
  tool-call guardrail intermittently denies the `note_publish` call (defense-in-depth against
  a prompt-injected agent auto-publishing) — the artifact-creation path is proven
  deterministically, and the agent-publishes-privately default means no public link is ever
  auto-created. *(parallelizable)*
- **Phase 5 — Knowledge graph + backlinks + semantic auto-linking.** ✅ **delivered.**
  Notes are now a connected web of meaning (the Obsidian/Tana idea). **Package primitives**:
  `@weaveintel/notes` gains `parseWikiLinks` (`[[Title]]` / `[[Title|alias]]`) +
  `findUnlinkedMentions` (titles mentioned in prose but not yet linked — no substring/short-
  title false positives); `@weaveintel/extraction` gains `extractKnowledgeGraph(text, generate)`
  — LLM-backed entity + relation extraction that is model-AGNOSTIC (takes a `generate` callback)
  and strictly sanitizes the JSON (dedupe, type-clamp, drop malformed triples, connect relation
  endpoints). Reuses `@weaveintel/graph` (entity/edge shapes) + `@weaveintel/cache` cosineSimilarity
  + the m46 `note_links` table (so `[[wiki-links]]` give **backlinks** for free). **geneWeave**:
  `m102` (`note_entities` + `note_relations` + `note_embeddings`); `note-graph-sql.ts` — `indexNote`
  (resolve wiki-links → note links idempotently, extract entities/relations via the LLM, embed the
  note with `text-embedding-3-small`) + reads `backlinks` / `unlinkedMentions` / `relatedNotes`
  (cosine over embeddings) / `graph` (nodes + edges) / `searchNotes`. Endpoints `POST /:id/index`
  (collaborator+) and `GET /:id/{backlinks,unlinked,related,graph}` (any participant). A
  **`find_related_notes` agent tool** (added to the always-on note tools + policies + chat wiring)
  lets the agent semantically navigate the user's notes. **UI**: a 🔗 **Connections** panel in the
  editor — Backlinks, Unlinked mentions, Related notes (with % scores), and a small SVG **knowledge
  graph**. *Tested:* package units (wiki-links 7, knowledge-graph extraction 5) + a deterministic
  SQLite **integration suite (8)** (wiki-link→backlink resolution, idempotent re-index, entity/
  relation extraction, unlinked mentions, semantic related + search via a deterministic embedder,
  graph build, owner-scoping) + **real-LLM Playwright e2e**: a connected vault → **entities
  extracted**, `[[wiki-links]]` → **backlinks render with titles**, unlinked mention found, **related
  notes surfaced** (research-hub scored closer to the quantum note than the pasta note), the graph
  endpoint, viewer-403/stranger-404, the **agent navigates via `find_related_notes` across agent/
  supervisor/ensemble**, and a **web-UI** Connections-panel test. 135 unit/integration green;
  typecheck + builds clean. *Acceptance: entities/relations extracted; backlinks render; "related
  notes" surfaced — all met.*
- **Phase 6 — Databases/views + AI auto-fill + typed objects.** ✅ **delivered.** Notes get
  Notion-style **databases**: typed columns, relations + rollups, five views, and AI column
  auto-fill with citations. **Package primitives**: `@weaveintel/notes` gains the pure typed-
  property model — `PropertyDef` (text / number / select / multi_select / date / checkbox /
  url / email / relation / rollup), `parseSchema`, `coerceValue` (per-type, e.g. url → http(s)
  only, select → must be an option), `validateRow`, `computeRollup` (count / sum / average /
  min / max / percent_checked / count_unique / show_original), and `VIEW_TYPES`
  (table/board/calendar/timeline/gallery). `@weaveintel/extraction` gains `autofillProperty(rows,
  property, generate)` — model-AGNOSTIC AI column fill that returns a typed value **+ cited
  source ids per row** (citations filtered to each row's declared sources). Reuses
  `@weaveintel/tools-search` for web context. **geneWeave**: `note-db-sql.ts` — `view` (schema +
  rows with computed rollups across relations + per-cell citations), `autofillColumn` (gather
  each row's context from the PAGE = its fields, the WORKSPACE = related rows, and the WEB =
  best-effort search; fill + coerce + persist value & citations under a reserved `_citations`
  key; a filled value always carries at least the row citation). Endpoints `GET /:id/view` +
  `POST /:id/autofill` (owner-scoped), and the create route now accepts the 5 view types + a
  typed `columns` schema. An **`autofill_database` agent tool** (always-on note tools + policies
  + chat wiring) lets the agent fill a column. **UI**: a 🗃 **Databases** view — a databases list,
  a table/gallery/board renderer, per-column ✨ **Fill** (and 🌐 web-fill) buttons, and 🔖 citation
  chips. *Tested:* package units (property model 8, autofill 4) + a deterministic SQLite
  **integration suite (6)** (typed view, relation + **percent_checked rollup** across two
  databases, AI auto-fill value+citation, refuse rollup/relation/unknown column, owner-scoping,
  agentAutofill) + **real-LLM Playwright e2e**: a Companies table → **view renders** + AI
  **auto-fills `founded`=1999/2014 from each row's description and `sector` within its options,
  with citations**; a Project **rolls up 67% of its Tasks done**; stranger-404; the **agent fills
  a column via `autofill_database` across agent/supervisor/ensemble**; and a **web-UI** test
  (Databases → table → ✨ Fill populates the column). *Acceptance: a view renders; AI auto-fills a
  column with citations — all met.*
- **Phase 7 — Capture & integrations.** ✅ **delivered.** Get content INTO notes from the
  outside world as structured, provenance-stamped pages ("capture then process"). **Package
  primitives**: `@weaveintel/notes` gains a pure `capture.ts` — `parseEmail` (structured fields
  OR a raw RFC822 message; HTML body → text), `buildCaptureNote` (title + a provenance
  blockquote header — source icon/label/date + a clickable source link — + a bounded body), and
  `dailyNoteTitle`. Web extraction REUSES `@weaveintel/tools-browser` (`fetchPage` SSRF-safe +
  `readability`/`extractContent`, both pure regex — no browser). **geneWeave**: `note-capture-
  sql.ts` (`createNoteCaptureService`) — `captureRun` (`resolveRunAccess` + `listUserRunEvents`
  → concat `text.delta` → note + a `note_link` back to the run), `captureWeb` (own
  `isSafePublicUrl` SSRF guard → fetch/readability → note with source link), `captureEmail`,
  and `jot` (find-or-create today's "Daily Jots — <date>" note and append a timestamped bullet).
  Endpoints `POST /api/me/notes/capture/{run,web,email}` + `POST /api/me/notes/jot` (all
  owner-scoped + tenant-isolated), and a **`capture_web_page` agent tool** (always-on note tools
  + policies across agent/supervisor/ensemble + chat wiring) so the agent can clip a page when
  asked. **UI**: a ✚ **Capture** panel in the notes list — a quick-jot box and a clip-URL box,
  with status feedback. *Tested:* package units (6: email parse structured/raw, note assembly,
  daily title) + a deterministic SQLite **integration suite (11)** (run→note + provenance link,
  metadata-title preference, html clip + source link, **SSRF rejection** of localhost/private/
  link-local/non-http, email structured+raw, jot find-or-create + append, empty-jot reject,
  owner-scoping) + **real-LLM Playwright e2e**: a real chat run → note; a page clipped (html
  override + a live `example.com` fetch); an email (fields + raw) → notes; two jots into one
  daily note; **SSRF refused (400)**; a stranger cannot capture another user's run (404); the
  **agent clips a page via `capture_web_page` across agent/supervisor/ensemble**; and a **web-UI**
  jot test. *Acceptance: a chat run + a clipped page + an email all land as structured notes — met.*
  (Deferred to later phases: live Gmail/Calendar/Drive/Slack OAuth ingestion + the scheduled
  "keep-this-note-fresh" trigger; the capture core + run/web/email/jot on-ramps are in place.)
- **Phase 8 — Workspace RAG search + chat-with-workspace + version history + comments +
  synced blocks.** ✅ **delivered.** Four features that make the workspace ASKABLE, REVIEWABLE,
  and time-travelable. **Package primitives**: `@weaveintel/notes` gains a pure `rag.ts` —
  `snippetAround` (query-centred excerpts), `reciprocalRankFusion` (merge ranked lists from
  multiple corpora, score-scale-independent), `buildCitedContext` (numbered "[n]" context block
  + parallel sources), `parseCitedIds` (read "[n]" markers back out of an answer). **DB (m103)**:
  `run_embeddings` (one vector per chat-run output — the run-side twin of Phase 5
  `note_embeddings`), `note_versions` (doc_json snapshot timeline), `note_comments` (threaded,
  block-anchored, mirroring m97 run_comments), `note_synced_blocks` (transclusion references).
  **geneWeave**: (1) `note-workspace-sql.ts` — `indexRun` (embed a run's output, idempotent),
  `workspaceSearch` (cosine-rank notes + runs SEPARATELY, fuse with RRF, build a CITED context),
  + a **`workspace_search` agent tool** (always-on + policies + chat wiring) so "what did we
  learn about X?" is answered FROM the user's notes/runs with "[n]" citations; endpoints
  `POST /api/me/workspace/{search,reindex}`. (2) `note-version-sql.ts` — `saveVersion` /
  `listVersions` / `getVersion` / `restoreVersion` (restore snapshots the current draft first, so
  it is undoable); endpoints under `/api/me/notes/:id/versions`. (3) `note-comment-sql.ts` —
  threaded block-anchored comments (reuses `renderCommentMarkdown`; soft-delete tombstones;
  thread resolve; broadcast live over the co-edit hub); `/api/me/notes/:id/comments`. (4)
  `note-synced-sql.ts` — read-through transclusion (a block mirrors another note's block/whole
  note; resolved live so editing the source updates everywhere; self-sync refused);
  `/api/me/notes/:id/synced`. **UI**: an "✦ Ask your workspace" cited-search box in the notes
  list, and 📜 History / 💬 Comments / 🔁 Synced editor panels. *Tested:* package units (12) + a
  deterministic SQLite **integration suite (12)** (RAG fuses note+run hits & excludes off-topic +
  owner-scoping; version save/restore-undoable; comment threads/edit-author-only/tombstone/
  resolve; synced read-through reflects source edits + self-sync refused) + **real-LLM Playwright
  e2e** (real-embedding workspace search cites the right note; restore reverts content; comment
  thread resolves; a synced block reflects a source edit; stranger-404; the **agent grounds its
  answer via `workspace_search` across agent/supervisor/ensemble**; a **web-UI** Ask + Save-version
  test). *Acceptance: cited workspace answers; restore an old version; a synced block updates
  everywhere — all met.* (Deferred: indexing uploaded FILES — no file-store table yet; captured
  web pages are already notes and thus covered. Version history snapshots `doc_json` rather than
  replaying the CRDT op log — simpler + sufficient since the relay writes merged state back to
  `doc_json`.)

**Track D — Voice & meetings**
- **Phase 10 — Voice memo + streaming transcription block.** Mic → AudioWorklet → WS →
  `voice` STT; `audioTranscript` block with word-timestamps + click-to-play; dictate-to-note.
  *Acceptance:* dictation transcribes live into a note; click a word seeks audio.
- **Phase 11 — Ambient meeting capture (desktop helper) + AI meeting notes + diarization.**
  Desktop/Electron system-audio capture → transcribe → diarize (pyannote/NeMo batch) → LLM →
  **structured** meeting notes (attendees/decisions/action-items→tasks). *Acceptance:* a
  recorded meeting becomes a structured, speaker-attributed, cited note with extracted tasks.

**Track E — Stylus / ink / canvas (PWA + native)**
- **Phase 12 — Ink block (PWA) + handwriting recognition.** Pointer-Events pen capture
  (coalesced+predicted, desync canvas, perfect-freehand); `InkDoc` collaborative strokes;
  ink→text (HWR API / MyScript server); OCR/PDF annotate (`extraction`). *Acceptance:* two
  users co-sketch an ink block → converge; handwriting converts to a text block.
- **Phase 13 — Infinite canvas / whiteboard + native iPad shell.** Embed tldraw (CRDT-backed)
  for whiteboard mode; thin **native iPad app** for PencilKit-grade latency/Scribble talking
  to the same server. *Acceptance:* whiteboard co-edits; iPad app reaches the same doc.

**Track F — Platform & polish**
- **Phase 9 — *(optional/frontier)* Yjs/`y-prosemirror` upgrade** behind `/coedit` for full
  rich-inline fidelity / scale; opt-in per tenant. *Acceptance:* concurrent range-formatting
  merges cleanly; 50-editor soak; home-grown remains the default.
- **Phase 14 — UX/platform polish.** Command palette, workspaces/sidebar, favorites,
  breadcrumbs, theming, export (pdf/docx), API/webhooks/MCP, mobile/tablet parity, a11y.

---

## 10. Security, governance & provenance (reuse Phase 1–7 + governance packages)
- **Trusted relay** validates every op (anti-forgery namespace `u:<userId>:<device>` + size/
  flood caps); **schema repair** guarantees a valid PM doc post-merge; **bounds/GC** on block
  + stroke + mark counts (server-coordinated, causal-stability gated).
- **AuthZ**: note owner + invited collaborators edit; viewers read-only; tenant-isolated;
  `sensitivity` gates public emission and AI exposure (`scope`/`tenancy`/`compliance`).
- **AI output**: `guardrails` + `redaction` + `cost-governor`; **every AI claim carries a
  citation + confidence + provenance** (`retrieval`/`memory`) — the anti-hallucination /
  auditability story, NotebookLM-/KnowQL-grade.
- **Capture**: OAuth-scoped connectors (`oauth`/`identity`); audio/ink assets encrypted at
  rest (`encryption`); GDPR retention/forget (`memory` expiry).

## 11. Testing strategy
- **Package:** convergence + **fuzz** property tests (the SEC proof), idempotency, causal
  delivery, offline reconcile, PM round-trip identity, adversarial-merge schema repair,
  markdown/html golden tests, ink/transcript merge tests. (Mirror `coedit/src/*.test.ts`.)
- **App:** SQL-relay contract + authorization/forgery/flood negatives; RAG citation
  correctness; emit-artifact + redaction; voice/transcript ingest; ink persistence.
- **Real-LLM Playwright e2e (all modes):** human+agent co-edit a note → byte-identical
  convergence; reload/offline reconcile; `/research` drafts a cited structured doc;
  emit-as-artifact + public share; chat-with-workspace cites sources; dictate-to-note;
  ink co-sketch; security (viewer 403, forged site, restricted-emission refused); UI regression.

## 12. Risks, non-goals, open questions
- **Rich-inline fidelity** is the main home-grown risk → Peritext-lite marks (P1) + Yjs
  escape hatch (P9). **Migration** of legacy `doc_json`→`BlockDoc` must be loss-free
  (round-trip tests + unknown-node passthrough). **System-audio capture** + **PencilKit
  latency** genuinely need native/desktop (scoped to Tracks D/E). **Open:** keep `doc_json`
  as a cache forever vs make the `BlockDoc` snapshot canonical (recommend: cache through P3,
  re-evaluate at P8). **Non-goals (initially):** real-time co-edit of database tables (P6+),
  pixel-perfect concurrent range-formatting (P9), full offline mobile parity (P14).

## 13. Appendix — evidence + weaveIntel package map + sources

**Current-implementation evidence (file):** `migrations/m46-agenda-notes.ts`;
`routes/me-notes.ts` (`updateNote` overwrites `doc_json`); `db-types/adapter-agenda-notes.ts`;
`db-sqlite.ts`; `geneweave-ui/src/ui/notes-editor.ts` (debounced 1.5 s full-doc PATCH),
`notes-view.ts`, `notes-editor-bundle-entry.ts` (Tiptap StarterKit + task-list/link/underline).

**weaveIntel packages this roadmap assembles:** `coedit` (RGA/awareness/agent-peer/validation,
Phase 7) · `core` (SSE writer/parser, JSON Patch, ids) · `retrieval` (chunker, hybrid
retriever, **citation extractor**, query rewriter) · `memory` (pgvector/mongo, `fusedMemorySearch`,
provenance, dedup, corrections, retention, consolidation) · `graph` · `extraction` (entities/
tables/tasks) · `voice` (STT pipeline + WS handler) · `artifacts` (emit + backends) ·
`collaboration` (sessions/tokens, comments) · `notifications` · `agents`/`workflows`/`triggers`/
`skills`/`recipes` · `routing`/`models`/`prompts`/`provider-*` · `cost-governor`/`guardrails`/
`redaction`/`scope`/`tenancy`/`identity`/`oauth`/`encryption`/`compliance` · `tools-browser`/
`tools-gmail`/`tools-gcal`/`tools-gdrive`/`tools-onedrive`/`tools-slack`/`tools-search` ·
`react-client`/`ui-primitives` · `mcp-server`/`mcp-client`.

**Mid-2026 product/feature sources:** Notion AI + Agents — notion.com/product/ai,
techcrunch.com/2026/05/13/notion-just-turned-its-workspace-into-a-hub-for-ai-agents ·
Microsoft Loop/Copilot Pages — support.microsoft.com (compare-loop-copilot-pages) · Obsidian
(+Excalidraw/Canvas) — dsebastien.net/the-must-have-obsidian-plugins-for-2026,
github.com/zsviczian/obsidian-excalidraw-plugin · Tana supertags/agents — tana.inc/ai,
tana.inc/docs/supertags · Granola — granola.ai, docs.granola.ai · Coda AI/Packs —
help.coda.io · NotebookLM (citations/audio) — notebooklm.google, blog.google ·
Mem/Reflect semantic — reflect.app/blog/ai-search · Amplenote transclusion/backlinks —
amplenote.com/blog · Anytype local-first — anytype.io · GoodNotes/Notability handwriting —
goodnotes.com/blog/introducing-goodnotes-6 · RAG→knowledge-layer — venturebeat.com/data/
the-rag-era-is-ending, pinecone.io/blog/knowledge-infrastructure-for-agents.

**Mid-2026 technical sources:** Pointer Events 3 + coalesced/predicted (Safari 18.2) —
w3.org/TR/pointerevents3, webkit.org/blog/16301, developer.chrome.com/blog/desynchronized ·
perfect-freehand — github.com/steveruizok/perfect-freehand · Handwriting Recognition API —
wicg.github.io/handwriting-recognition · MyScript iink — developer.myscript.com · ML Kit
Digital Ink — developers.google.com/ml-kit/vision/digital-ink-recognition · tldraw collab —
tldraw.dev/docs/collaboration · AudioWorklet/MediaRecorder + streaming STT (Deepgram/
AssemblyAI) — assemblyai.com/blog/streaming-speaker-diarization · WhisperX/faster-whisper —
github.com/SYSTRAN/faster-whisper · transformers.js v3 WebGPU — huggingface.co/blog/
transformersjs-v3 · pyannote/NeMo diarization — pyannote.ai/benchmark · system-audio capture —
developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps,
recall.ai/blog/how-to-access-to-system-audio · Tiptap AI Toolkit — tiptap.dev/docs/content-ai/
capabilities/ai-toolkit/overview · BlockNote AI/blocks — blocknotejs.org/docs · y-prosemirror —
github.com/yjs/y-prosemirror · AI-as-CRDT-peer — electric.ax/blog/2026/04/08/ai-agents-as-
crdt-peers-with-yjs, github.com/electric-sql/collaborative-ai-editor · suggestion mode —
github.com/davefowler/prosemirror-suggestion-mode, github.com/ProseMirror/prosemirror-changeset ·
pgvector RAG 2026 — danubedata.ro/blog/pgvector-rag-managed-postgres-2026 · embeddings —
buildmvpfast.com/blog/best-embedding-model-comparison-voyage-openai-cohere-2026 · citation
grounding — aiopsschool.com/blog/citation-grounding · LightRAG — neo4j.com/blog/developer/
under-the-covers-with-lightrag-extraction · Peritext — inkandswitch.com/peritext ·
Automerge rich text — automerge.org/blog/rich-text · Fugue — arxiv.org/pdf/2305.00583 ·
prosemirror-markdown — github.com/ProseMirror/prosemirror-markdown.

---

*Companion to `COLLABORATION_PACKAGE_REVIEW_AND_ROADMAP_2026.md`. The CRDT runtime,
trusted-relay, presence, transport, RAG/memory, voice, artifacts, agentic, and governance
primitives this roadmap reuses are already delivered as weaveIntel packages — weaveNotes is
largely an **assembly** of them behind a great block-editor UI, plus the new `BlockDoc`/ink/
transcript CRDT modules in `@weaveintel/coedit`.*
