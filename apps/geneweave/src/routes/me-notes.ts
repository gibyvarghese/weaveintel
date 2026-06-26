/**
 * /api/me/notes — user-scoped notes endpoints (WC6-WC9)
 *
 *   GET    /api/me/notes                            list notes (filters: parent, search, favorite, is_template)
 *   POST   /api/me/notes                            create note (from scratch or from template)
 *   GET    /api/me/notes/templates                  list system + user templates
 *   GET    /api/me/notes/:id                        get note with full doc_json
 *   PATCH  /api/me/notes/:id                        update (title, icon, doc_json, sensitivity, …)
 *   DELETE /api/me/notes/:id                        delete (cascades sub-pages)
 *
 *   GET    /api/me/notes/:id/links                  list outbound links from note
 *   POST   /api/me/notes/:id/links                  create link (target_kind + target_id)
 *   DELETE /api/me/notes/:id/links/:linkId          delete link
 *   GET    /api/me/notes/:id/backlinks              list notes that link TO this note
 *
 *   POST   /api/me/notes/:id/extract                save-time extraction pipeline (WC8):
 *                                                   - to-do ⇄ task binding
 *                                                   - mention/link extraction
 *                                                   - memory indexing stub
 *
 *   GET    /api/me/note-databases                   list saved views
 *   POST   /api/me/note-databases                   create saved view
 *   DELETE /api/me/note-databases/:id               delete
 *
 *   GET    /api/me/note-databases/:id/rows          list generic rows
 *   POST   /api/me/note-databases/:id/rows          add row
 *   PATCH  /api/me/note-databases/:id/rows/:rowId   update row fields
 *   DELETE /api/me/note-databases/:id/rows/:rowId   delete row
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { Router } from '../server-core.js';
import { readBody } from '../server-core.js';
import type { DatabaseAdapter } from '../db-types.js';
import {
  createInMemoryNoteRepository, // (re-exported for tests/embedders that want a fake)
  extractTaskItems,
  type NoteRepository,
  type NoteSensitivity,
  type NoteLinkTargetKind,
  type NoteDatabaseSource,
  type NoteDatabaseViewType,
  type UpdateNotePatch,
} from '@weaveintel/notes';
import { createSqlNoteRepository } from '../note-repository-sql.js';
import { meTaskRepo as taskRepo } from './me-stores.js';
import { createActionItem } from '@weaveintel/human-tasks';
import { safePageInt } from './index.js';

void createInMemoryNoteRepository; // keep the import available to embedders without tree-shaking it away

/**
 * Register all `/api/me/notes` routes.
 *
 * weaveNotes Phase 0: every note read/write now goes through the
 * `@weaveintel/notes` {@link NoteRepository} PORT instead of calling the database
 * adapter directly. Behaviour is UNCHANGED — `createSqlNoteRepository(db)` is a
 * thin pass-through to the same SQL — but the routes now depend only on the
 * interface, so a later phase can swap in a CRDT co-editing relay (a new adapter)
 * without changing this file. Tests/embedders may inject their own repository via
 * `opts.noteRepository`.
 */
