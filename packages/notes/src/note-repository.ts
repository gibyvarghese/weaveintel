// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the NoteRepository PORT (weaveNotes Phase 0).
 *
 * --- For someone new to this ---
 * A "repository" is just the one doorway through which the rest of the app reads
 * and writes notes. Today geneWeave talks to the database directly from its HTTP
 * routes; that makes it impossible to test the notes feature on its own and hard
 * to later swap the storage for a real-time collaborative engine. So we put a
 * single, well-defined INTERFACE (the "port") in front of note storage. Anything
 * that implements this interface (an in-memory fake here, the SQL database in
 * geneWeave, and — in later phases — a CRDT co-editing relay) is an "adapter".
 *
 * This is the classic Ports & Adapters / Hexagonal pattern: the repository is the
 * DRIVEN-port adapter, the routes depend only on the interface, and a SINGLE
 * shared contract test ({@link "./note-repository-contract"}) proves every adapter
 * behaves identically. Introducing this seam is the WHOLE job of Phase 0 — there
 * is intentionally NO behaviour change; it just makes notes testable in isolation
 * and ready for the Phase 1–2 collaborative-editing relay to slot in as a new
 * adapter behind the very same port.
 *
 * Design note (Phase 0, deliberate): the entity shapes below mirror the persisted
 * / wire shape (snake_case fields) EXACTLY, so the existing API responses are
 * byte-for-byte unchanged when the routes start going through this port. A richer
 * camelCase domain model is deferred to a later phase. Zero-dependency + pure.
 */

export type NoteSensitivity = 'normal' | 'confidential' | 'restricted';
export type NoteLinkTargetKind = 'note' | 'run' | 'agenda_item' | 'task';
export type NoteDatabaseSource = 'agenda_items' | 'tasks' | 'generic';
export type NoteDatabaseViewType = 'table' | 'board' | 'calendar';

/** A note (a Notion-like block document; `doc_json` is a Tiptap/ProseMirror tree). */
export interface Note {
  id: string;
  owner_user_id: string;
  tenant_id: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  parent_note_id: string | null;
  sensitivity: NoteSensitivity;
  doc_json: string;
  is_template: number;
  template_key: string | null;
  favorite: number;
  created_at: string;
  updated_at: string;
}

/** A backlink / @mention from a note to a note/run/agenda-item/task. */
export interface NoteLink {
  id: string;
  note_id: string;
  target_kind: NoteLinkTargetKind;
  target_id: string;
  created_at: string;
}

/** A saved filtered/sorted view over agenda items / tasks / generic rows. */
export interface NoteDatabase {
  id: string;
  owner_user_id: string;
  tenant_id: string | null;
  name: string;
  source: NoteDatabaseSource;
  view_type: NoteDatabaseViewType;
  filter_json: string;
  sort_json: string;
  columns_json: string;
  created_at: string;
}

/** A generic key/value row for a `source: 'generic'` note database. */
export interface NoteDbRow {
  id: string;
  database_id: string;
  fields_json: string;
  created_at: string;
}

export interface NoteListFilter {
  /** `null` = top-level notes only; a string = children of that note. */
  parentNoteId?: string | null;
  favorite?: boolean;
  search?: string;
  limit?: number;
}

export interface CreateNoteInput {
  id: string;
  owner_user_id: string;
  title: string;
  tenant_id?: string | null;
  icon?: string | null;
  cover?: string | null;
  parent_note_id?: string | null;
  sensitivity?: NoteSensitivity;
  doc_json?: string;
  is_template?: number;
  template_key?: string | null;
  favorite?: number;
}

export type UpdateNotePatch = Partial<Pick<Note,
  'title' | 'icon' | 'cover' | 'parent_note_id' | 'sensitivity' | 'doc_json' | 'favorite'
>>;

export interface CreateNoteLinkInput { id: string; note_id: string; target_kind: NoteLinkTargetKind; target_id: string }
export interface CreateNoteDatabaseInput {
  id: string; owner_user_id: string; name: string;
  tenant_id?: string | null; source?: NoteDatabaseSource; view_type?: NoteDatabaseViewType;
  filter_json?: string; sort_json?: string; columns_json?: string;
}
export interface CreateNoteDbRowInput { id: string; database_id: string; fields_json?: string }

