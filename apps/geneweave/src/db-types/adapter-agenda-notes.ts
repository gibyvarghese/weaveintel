/**
 * DB adapter — agenda & notes tables (m46)
 *
 * Covers: agenda_categories, agenda_items, notes, note_links,
 *         note_databases, note_db_rows.
 */

// ── Agenda ────────────────────────────────────────────────────────────────────

export interface AgendaCategoryRow {
  id: string;
  tenant_id: string | null;
  user_id: string | null;
  name: string;
  color: string;
  icon: string;
  template_key: string | null;
  created_at: string;
}

export type AgendaItemKind = 'event' | 'deadline' | 'reminder' | 'appointment' | 'recurring' | 'follow-up';
export type AgendaItemStatus = 'confirmed' | 'proposed' | 'tentative' | 'cancelled';
export type AgendaItemSensitivity = 'normal' | 'confidential' | 'restricted';

export interface AgendaItemRow {
  id: string;
  user_id: string;
  tenant_id: string | null;
  title: string;
  kind: AgendaItemKind;
  category_id: string | null;
  start_at: string | null;
  end_at: string | null;
  all_day: number;
  location: string | null;
  description: string | null;
  recurrence_rule: string | null;
  status: AgendaItemStatus;
  sensitivity: AgendaItemSensitivity;
  amount: string | null;
  currency: string | null;
  provenance: string | null;
  linked_task_id: string | null;
  linked_run_id: string | null;
  linked_note_id: string | null;
  parent_item_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgendaListFilter {
  startAt?: string;
  endAt?: string;
  kind?: AgendaItemKind;
  status?: AgendaItemStatus;
  categoryId?: string;
  limit?: number;
  search?: string;
}

// ── Notes ─────────────────────────────────────────────────────────────────────

export type NoteSensitivity = 'normal' | 'confidential' | 'restricted';

export interface NoteRow {
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
  /** weaveNotes Phase 1 (m105): page theme the note opens in — 'pro' | 'creative'. */
  page_theme: string;
  /** weaveNotes Phase 1 (m105): freeform/canvas layout flag (0/1). */
  freeform_mode: number;
  /** weaveNotes Phase 1 (m105): optional cover-image artifact id. */
  cover_image_artifact_id: string | null;
  created_at: string;
  updated_at: string;
}

export type NoteLinkTargetKind = 'note' | 'run' | 'agenda_item' | 'task';

export interface NoteLinkRow {
  id: string;
  note_id: string;
  target_kind: NoteLinkTargetKind;
  target_id: string;
  created_at: string;
}

export type NoteDatabaseSource = 'agenda_items' | 'tasks' | 'generic';
export type NoteDatabaseViewType = 'table' | 'board' | 'calendar';

export interface NoteDatabaseRow {
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

export interface NoteDbRowRow {
  id: string;
  database_id: string;
  fields_json: string;
  created_at: string;
}

export interface NoteListFilter {
  parentNoteId?: string | null;
  isTemplate?: boolean;
  favorite?: boolean;
  search?: string;
  limit?: number;
}

// ── Store interface ────────────────────────────────────────────────────────────

export interface IAgendaNotesStore {
  // ── Agenda categories ──────────────────────────────────────────────────────
  listAgendaCategories(userId: string): Promise<AgendaCategoryRow[]>;
  getAgendaCategory(id: string): Promise<AgendaCategoryRow | null>;
  createAgendaCategory(row: Pick<AgendaCategoryRow, 'id' | 'name'> & {
    tenant_id?: string | null; user_id?: string | null;
    color?: string; icon?: string; template_key?: string | null;
  }): Promise<void>;
  updateAgendaCategory(id: string, patch: Partial<Pick<AgendaCategoryRow, 'name' | 'color' | 'icon'>>): Promise<void>;
  deleteAgendaCategory(id: string, userId: string): Promise<void>;