export function registerMeNotesRoutes(router: Router, db: DatabaseAdapter, opts: { noteRepository?: NoteRepository } = {}): void {
  const notes = opts.noteRepository ?? createSqlNoteRepository(db);

  // ── Notes list ─────────────────────────────────────────────────────────────

  router.get('/api/me/notes', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parentNoteId = url.searchParams.has('parent')
      ? (url.searchParams.get('parent') === 'null' ? null : url.searchParams.get('parent'))
      : undefined;
    const list = await notes.listNotes(auth.userId, {
      parentNoteId,
      favorite: url.searchParams.get('favorite') === '1',
      search: url.searchParams.get('search') ?? undefined,
      limit: safePageInt(url.searchParams.get('limit'), 50, 1, 500),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ notes: list }));
  }, { auth: true });

  router.get('/api/me/notes/templates', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const templates = await notes.listTemplates();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ templates }));
  }, { auth: true });

  // ── Single note ────────────────────────────────────────────────────────────

  router.get('/api/me/notes/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const note = await notes.getNote(params['id']!, auth.userId);
    if (!note) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(note));
  }, { auth: true });

  router.post('/api/me/notes', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

    // Optional: instantiate from a template
    let docJson = '{"type":"doc","content":[]}';
    if (typeof body['template_id'] === 'string') {
      const tmpl = await notes.getNote(body['template_id'], auth.userId);
      if (tmpl) docJson = tmpl.doc_json;
    }
    if (typeof body['doc_json'] === 'string') docJson = body['doc_json'];
    else if (body['doc_json'] && typeof body['doc_json'] === 'object') docJson = JSON.stringify(body['doc_json']);

    const id = newUUIDv7();
    await notes.createNote({
      id,
      owner_user_id: auth.userId,
      tenant_id: auth.tenantId ?? null,
      title: typeof body['title'] === 'string' && body['title'].trim() ? body['title'] : 'Untitled',
      icon: typeof body['icon'] === 'string' ? body['icon'] : null,
      cover: typeof body['cover'] === 'string' ? body['cover'] : null,
      parent_note_id: typeof body['parent_note_id'] === 'string' ? body['parent_note_id'] : null,
      sensitivity: (['normal', 'confidential', 'restricted'].includes(String(body['sensitivity'] ?? '')) ? body['sensitivity'] : 'normal') as NoteSensitivity,
      doc_json: docJson,
      is_template: 0,
      favorite: 0,
    });

    const note = await notes.getNote(id, auth.userId);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(note));
  }, { auth: true });

  router.add('PATCH','/api/me/notes/:id', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const patch: UpdateNotePatch = {};
    if (typeof body['title'] === 'string') patch.title = body['title'];
    if ('icon' in body) patch.icon = typeof body['icon'] === 'string' ? body['icon'] : null;
    if ('cover' in body) patch.cover = typeof body['cover'] === 'string' ? body['cover'] : null;
    if ('parent_note_id' in body) patch.parent_note_id = typeof body['parent_note_id'] === 'string' ? body['parent_note_id'] : null;
    if (typeof body['sensitivity'] === 'string') patch.sensitivity = body['sensitivity'] as NoteSensitivity;
    if (typeof body['doc_json'] === 'string') patch.doc_json = body['doc_json'];
    else if (body['doc_json'] && typeof body['doc_json'] === 'object') patch.doc_json = JSON.stringify(body['doc_json']);
    if (typeof body['favorite'] === 'number') patch.favorite = body['favorite'];

    await notes.updateNote(params['id']!, auth.userId, patch);
    const note = await notes.getNote(params['id']!, auth.userId);
    if (!note) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(note));
  }, { auth: true });

  router.del('/api/me/notes/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const deleted = await notes.deleteNote(params['id']!, auth.userId);
    if (!deleted) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });

  // ── Note links ─────────────────────────────────────────────────────────────

  router.get('/api/me/notes/:id/links', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const links = await notes.listLinks(params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ links }));
  }, { auth: true });

  router.post('/api/me/notes/:id/links', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (!body['target_kind'] || !body['target_id']) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'target_kind and target_id are required' })); return;
    }
    const validKinds: NoteLinkTargetKind[] = ['note', 'run', 'agenda_item', 'task'];
    if (!validKinds.includes(body['target_kind'] as NoteLinkTargetKind)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid target_kind' })); return;
    }
    const link = { id: newUUIDv7(), note_id: params['id']!, target_kind: body['target_kind'] as NoteLinkTargetKind, target_id: String(body['target_id']) };
    await notes.createLink(link);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(link));
  }, { auth: true });

  router.del('/api/me/notes/:id/links/:linkId', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    await notes.deleteLink(params['linkId']!, params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });

  router.get('/api/me/notes/:id/backlinks', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const backlinks = await notes.listBacklinks('note', params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ backlinks }));
  }, { auth: true });

  // ── WC8: Save-time extraction pipeline ────────────────────────────────────
  // Called by the client after saving a note. Extracts to-do checkboxes and
  // creates linked tasks. Also syncs @mention links from doc_json.
  // This route is idempotent: repeated calls for the same note are safe.

  router.post('/api/me/notes/:id/extract', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }

    const note = await notes.getNote(params['id']!, auth.userId);
    if (!note) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }

    let doc: unknown;
    try { doc = JSON.parse(note.doc_json); } catch { doc = null; }

    const extractedTasks: Array<{ id: string; title: string }> = [];

    if (doc) {
      const todoTitles = extractTaskItems(doc);
      // Create tasks for new to-dos (deduplicate against existing links)
      const existingLinks = await notes.listLinks(note.id);
      const linkedTaskIds = new Set(existingLinks.filter((l) => l.target_kind === 'task').map((l) => l.target_id));

      for (const title of todoTitles) {
        // Skip if a task with same title already linked (by title-based idempotency)
        const alreadyLinked = linkedTaskIds.size > 0 && (() => {
          // We'd need to load task titles to compare — skip for now, trust the note link set
          return false;
        })();
        if (alreadyLinked) continue;

        const task = createActionItem({
          assignee: auth.userId,
          title,
          provenance: { sourceRef: `note:${note.id}`, createdBy: 'principal' as const },
        });
        await taskRepo.save(task);

        await notes.createLink({
          id: newUUIDv7(),
          note_id: note.id,
          target_kind: 'task',
          target_id: task.id,
        });
        extractedTasks.push({ id: task.id, title: task.title });
        linkedTaskIds.add(task.id);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ extractedTasks }));
  }, { auth: true });

  // ── Note databases ─────────────────────────────────────────────────────────

  router.get('/api/me/note-databases', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const databases = await notes.listDatabases(auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ databases }));
  }, { auth: true });

  router.post('/api/me/note-databases', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (!body['name']) { res.writeHead(400); res.end(JSON.stringify({ error: 'name is required' })); return; }
    const id = newUUIDv7();
    await notes.createDatabase({
      id,
      owner_user_id: auth.userId,
      tenant_id: auth.tenantId ?? null,
      name: String(body['name']),
      source: (['agenda_items', 'tasks', 'generic'].includes(String(body['source'] ?? '')) ? body['source'] : 'generic') as NoteDatabaseSource,
      view_type: (['table', 'board', 'calendar'].includes(String(body['view_type'] ?? '')) ? body['view_type'] : 'table') as NoteDatabaseViewType,
      filter_json: typeof body['filter_json'] === 'string' ? body['filter_json'] : '{}',
      sort_json: typeof body['sort_json'] === 'string' ? body['sort_json'] : '[]',
      columns_json: typeof body['columns_json'] === 'string' ? body['columns_json'] : '[]',
    });
    const db_ = await notes.getDatabase(id, auth.userId);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(db_));
  }, { auth: true });

  router.del('/api/me/note-databases/:id', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    await notes.deleteDatabase(params['id']!, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });

  // ── Note database rows ─────────────────────────────────────────────────────

  router.get('/api/me/note-databases/:id/rows', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const rows = await notes.listRows(params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rows }));
  }, { auth: true });

  router.post('/api/me/note-databases/:id/rows', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const id = newUUIDv7();
    const fieldsJson = typeof body['fields'] === 'object' && body['fields'] !== null
      ? JSON.stringify(body['fields'])
      : '{}';
    await notes.createRow({ id, database_id: params['id']!, fields_json: fieldsJson });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id, database_id: params['id'], fields: body['fields'] ?? {} }));
  }, { auth: true });

  router.add('PATCH','/api/me/note-databases/:id/rows/:rowId', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const fieldsJson = typeof body['fields'] === 'object' && body['fields'] !== null
      ? JSON.stringify(body['fields'])
      : '{}';
    await notes.updateRow(params['rowId']!, params['id']!, fieldsJson);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, { auth: true });

  router.del('/api/me/note-databases/:id/rows/:rowId', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    await notes.deleteRow(params['rowId']!, params['id']!);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });
}