/**
 * The single seam in front of note storage. Adapters: an in-memory reference
 * ({@link createInMemoryNoteRepository}) + geneWeave's SQL adapter; both pass
 * {@link noteRepositoryContract}. The CRDT relay (Phase 2) becomes a third adapter.
 */
export interface NoteRepository {
  /** A user's own non-template notes, newest/favourite first. */
  listNotes(userId: string, filter?: NoteListFilter): Promise<Note[]>;
  /** All system + user templates (for the "new from template" picker). */
  listTemplates(): Promise<Note[]>;
  /** A single note the user owns (or a `_system` template), or null. */
  getNote(id: string, userId: string): Promise<Note | null>;
  createNote(input: CreateNoteInput): Promise<void>;
  /** Update — owner-scoped; bumps `updated_at`; a no-op patch is a no-op. */
  updateNote(id: string, userId: string, patch: UpdateNotePatch): Promise<void>;
  /** Delete a note + its one level of sub-pages + their links. Returns whether anything was deleted. */
  deleteNote(id: string, userId: string): Promise<boolean>;

  listLinks(noteId: string): Promise<NoteLink[]>;
  listBacklinks(targetKind: NoteLinkTargetKind, targetId: string): Promise<NoteLink[]>;
  createLink(input: CreateNoteLinkInput): Promise<void>;
  deleteLink(id: string, noteId: string): Promise<void>;

  listDatabases(userId: string): Promise<NoteDatabase[]>;
  getDatabase(id: string, userId: string): Promise<NoteDatabase | null>;
  createDatabase(input: CreateNoteDatabaseInput): Promise<void>;
  deleteDatabase(id: string, userId: string): Promise<void>;

  listRows(databaseId: string): Promise<NoteDbRow[]>;
  createRow(input: CreateNoteDbRowInput): Promise<void>;
  updateRow(id: string, databaseId: string, fieldsJson: string): Promise<void>;
  deleteRow(id: string, databaseId: string): Promise<void>;
}

// ─── In-memory reference adapter ────────────────────────────────────────────────

const SYSTEM_OWNER = '_system';
const DEFAULT_DOC = '{"type":"doc","content":[]}';

export interface InMemoryNoteRepositoryOptions {
  /** Monotonic timestamp source (ISO-ish string). Injectable for deterministic tests. */
  now?: () => string;
}

/**
 * A faithful in-memory implementation of {@link NoteRepository} — the reference
 * adapter the contract pins behaviour to. It mirrors the SQL adapter's exact
 * semantics: `listNotes` excludes templates + is owner-scoped + filterable +
 * ordered favourite-then-recent; `getNote` also resolves `_system` templates;
 * delete cascades one level of sub-pages; links/rows are scoped to their parent.
 */
