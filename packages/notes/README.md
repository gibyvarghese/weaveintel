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
