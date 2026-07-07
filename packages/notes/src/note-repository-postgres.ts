// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the Postgres adapter for the {@link NoteRepository} port.
 *
 * --- For someone new to this ---
 * The package already defines the ONE doorway to note storage (the `NoteRepository` port) and ships an
 * in-memory version of it for tests. This file is the REAL one: the same doorway, backed by a Postgres
 * database. Because both go through the identical port, the shared contract test
 * ({@link noteRepositoryContract}) runs against BOTH and proves they behave the same — so a consuming
 * app can move its notes onto this adapter and trust nothing changed. That's the whole point of Phase 3
 * of the persistence review: the SQL lives here, in the package, behind the port — not scattered in the
 * app's HTTP routes.
 *
 * It is driver-agnostic in spirit: you hand in a `pg.Pool` (or anything pool-shaped) — e.g. the shared
 * pool from `weaveSharedPostgres` in `@weaveintel/persistence`, so your whole runtime uses one
 * connection. Every value is a bound parameter (`$1`, `$2`, …), never glued into the SQL text, so a
 * title or note body containing quotes, semicolons, or `DROP TABLE` is stored as harmless data. Tables
 * are created on first use (`CREATE TABLE IF NOT EXISTS`) — no migration step to run first.
 *
 * Parity notes (why the small choices): columns are named EXACTLY like the `Note` fields (snake_case),
 * so a `SELECT *` row already IS a `Note`. On/off flags stay `INTEGER` (0/1, read back as numbers, not
 * booleans) and timestamps stay `TEXT`, matching the in-memory reference and the app's existing shape.
 * A monotonic clock guarantees `updated_at` never ties, so "newest first" ordering is deterministic.
 */

import type { Pool } from 'pg';
import type {
  NoteRepository,
  Note,
  NoteLink,
  NoteDatabase,
  NoteDbRow,
  CreateNoteInput,
  UpdateNotePatch,
  CreateNoteLinkInput,
  CreateNoteDatabaseInput,
  CreateNoteDbRowInput,
  NoteListFilter,
  NoteLinkTargetKind,
} from './note-repository.js';

const SYSTEM_OWNER = '_system';
const DEFAULT_DOC = '{"type":"doc","content":[]}';

export interface PostgresNoteRepositoryOptions {
  /** A `pg.Pool` (or pool-shaped client). Share one across your app — e.g. from `weaveSharedPostgres`. */
  readonly pool: Pool;
  /** Timestamp source (ISO-ish `YYYY-MM-DD HH:MM:SS`). Injectable for deterministic tests. */
  readonly now?: () => string;
  /** Skip `CREATE TABLE IF NOT EXISTS` on first use (e.g. when you manage the schema yourself). */
  readonly ensureSchema?: boolean;
}

/** A real-time, strictly-increasing clock so `updated_at DESC` ordering never ties (parity with the ref). */
function monotonicClock(): () => string {
  let last = 0;
  return () => {
    const t = Math.max(Date.now(), last + 1);
    last = t;
    return new Date(t).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  };
}

/** Escape LIKE/ILIKE wildcards so a search term is matched LITERALLY (as the in-memory ref does). */
function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, '\\$1');
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  tenant_id TEXT,
  title TEXT NOT NULL,
  icon TEXT,
  cover TEXT,
  parent_note_id TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  doc_json TEXT NOT NULL,
  is_template INTEGER NOT NULL DEFAULT 0,
  template_key TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  page_theme TEXT NOT NULL DEFAULT 'pro',
  freeform_mode INTEGER NOT NULL DEFAULT 0,
  cover_image_artifact_id TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_owner_idx ON notes (owner_user_id, is_template);
