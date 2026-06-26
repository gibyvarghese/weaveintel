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
  parseWikiLinks,
  findUnlinkedMentions,
  titleKey,
} from './wiki-links.js';

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
} from './rag.js';
