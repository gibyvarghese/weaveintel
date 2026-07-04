# @weaveintel/notes

**The slim, brand-free seam in front of notes: one `NoteRepository` port, a shared contract test, an in-memory adapter, and pure helpers for the note-document model.**

## Why it exists

If every part of an app reaches into note storage on its own — one place saving from an HTTP route, another overwriting the whole document on every keystroke — two tabs or two people quietly clobber each other's work. The fix is to make storage go through a single doorway with agreed-upon rules, the way a library has one checkout desk instead of letting everyone shelve books themselves. This package is that doorway: a `NoteRepository` interface plus a contract test that pins every implementation to identical behaviour, so the app can swap an in-memory store for a SQL one — or a real-time co-editing engine — without changing a line of calling code. Product features (the editor UI, AI actions) live in the app; this layer stays small and portable.

## When to reach for it

Reach for it when you're implementing note storage or a feature that reads/writes notes: use the port so your code doesn't hard-wire a database, and run `noteRepositoryContract` against any adapter you build. Reach for the pure helpers to parse wiki-links, resolve entities, or convert between the block-document model and its `doc_json` form. If you want the finished notes application — routes, editor, AI — that lives in `apps/geneweave`, not here; this package is the reusable contract underneath it.

## How to use it

```ts
import { createInMemoryNoteRepository } from '@weaveintel/notes';

const repo = createInMemoryNoteRepository();

const note = await repo.create({
  ownerId: 'user-1',
  title: 'Launch plan',
  doc_json: { type: 'doc', content: [] },
});

const patched = await repo.update(note.id, { title: 'Launch plan (v2)' });
console.log(patched?.title); // → "Launch plan (v2)"
```

## What's in the box

- **The port & adapter** — `NoteRepository` (interface), `createInMemoryNoteRepository`, and input/patch types (`CreateNoteInput`, `UpdateNotePatch`, `NoteListFilter`, …).
- **Contract test** — `noteRepositoryContract`: run it against any adapter to prove identical behaviour.
- **Content extraction** — `extractPlainText`, `extractTaskItems`.
- **Wiki-links & entities** — `parseWikiLinks`, `findUnlinkedMentions`, `buildLinkSuggestions`, `resolveEntities`, `canonicalizeEntityName`.
- **Note-document model** — `blocksToDoc`/`docToBlocks`, `blocksPlainText`, `emptyNoteDoc`, `NOTE_NODE_REGISTRY`.
- **Databases** — `parseSchema`, `validateRow`, `computeRollup` for typed note properties.
- **Ink** — `strokesToSvg`, `strokeToPath`, `validateStrokes` (freehand strokes → SVG).
- **Export** — `exportNote`, `noteToMarkdown`, `noteToHtmlDocument`, `noteToWordHtml`, `noteToJson`.
- **Image provenance** — `buildImageProvenance`, `embedXmpInSvg`, `parseProvenanceFromSvg`.

## License

MIT.
