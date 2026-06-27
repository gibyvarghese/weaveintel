# @weaveintel/coedit

**CRDT co-editing for AI apps** — a tiny, zero-dependency toolkit so a human and
an AI agent can edit ONE document at the same time and always converge, with
awareness cursors and offline reconcile (Collaboration Phase 7).

> New to this? A **CRDT** (Conflict-free Replicated Data Type) is the trick behind
> tools like Google Docs / Figma multiplayer: many people (and here, an AI agent)
> edit the same thing at once and it never scrambles. Instead of "insert at
> position 5" (which drifts when others edit), every character gets a permanent
> unique id and edits say "insert AFTER character X". With one fixed rule for
> ordering two characters that land in the same place, every copy rebuilds the
> identical text — guaranteed, with no central lock.

## What's in the box

| Primitive | What it does |
|---|---|
| `RgaDoc` | The **RGA text CRDT** — `localInsert`/`localDelete` return ops to broadcast; `apply` merges remote ops. Convergent, idempotent, causal-buffered. `stateVector()`/`opsSince()` for offline sync; `snapshot()`/`fromSnapshot()` for persistence. |
| `Awareness` | **Ephemeral cursors + presence** (who's editing, where). Cursors are *relative positions* (anchored to a character id, not an integer offset) so they don't jump when others edit. Last-write-wins per peer; TTL-expired. |
| `createAgentPeer` | The **agent as a co-editing peer** — a server-side replica with its own site id that streams its output as insert ops. `direct` or `suggest` (HITL) mode. |
| `validateClientOps` | The **trusted-relay** op validator — anti-forgery (a peer can't author ops as another site), size/flood caps, shape checks. |
| `BlockDoc` | The **rich-text / block-document CRDT** (weaveNotes Phase 1) — co-edit a *structured* note (headings, lists, to-dos, code, quotes) with inline marks, on the same RGA. `pmToBlocks`/`blocksToProseMirror` convert to/from Tiptap JSON; `blocksToMarkdown`/`blocksToHtml` serialize; `createBlockAgentPeer` lets the agent contribute Markdown as blocks. |
| `validateClientBlockOps` | The **trusted-relay BLOCK-op validator** (weaveNotes Phase 2) — `validateClientOps` for `BlockDoc` ops: anti-forgery (a peer can't author ops as another site), size/flood caps, unknown block/mark rejection. |
| `diffBlocks` | **Diff-on-save** (weaveNotes Phase 2) — turn a whole edited document (`pmToBlocks(editor.getJSON())`) into the block ops that transform a synced replica into it. Lets an editor that only hands you "the new whole doc" still co-edit convergently. |

## The algorithm (RGA)

Chosen after a mid-2026 survey (it's what Automerge ships; the simplest sequence
CRDT that is *provably* convergent — verified against the Kleppmann/Gomes Isabelle
proof + Sypytkowski's reference implementation):

- **Element id** = `(counter, siteId)` — a per-site Lamport counter + a unique
  site id. Globally unique, totally ordered.
- **Insert-after-reference**: an insert records the id of the element it goes
  after (or `null` for the start), never an absolute index.
- **The one rule that makes it converge** — among elements sharing a reference,
  order by **descending id** (higher counter first; equal counter → higher
  siteId first). Every replica sorts by the same rule, so applying the same set
  of ops in *any* order yields byte-identical text (Strong Eventual Consistency).
- **Delete = tombstone** (hide, never remove — a deleted char still anchors
  others). **Causal buffering**: an op whose dependency hasn't arrived is held
  and replayed when it does.

```ts
import { RgaDoc } from '@weaveintel/coedit';

const alice = new RgaDoc('alice');
const bob = new RgaDoc('bob');
const seed = alice.localInsertText(0, 'Hello!'); bob.apply(seed[0]!); // … sync
const a = alice.localInsertText(5, ' Alice');   // "Hello Alice!"
const b = bob.localInsertText(5, ' Bob');       // "Hello Bob!"
bob.applyMany(a); alice.applyMany(b);
alice.text() === bob.text();                     // true — CONVERGED
```

## Offline reconcile (state-vector sync)

```ts
// Each replica advertises a state vector (max counter seen per site).
const missing = peerA.opsSince(peerB.stateVector()); // exactly what B lacks
peerB.applyMany(missing);                             // converge — bandwidth-minimal
```

## The agent as a peer

```ts
import { RgaDoc, createAgentPeer, agentSiteId } from '@weaveintel/coedit';
const doc = new RgaDoc(agentSiteId(runId));     // reserved agent site
const agent = createAgentPeer(doc);             // direct co-editor
agent.append('text the model streamed');        // merges with concurrent human edits
```

Mid-2026 research note: a 2025 user study found people prefer the agent as a
**suggester** (tracked changes they accept) for large/overlapping edits — pass
`{ mode: 'suggest' }` to get the ops back WITHOUT applying them, for the host to
gate behind human approval.

## Rich-text / block co-editing — `BlockDoc` (weaveNotes Phase 1)

`RgaDoc` co-edits PLAIN text. A note is a STRUCTURED document — headings, lists,
to-dos, code blocks, with **bold**/_italic_/`code`/links. `BlockDoc` makes the
whole structure co-editable + convergent, on the **same RGA**.

> New to this? The trick (Automerge's): instead of a tree, keep ONE flat sequence
> of tiny elements — each is either a single CHARACTER or a "block marker" that
> says "a new block (a heading / a list item / …) starts here". Because it is just
> one sequence, all the proven plain-text CRDT machinery works unchanged. Splitting
> a paragraph = inserting a marker. Merging two = deleting a marker. No trees, no
> locks, no conflict-resolution code.

```ts
import { BlockDoc, pmToBlocks, blocksToProseMirror, blocksToMarkdown } from '@weaveintel/coedit';

const doc = BlockDoc.fromBlocks('alice', pmToBlocks(tiptapJson)); // load a note
doc.insertText(doc.blocks()[0]!.id, 0, 'Hi ');                    // edit it
doc.splitBlock(blockId, 5);                                       // press Enter mid-paragraph
const md = blocksToMarkdown(doc.blocks());                        // feed the note to an AI model
const pm = blocksToProseMirror(doc.blocks());                     // render back to Tiptap (schema-repaired)
```

On top of the sequence sit two small last-write-wins layers: block **attributes**
(`type`, `level`, `checked`, `listType` — keyed by the marker id) and inline
**marks** (Peritext-lite spans anchored to character ids, so a span survives
concurrent edits and add/remove commute). Convergence (Strong Eventual
Consistency) is inherited from the RGA. `blocksToProseMirror` always runs a
deterministic **schema repair** (`normalizeBlocks`) so a doc produced by a
concurrent merge is valid ProseMirror; unknown block/mark types pass through
verbatim so a schema-version skew never drops content.

**Creative content survives the merge (weaveNotes Phase 1):** the block model
round-trips the creative marks `highlight` + `textColor` (each carries its colour
in the mark value) and the creative blocks `callout` / `toggle` / `image` /
`sticker` / `washiDivider` — so a callout an AI wrote, or a phrase a teammate
highlighted pink, is preserved through a concurrent co-edit instead of being
flattened back to a paragraph. `markdownToBlocks` also parses `==highlight==` and
GitHub-style `> [!NOTE]` / `[!TIP]` / `[!WARNING]` callouts, so the AI co-author
produces real coloured highlights + callouts from plain Markdown; `blocksToHtml`
renders them with a strict colour/scheme allowlist (`safeCssColor`) for safe shares.

**The agent as a block co-editor:** `createBlockAgentPeer(doc)` parses the model's
Markdown into block ops and merges them — so the AI and a human build the same note
at once, converging, with no clobbering (the Phase 7 "agent as a CRDT peer" pattern
lifted to blocks). Pass `{ mode: 'suggest' }` (weaveNotes Phase 3) to get the ops
back **without** applying them — the host stages them as **track-changes
suggestions** a human accepts or rejects, so the AI never silently rewrites a
document:

```ts
// DIRECT — the agent types into the doc, converging live with humans:
const ops = createBlockAgentPeer(doc).appendMarkdown(modelMarkdown);

// SUGGEST — stage for human review (give the doc a UNIQUE site per suggestion so
// two pending suggestions never mint colliding op ids; they still apply on accept):
const staged = createBlockAgentPeer(BlockDoc.fromSnapshot(`agent:${noteId}:s1`, snap), { mode: 'suggest' })
  .appendMarkdown(modelMarkdown);
// …later, on Accept: doc.applyMany(staged)
```

In geneWeave, `GET /api/me/notes/:id/blocks?format=blocks|markdown|html` runs a real
note through `BlockDoc` and renders it (the building block for the Phase 2 collaborative
editor + the Phase 4 emit-as-artifact flow).

## Collaborative notes — the trusted relay (weaveNotes Phase 2)

Phase 1 gave us the note CRDT; Phase 2 makes a note co-editable by two people (and
the agent) *at once*, with sharing, presence and offline reconcile. geneWeave is the
**trusted relay**: it holds the canonical `BlockDoc`, and every client edit flows
through two package primitives.

```ts
import { validateClientBlockOps, diffBlocks, BlockDoc } from '@weaveintel/coedit';

// SERVER: before applying a client's block ops, verify them (anti-forgery + caps).
const v = validateClientBlockOps(rawOps, { expectedSiteId: `u:${userId}` });
if (!v.ok) throw new Error(v.error);        // e.g. "identity forgery", "too many ops"

// CLIENT: an editor hands you the whole new document, not ops. Diff it against your
// own replica (which already merged everyone else's ops from the live stream) → the
// ops are exactly YOUR local changes, so submitting them converges, never clobbers.
const ops = diffBlocks(myReplica, pmToBlocks(editor.getJSON()));
await post(`/api/me/notes/${noteId}/coedit/ops`, { ops });
```

> Why `diffBlocks` is safe: it diffs against the *synced* replica, so it captures only
> what THIS user changed — never a stale "make the whole doc look like my screen",
> which would erase a collaborator. Two clients that each diff-against-their-synced-
> replica converge, exactly like hand-authored ops. (A *stale* whole-document save can
> only merge what it actually saw — which is why live concurrent typing uses ops, and
> the legacy full-document save is the single-user fallback.)

In geneWeave (Phase 2): `note_coedit_docs` (snapshot) + `note_coedit_ops` (op log) +
`note_shares` / `note_share_tokens` (membership + invite links). Endpoints under
`/api/me/notes/:id/coedit/*` (ensure / ops / sync / events-SSE / awareness) + sharing
(`/share`, `/join`). The server validates every op, role-gates edits (viewers get
403), broadcasts ops + presence live over per-note SSE, and keeps the note's rendered
`doc_json` in sync so the legacy single-user editor still reads correctly.

## Publishing a note as an artifact (weaveNotes Phase 4)

`blocksToMarkdown` / `blocksToHtml` (above) are also the bridge that turns a note into a
**shareable artifact** with a public link. The safety layer lives in
[`@weaveintel/artifacts`](../artifacts): `redactText(text, level)` scrubs secrets (API
keys, JWTs, private keys, bearer tokens) — and, at `pii` level, emails/phones/SSNs/cards —
before anything is published; `publishPolicyForSensitivity(sensitivity)` decides the rest
(`restricted` → refused, `confidential` → redact PII + secrets, `normal` → scrub secrets).
In geneWeave: `POST /api/me/notes/:id/emit-artifact` (and the `note_publish` agent tool)
render → gate → redact → `saveArtifact` → optional public share token, so a stray key in a
note never leaks the moment it is shared, and a `restricted` note can never be published.

## Knowledge graph (weaveNotes Phase 5)

Notes connect into a browsable web of meaning. The pieces live in sibling packages so they
stay reusable: [`@weaveintel/notes`](../notes) provides `parseWikiLinks` (`[[Title]]`) +
`findUnlinkedMentions`; [`@weaveintel/extraction`](../extraction) provides
`extractKnowledgeGraph(text, generate)` (model-agnostic LLM entity/relation extraction);
[`@weaveintel/graph`](../graph) supplies the entity/edge shapes; and `@weaveintel/cache`'s
`cosineSimilarity` ranks note embeddings for "related notes". geneWeave's `note-graph-sql.ts`
`indexNote` ties them together — resolving `[[wiki-links]]` into the `note_links` table (so
backlinks come for free), extracting entities/relations, and embedding the note — and exposes
`GET /api/me/notes/:id/{backlinks,unlinked,related,graph}` plus a `find_related_notes` agent
tool. The editor's 🔗 **Connections** panel renders backlinks, unlinked mentions, related notes,
and a small knowledge-graph map.

## Databases / views + AI auto-fill (weaveNotes Phase 6)

Notes can be organised as Notion-style **databases** — typed columns, relations + rollups, and
five views. The pure model lives in [`@weaveintel/notes`](../notes): `PropertyDef` (text / number
/ select / multi_select / date / checkbox / url / email / relation / rollup), `parseSchema`,
`coerceValue`, `validateRow`, `computeRollup`, `VIEW_TYPES`. The AI column auto-fill lives in
[`@weaveintel/extraction`](../extraction): `autofillProperty(rows, property, generate)` returns a
typed value **+ cited source ids per row** (model-agnostic). geneWeave's `note-db-sql.ts` ties them
together — `view` (rows + computed rollups + citations) and `autofillColumn` (gather each row's
context from the page + workspace + web via `@weaveintel/tools-search`, fill + coerce + persist
value & citations) — behind `GET /api/me/note-databases/:id/view`, `POST /:id/autofill`, and an
`autofill_database` agent tool. The 🗃 **Databases** UI renders table/gallery/board with per-column
✨ Fill buttons and 🔖 citation chips.

## Capture & integrations (weaveNotes Phase 7)

Get content **into** notes from the outside world as structured, provenance-stamped pages. The
pure helpers live in [`@weaveintel/notes`](../notes) `capture.ts`: `parseEmail` (structured fields
**or** a raw RFC822 message; HTML → text), `buildCaptureNote` (title + a provenance header — where
it came from, when, and a source link — + a bounded body), and `dailyNoteTitle`. Web-page
extraction reuses [`@weaveintel/tools-browser`](../tools-browser) (`fetchPage` SSRF-safe +
`readability`/`extractContent`, both pure regex). geneWeave's `note-capture-sql.ts` wires four
on-ramps: `captureRun` (a chat run's output → a note + a `note_link` back to the run), `captureWeb`
(SSRF-guarded clip → readable note), `captureEmail`, and `jot` (find-or-create today's
"Daily Jots — &lt;date&gt;" note and append). They sit behind `POST /api/me/notes/capture/{run,web,email}`
+ `POST /api/me/notes/jot`, a `capture_web_page` agent tool, and a ✚ **Capture** panel (quick-jot
box + clip-URL box) in the notes list. Every capture is owner-scoped + tenant-isolated, and web
clips reject localhost/private/link-local/metadata/non-http targets.

## Workspace RAG + version history + comments + synced blocks (weaveNotes Phase 8)

Four features that make the workspace askable + reviewable. **Pure helpers** in
[`@weaveintel/notes`](../notes) `rag.ts`: `snippetAround` (query-centred excerpts),
`reciprocalRankFusion` (merge ranked lists from multiple corpora, score-scale-independent),
`buildCitedContext` (numbered "[n]" context + sources), `parseCitedIds`. geneWeave wires:
- **Workspace RAG** — `note-workspace-sql.ts` embeds each chat run's output into `run_embeddings`
  (the run-side twin of Phase 5 `note_embeddings`), then `workspaceSearch` cosine-ranks notes +
  runs, fuses with RRF, and returns a CITED context. Behind `POST /api/me/workspace/{search,reindex}`
  and a `workspace_search` agent tool (so "what did we learn about X?" is answered with citations).
- **Version history** — `note-version-sql.ts`: snapshot `doc_json` into `note_versions`; restore is
  undoable (it snapshots the current draft first). `/api/me/notes/:id/versions`.
- **Comments** — `note-comment-sql.ts`: threaded, block-anchored comments (reuses
  `renderCommentMarkdown`; soft-delete tombstones; thread resolve; live over the co-edit hub).
  `/api/me/notes/:id/comments`.
- **Synced blocks** — `note-synced-sql.ts`: read-through transclusion (a block mirrors another
  note's block/whole note; source edits reflect everywhere; self-sync refused).
  `/api/me/notes/:id/synced`.
The notes UI adds an "✦ Ask your workspace" box + 📜 History / 💬 Comments / 🔁 Synced panels.

## Security (trusted relay)

CRDTs converge but are **not** Byzantine-tolerant — so the server validates every
op before applying + broadcasting: a peer's site id is derived from its
authenticated session (no forgery), op size + count are capped (anti-flood), and
shapes are checked. See `validateClientOps`.

## In geneWeave

geneWeave persists docs (`coedit_docs` snapshot + `coedit_ops` log), exposes
create/get/ops/sync/awareness endpoints, broadcasts ops live over the run SSE
stream, and runs the agent as a server-side peer that co-edits the run's output
document. See `COLLABORATION_PACKAGE_REVIEW_AND_ROADMAP_2026.md` (Phase 7).