export function createInMemoryNoteRepository(opts: InMemoryNoteRepositoryOptions = {}): NoteRepository {
  let tick = 0;
  const now = opts.now ?? (() => {
    // Strictly increasing so `updated_at DESC` ordering is deterministic in tests.
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0) + tick).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  });

  const notes = new Map<string, Note>();
  const links = new Map<string, NoteLink>();
  const databases = new Map<string, NoteDatabase>();
  const rows = new Map<string, NoteDbRow>();

  return {
    async listNotes(userId, filter) {
      let out = [...notes.values()].filter((n) => n.owner_user_id === userId && n.is_template === 0);
      if (filter?.parentNoteId !== undefined) {
        out = out.filter((n) => filter.parentNoteId === null ? n.parent_note_id === null : n.parent_note_id === filter.parentNoteId);
      }
      if (filter?.favorite) out = out.filter((n) => n.favorite === 1);
      if (filter?.search) {
        const q = filter.search.toLowerCase();
        out = out.filter((n) => n.title.toLowerCase().includes(q) || n.doc_json.toLowerCase().includes(q));
      }
      out.sort((a, b) => (b.favorite - a.favorite) || (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
      return out.slice(0, filter?.limit ?? 100);
    },
    async listTemplates() {
      return [...notes.values()].filter((n) => n.is_template === 1).sort((a, b) => a.title.localeCompare(b.title));
    },
    async getNote(id, userId) {
      const n = notes.get(id);
      if (!n) return null;
      return (n.owner_user_id === userId || n.owner_user_id === SYSTEM_OWNER) ? n : null;
    },
    async createNote(input) {
      const ts = now();
      notes.set(input.id, {
        id: input.id, owner_user_id: input.owner_user_id, tenant_id: input.tenant_id ?? null,
        title: input.title, icon: input.icon ?? null, cover: input.cover ?? null,
        parent_note_id: input.parent_note_id ?? null, sensitivity: input.sensitivity ?? 'normal',
        doc_json: input.doc_json ?? DEFAULT_DOC, is_template: input.is_template ?? 0,
        template_key: input.template_key ?? null, favorite: input.favorite ?? 0,
        created_at: ts, updated_at: ts,
      });
    },
    async updateNote(id, userId, patch) {
      const n = notes.get(id);
      if (!n || n.owner_user_id !== userId) return; // owner-scoped, like the SQL WHERE
      if (Object.keys(patch).length === 0) return;  // no-op patch = no-op (matches SQL early return)
      notes.set(id, { ...n, ...patch, updated_at: now() });
    },
    async deleteNote(id, userId) {
      const target = notes.get(id);
      if (!target || target.owner_user_id !== userId) return false;
      // Cascade one level of sub-pages + their links (mirrors the SQL transaction).
      for (const sub of [...notes.values()]) {
        if (sub.parent_note_id === id && sub.owner_user_id === userId) {
          for (const [lid, l] of links) if (l.note_id === sub.id) links.delete(lid);
          notes.delete(sub.id);
        }
      }
      for (const [lid, l] of links) if (l.note_id === id) links.delete(lid);
      notes.delete(id);
      return true;
    },

    async listLinks(noteId) {
      return [...links.values()].filter((l) => l.note_id === noteId).sort((a, b) => a.created_at < b.created_at ? -1 : 1);
    },
    async listBacklinks(targetKind, targetId) {
      return [...links.values()].filter((l) => l.target_kind === targetKind && l.target_id === targetId).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
    },
    async createLink(input) {
      if (links.has(input.id)) return; // INSERT OR IGNORE on the primary key
      links.set(input.id, { ...input, created_at: now() });
    },
    async deleteLink(id, noteId) {
      const l = links.get(id);
      if (l && l.note_id === noteId) links.delete(id);
    },

    async listDatabases(userId) {
      return [...databases.values()].filter((d) => d.owner_user_id === userId).sort((a, b) => a.name.localeCompare(b.name));
    },
    async getDatabase(id, userId) {
      const d = databases.get(id);
      return d && d.owner_user_id === userId ? d : null;
    },
    async createDatabase(input) {
      databases.set(input.id, {
        id: input.id, owner_user_id: input.owner_user_id, tenant_id: input.tenant_id ?? null,
        name: input.name, source: input.source ?? 'generic', view_type: input.view_type ?? 'table',
        filter_json: input.filter_json ?? '{}', sort_json: input.sort_json ?? '[]',
        columns_json: input.columns_json ?? '[]', created_at: now(),
      });
    },
    async deleteDatabase(id, userId) {
      const d = databases.get(id);
      if (!d || d.owner_user_id !== userId) return;
      for (const [rid, r] of rows) if (r.database_id === id) rows.delete(rid);
      databases.delete(id);
    },

    async listRows(databaseId) {
      return [...rows.values()].filter((r) => r.database_id === databaseId).sort((a, b) => a.created_at < b.created_at ? -1 : 1);
    },
    async createRow(input) {
      rows.set(input.id, { id: input.id, database_id: input.database_id, fields_json: input.fields_json ?? '{}', created_at: now() });
    },
    async updateRow(id, databaseId, fieldsJson) {
      const r = rows.get(id);
      if (r && r.database_id === databaseId) rows.set(id, { ...r, fields_json: fieldsJson });
    },
    async deleteRow(id, databaseId) {
      const r = rows.get(id);
      if (r && r.database_id === databaseId) rows.delete(id);
    },
  };
}