CREATE TABLE IF NOT EXISTS note_links (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_links_note_idx ON note_links (note_id);
CREATE INDEX IF NOT EXISTS note_links_target_idx ON note_links (target_kind, target_id);
CREATE TABLE IF NOT EXISTS note_databases (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  tenant_id TEXT,
  name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'generic',
  view_type TEXT NOT NULL DEFAULT 'table',
  filter_json TEXT NOT NULL DEFAULT '{}',
  sort_json TEXT NOT NULL DEFAULT '[]',
  columns_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_databases_owner_idx ON note_databases (owner_user_id);
CREATE TABLE IF NOT EXISTS note_db_rows (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_db_rows_db_idx ON note_db_rows (database_id);
`;

/** The columns updateNote may set (whitelist — a patch key outside this set is ignored). */
const UPDATABLE: readonly (keyof UpdateNotePatch)[] = [
  'title', 'icon', 'cover', 'parent_note_id', 'sensitivity', 'doc_json', 'favorite',
  'page_theme', 'freeform_mode', 'cover_image_artifact_id',
];

/**
 * Build a Postgres-backed {@link NoteRepository}. Pass a `pg.Pool` (share one across your app).
 *
 * @example
 * ```ts
 * import pg from 'pg';
 * const repo = createPostgresNoteRepository({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
 * await repo.createNote({ id: 'n1', owner_user_id: 'u1', title: 'Hello' });
 * const note = await repo.getNote('n1', 'u1');
 * ```
 */
export function createPostgresNoteRepository(opts: PostgresNoteRepositoryOptions): NoteRepository {
  const pool = opts.pool;
  const now = opts.now ?? monotonicClock();

  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (opts.ensureSchema === false) return Promise.resolve();
    return (ready ??= pool.query(SCHEMA_SQL).then(() => undefined));
  };

  const rowToNote = (r: Record<string, unknown>): Note => r as unknown as Note;

  return {
    async listNotes(userId, filter?: NoteListFilter) {
      await ensureSchema();
      const params: unknown[] = [userId];
      const where: string[] = ['owner_user_id = $1', 'is_template = 0'];
      where.push(filter?.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL');
      if (filter?.parentNoteId !== undefined) {
        if (filter.parentNoteId === null) where.push('parent_note_id IS NULL');
        else { params.push(filter.parentNoteId); where.push(`parent_note_id = $${params.length}`); }
      }
      if (filter?.favorite) where.push('favorite = 1');
      if (filter?.search) {
        params.push(escapeLike(filter.search));
        const p = params.length;
        where.push(`(title ILIKE '%' || $${p} || '%' ESCAPE '\\' OR doc_json ILIKE '%' || $${p} || '%' ESCAPE '\\')`);
      }
      params.push(filter?.limit ?? 100);
      const { rows } = await pool.query(
        `SELECT * FROM notes WHERE ${where.join(' AND ')} ORDER BY favorite DESC, updated_at DESC LIMIT $${params.length}`,
        params,
      );
      return rows.map(rowToNote);
    },

    async listTemplates() {
      await ensureSchema();
      const { rows } = await pool.query(`SELECT * FROM notes WHERE is_template = 1 ORDER BY title COLLATE "C" ASC`);
      return rows.map(rowToNote);
    },

    async getNote(id, userId) {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT * FROM notes WHERE id = $1 AND (owner_user_id = $2 OR owner_user_id = $3)`,
        [id, userId, SYSTEM_OWNER],
      );
      return rows.length ? rowToNote(rows[0]!) : null;
    },

    async createNote(input: CreateNoteInput) {
      await ensureSchema();
      const ts = now();
      await pool.query(
        `INSERT INTO notes (id, owner_user_id, tenant_id, title, icon, cover, parent_note_id, sensitivity,
           doc_json, is_template, template_key, favorite, page_theme, freeform_mode, cover_image_artifact_id,
           archived_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NULL,$16,$17)
         ON CONFLICT (id) DO NOTHING`,
        [
          input.id, input.owner_user_id, input.tenant_id ?? null, input.title, input.icon ?? null,
          input.cover ?? null, input.parent_note_id ?? null, input.sensitivity ?? 'normal',
          input.doc_json ?? DEFAULT_DOC, input.is_template ?? 0, input.template_key ?? null,
          input.favorite ?? 0, input.page_theme ?? 'pro', input.freeform_mode ?? 0,
          input.cover_image_artifact_id ?? null, ts, ts,
        ],
      );
    },

    async updateNote(id, userId, patch: UpdateNotePatch) {
      await ensureSchema();
      const keys = UPDATABLE.filter((k) => k in patch);
      if (keys.length === 0) return; // no-op patch = no-op
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const k of keys) { params.push((patch as Record<string, unknown>)[k]); sets.push(`${k} = $${params.length}`); }
      params.push(now()); sets.push(`updated_at = $${params.length}`);
      params.push(id); const idP = params.length;
      params.push(userId); const userP = params.length;
      await pool.query(`UPDATE notes SET ${sets.join(', ')} WHERE id = $${idP} AND owner_user_id = $${userP}`, params);
    },

    async archiveNote(id, userId, at) {
      await ensureSchema();
      const { rowCount } = await pool.query(
        `UPDATE notes SET archived_at = $3, updated_at = $4 WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NULL`,
        [id, userId, at, now()],
      );
      return (rowCount ?? 0) > 0;
    },

    async restoreNote(id, userId) {
      await ensureSchema();
      const { rowCount } = await pool.query(
        `UPDATE notes SET archived_at = NULL, updated_at = $3 WHERE id = $1 AND owner_user_id = $2 AND archived_at IS NOT NULL`,
        [id, userId, now()],
      );
      return (rowCount ?? 0) > 0;
    },

    async deleteNote(id, userId) {
      await ensureSchema();
      const client = await pool.connect();
      try {
        const { rows } = await client.query(`SELECT 1 FROM notes WHERE id = $1 AND owner_user_id = $2`, [id, userId]);
        if (!rows.length) return false;
        await client.query('BEGIN');
        // Cascade one level of sub-pages + their links (mirrors the in-memory reference).
        await client.query(
          `DELETE FROM note_links WHERE note_id IN (SELECT id FROM notes WHERE parent_note_id = $1 AND owner_user_id = $2)`,
          [id, userId],
        );
        await client.query(`DELETE FROM notes WHERE parent_note_id = $1 AND owner_user_id = $2`, [id, userId]);
        await client.query(`DELETE FROM note_links WHERE note_id = $1`, [id]);
        await client.query(`DELETE FROM notes WHERE id = $1`, [id]);
        await client.query('COMMIT');
        return true;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async listLinks(noteId) {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT * FROM note_links WHERE note_id = $1 ORDER BY created_at ASC`, [noteId],
      );
      return rows as unknown as NoteLink[];
    },

    async listBacklinks(targetKind: NoteLinkTargetKind, targetId) {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT * FROM note_links WHERE target_kind = $1 AND target_id = $2 ORDER BY created_at DESC`,
        [targetKind, targetId],
      );
      return rows as unknown as NoteLink[];
    },

    async createLink(input: CreateNoteLinkInput) {
      await ensureSchema();
      await pool.query(
        `INSERT INTO note_links (id, note_id, target_kind, target_id, created_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [input.id, input.note_id, input.target_kind, input.target_id, now()],
      );
    },

    async deleteLink(id, noteId) {
      await ensureSchema();
      await pool.query(`DELETE FROM note_links WHERE id = $1 AND note_id = $2`, [id, noteId]);
    },

    async listDatabases(userId) {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT * FROM note_databases WHERE owner_user_id = $1 ORDER BY name COLLATE "C" ASC`, [userId],
      );
      return rows as unknown as NoteDatabase[];
    },

    async getDatabase(id, userId) {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT * FROM note_databases WHERE id = $1 AND owner_user_id = $2`, [id, userId],
      );
      return rows.length ? (rows[0] as unknown as NoteDatabase) : null;
    },

    async createDatabase(input: CreateNoteDatabaseInput) {
      await ensureSchema();
      await pool.query(
        `INSERT INTO note_databases (id, owner_user_id, tenant_id, name, source, view_type, filter_json, sort_json, columns_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [
          input.id, input.owner_user_id, input.tenant_id ?? null, input.name, input.source ?? 'generic',
          input.view_type ?? 'table', input.filter_json ?? '{}', input.sort_json ?? '[]',
          input.columns_json ?? '[]', now(),
        ],
      );
    },

    async deleteDatabase(id, userId) {
      await ensureSchema();
      const client = await pool.connect();
      try {
        const { rows } = await client.query(`SELECT 1 FROM note_databases WHERE id = $1 AND owner_user_id = $2`, [id, userId]);
        if (!rows.length) return;
        await client.query('BEGIN');
        await client.query(`DELETE FROM note_db_rows WHERE database_id = $1`, [id]);
        await client.query(`DELETE FROM note_databases WHERE id = $1`, [id]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async listRows(databaseId) {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT * FROM note_db_rows WHERE database_id = $1 ORDER BY created_at ASC`, [databaseId],
      );
      return rows as unknown as NoteDbRow[];
    },

    async createRow(input: CreateNoteDbRowInput) {
      await ensureSchema();
      await pool.query(
        `INSERT INTO note_db_rows (id, database_id, fields_json, created_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [input.id, input.database_id, input.fields_json ?? '{}', now()],
      );
    },

    async updateRow(id, databaseId, fieldsJson) {
      await ensureSchema();
      await pool.query(`UPDATE note_db_rows SET fields_json = $3 WHERE id = $1 AND database_id = $2`, [id, databaseId, fieldsJson]);
    },

    async deleteRow(id, databaseId) {
      await ensureSchema();
      await pool.query(`DELETE FROM note_db_rows WHERE id = $1 AND database_id = $2`, [id, databaseId]);
    },
  };
}