  // ── Agenda items ───────────────────────────────────────────────────────────
  listAgendaItems(userId: string, filter?: AgendaListFilter): Promise<AgendaItemRow[]>;
  findSimilarAgendaItems(userId: string, title: string, dateBucket?: string): Promise<AgendaItemRow[]>;
  getAgendaItem(id: string, userId: string): Promise<AgendaItemRow | null>;
  createAgendaItem(row: Pick<AgendaItemRow, 'id' | 'user_id' | 'title'> & {
    tenant_id?: string | null; kind?: AgendaItemKind; category_id?: string | null;
    start_at?: string | null; end_at?: string | null; all_day?: number;
    location?: string | null; description?: string | null; recurrence_rule?: string | null;
    status?: AgendaItemStatus; sensitivity?: AgendaItemSensitivity;
    amount?: string | null; currency?: string | null; provenance?: string | null;
    linked_task_id?: string | null; linked_run_id?: string | null; linked_note_id?: string | null;
    parent_item_id?: string | null;
  }): Promise<void>;
  updateAgendaItem(id: string, userId: string, patch: Partial<Pick<AgendaItemRow,
    'title' | 'kind' | 'category_id' | 'start_at' | 'end_at' | 'all_day' |
    'location' | 'description' | 'recurrence_rule' | 'status' | 'sensitivity' |
    'amount' | 'currency' | 'linked_task_id' | 'linked_run_id' | 'linked_note_id'
  >>): Promise<void>;
  deleteAgendaItem(id: string, userId: string): Promise<boolean>;

  // ── Notes ──────────────────────────────────────────────────────────────────
  listNotes(userId: string, filter?: NoteListFilter): Promise<NoteRow[]>;
  listNoteTemplates(): Promise<NoteRow[]>;
  getNote(id: string, userId: string): Promise<NoteRow | null>;
  createNote(row: Pick<NoteRow, 'id' | 'owner_user_id' | 'title'> & {
    tenant_id?: string | null; icon?: string | null; cover?: string | null;
    parent_note_id?: string | null; sensitivity?: NoteSensitivity;
    doc_json?: string; is_template?: number; template_key?: string | null; favorite?: number;
    page_theme?: string; freeform_mode?: number; cover_image_artifact_id?: string | null;
  }): Promise<void>;
  updateNote(id: string, userId: string, patch: Partial<Pick<NoteRow,
    'title' | 'icon' | 'cover' | 'parent_note_id' | 'sensitivity' | 'doc_json' | 'favorite'
    | 'page_theme' | 'freeform_mode' | 'cover_image_artifact_id'
  >>): Promise<void>;
  deleteNote(id: string, userId: string): Promise<boolean>;

  // ── Note links ─────────────────────────────────────────────────────────────
  listNoteLinks(noteId: string): Promise<NoteLinkRow[]>;
  listNoteBacklinks(targetKind: NoteLinkTargetKind, targetId: string): Promise<NoteLinkRow[]>;
  createNoteLink(row: Pick<NoteLinkRow, 'id' | 'note_id' | 'target_kind' | 'target_id'>): Promise<void>;
  deleteNoteLink(id: string, noteId: string): Promise<void>;

  // ── Note databases ─────────────────────────────────────────────────────────
  listNoteDatabases(userId: string): Promise<NoteDatabaseRow[]>;
  getNoteDatabase(id: string, userId: string): Promise<NoteDatabaseRow | null>;
  createNoteDatabase(row: Pick<NoteDatabaseRow, 'id' | 'owner_user_id' | 'name'> & {
    tenant_id?: string | null; source?: NoteDatabaseSource; view_type?: NoteDatabaseViewType;
    filter_json?: string; sort_json?: string; columns_json?: string;
  }): Promise<void>;
  deleteNoteDatabase(id: string, userId: string): Promise<void>;

  // ── Note database rows ─────────────────────────────────────────────────────
  listNoteDbRows(databaseId: string): Promise<NoteDbRowRow[]>;
  createNoteDbRow(row: Pick<NoteDbRowRow, 'id' | 'database_id'> & { fields_json?: string }): Promise<void>;
  updateNoteDbRow(id: string, databaseId: string, fieldsJson: string): Promise<void>;
  deleteNoteDbRow(id: string, databaseId: string): Promise<void>;
}
