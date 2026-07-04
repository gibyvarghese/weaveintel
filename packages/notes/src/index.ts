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

// Colour-safety gate (shared by ink/diagram/creative + the app).
export { sanitizeColor } from './color-safety.js';

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
  type PMNode,
  type PMDoc,
} from './note-doc.js';

// IMAGE PROVENANCE (Phase 2): licence + AI-lineage credentials embedded with image assets.
export type { ImageSourceKind, ImageProvenance } from './provenance.js';
export {
  buildImageProvenance,
  provenanceCreditLine,
  provenanceToXmp,
  embedXmpInSvg,
  parseProvenanceFromSvg,
} from './provenance.js';

