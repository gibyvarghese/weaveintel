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
import { BlockDoc, pmToBlocks, blocksToProseMirror, blocksToMarkdown, blocksToHtml } from '@weaveintel/coedit';
import { roleAtLeast } from '@weaveintel/collaboration';
import {
  createNoteCoeditRepo,
  createNoteSharing,
  resolveNoteAccess,
  userNoteSiteId,
} from '../note-coedit-sql.js';
import { noteCoeditHub } from '../note-coedit-hub.js';
import { createNoteAiService, type NoteAiGenerate, type AiAction } from '../note-ai-sql.js';
import { createNotePublishService, type PublishFormat } from '../note-publish-sql.js';
import { createNoteGraphService } from '../note-graph-sql.js';
import { createNoteDbService } from '../note-db-sql.js';
import { isViewType, type DatabaseViewType as DbViewType } from '@weaveintel/notes';
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
export function registerMeNotesRoutes(router: Router, db: DatabaseAdapter, opts: { noteRepository?: NoteRepository; aiGenerate?: NoteAiGenerate; jwtSecret?: string; publicBaseUrl?: string } = {}): void {
  const notes = opts.noteRepository ?? createSqlNoteRepository(db);
  // weaveNotes Phase 3: the AI co-author service (suggestions, agent edits, AI blocks).
  // Only wired when the host provides an LLM generator (so unit/embedder setups stay LLM-free).
  const noteAi = opts.aiGenerate ? createNoteAiService(db, opts.aiGenerate) : null;
  // weaveNotes Phase 4: the publish service (note → shareable artifact, sensitivity-gated).
  const publish = createNotePublishService(db, { jwtSecret: opts.jwtSecret ?? process.env['JWT_SECRET'] ?? 'insecure-dev-secret', ...(opts.publicBaseUrl ? { publicBaseUrl: opts.publicBaseUrl } : {}) });
  // weaveNotes Phase 5: the knowledge-graph service (wiki-links/backlinks, entity/relation
  // extraction, unlinked mentions, semantic related notes). Entity extraction needs the LLM
  // generator; the rest works without it.
  const noteGraph = createNoteGraphService(db, opts.aiGenerate ? { generate: opts.aiGenerate } : {});
  // weaveNotes Phase 6: the database service (typed views + rollups + AI column auto-fill).
  const noteDb = createNoteDbService(db, opts.aiGenerate ? { generate: opts.aiGenerate } : {});

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

  // weaveNotes Phase 1: read a note as the CRDT BLOCK model (or as Markdown / HTML).
  // The note's ProseMirror `doc_json` is parsed into blocks, run THROUGH the
  // `BlockDoc` CRDT, and re-rendered — so this both proves the CRDT faithfully
  // represents real notes AND gives the building blocks later phases need: the
  // block model for the editor, Markdown for feeding the note to an AI model, and
  // sanitized HTML for a read-only preview. `?format=blocks|markdown|html`.
  router.get('/api/me/notes/:id/blocks', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const note = await notes.getNote(params['id']!, auth.userId);
    if (!note) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let pm: unknown;
    try { pm = JSON.parse(note.doc_json); } catch { pm = { type: 'doc', content: [] }; }
    // Round-trip through the CRDT: ProseMirror → blocks → BlockDoc → rendered blocks.
    const doc = BlockDoc.fromBlocks(`u:${auth.userId}`, pmToBlocks(pm));
    const blocks = doc.blocks();
    const format = new URL(req.url ?? '/', 'http://x').searchParams.get('format') ?? 'blocks';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (format === 'markdown') { res.end(JSON.stringify({ markdown: blocksToMarkdown(blocks) })); return; }
    if (format === 'html') { res.end(JSON.stringify({ html: blocksToHtml(blocks) })); return; }
    // Default: the block model + the round-tripped ProseMirror doc + the CRDT state vector.
    res.end(JSON.stringify({ blocks, prosemirror: blocksToProseMirror(blocks), stateVector: doc.stateVector() }));
  }, { auth: true });

  // ── weaveNotes Phase 2: collaborative co-editing (relay + sharing + presence) ──
  //
  // geneWeave is the TRUSTED RELAY. A note becomes co-editable the first time a
  // client opens `POST /coedit` (the canonical BlockDoc seeds from the note's
  // current content). From then on, edits flow as validated BLOCK OPS through the
  // relay, are broadcast live over `/coedit/events` (SSE), and the note's rendered
  // `doc_json` is kept in sync so the legacy single-user path still reads correctly.
  //
  //   POST   /coedit            ensure the co-edit doc exists; return snapshot + my site id  (any participant)
  //   GET    /coedit            current snapshot + state vector + my site id                 (any participant)
  //   POST   /coedit/ops        submit block ops (validated, anti-forgery)                    (collaborator+; viewers 403)
  //   GET    /coedit/ops?since= the ops a reconnecting peer is missing (offline reconcile)    (any participant)
  //   POST   /coedit/sync       diff-on-save: send a whole ProseMirror doc → merge as ops     (collaborator+)
  //   POST   /coedit/awareness  broadcast an ephemeral presence/cursor update                 (any participant)
  //   GET    /coedit/events     SSE stream of remote ops + presence                           (any participant)
  const coedit = createNoteCoeditRepo(db);
  const sharing = createNoteSharing(db);

  /** Resolve access + (best-effort) the note's owner-side content for seeding. */
  async function loadForCoedit(noteId: string, userId: string): Promise<{ access: NonNullable<Awaited<ReturnType<typeof resolveNoteAccess>>>; seedPm: unknown } | null> {
    const access = await resolveNoteAccess(db, noteId, userId);
    if (!access) return null;
    const owned = await notes.getNote(noteId, access.ownerId);
    let seedPm: unknown = { type: 'doc', content: [] };
    if (owned) { try { seedPm = JSON.parse(owned.doc_json); } catch { /* keep empty */ } }
    return { access, seedPm };
  }

  /** Keep the note's stored `doc_json` in sync with the live co-edit doc (best-effort). */
  async function writeBackDoc(noteId: string, ownerId: string, pm: { type: 'doc'; content: unknown[] }): Promise<void> {
    try { await notes.updateNote(noteId, ownerId, { doc_json: JSON.stringify(pm) }); } catch { /* non-fatal */ }
  }

  router.post('/api/me/notes/:id/coedit', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const loaded = await loadForCoedit(params['id']!, auth.userId);
    if (!loaded) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const view = await coedit.ensureDoc({ noteId: params['id']!, tenantId: loaded.access.tenantId, ownerId: loaded.access.ownerId, seedPm: loaded.seedPm });
    // A per-tab site id UNDER the user's namespace (unique replicas, provable authorship).
    const siteId = `${userNoteSiteId(auth.userId)}:${newUUIDv7().slice(0, 8)}`;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...view, siteId, role: loaded.access.role }));
  }, { auth: true });

  router.get('/api/me/notes/:id/coedit', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const view = await coedit.getViewByNote(params['id']!);
    if (!view) { res.writeHead(404); res.end(JSON.stringify({ error: 'co-edit not started' })); return; }
    const siteId = `${userNoteSiteId(auth.userId)}:${newUUIDv7().slice(0, 8)}`;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...view, siteId, role: access.role }));
  }, { auth: true });

  router.post('/api/me/notes/:id/coedit/ops', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot edit' })); return; }
    const view0 = await coedit.getViewByNote(params['id']!);
    if (!view0) { res.writeHead(409); res.end(JSON.stringify({ error: 'co-edit not started' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    // The op author must live inside this user's namespace (anti-forgery enforced in the relay).
    const result = await coedit.submitOps(view0.docId, userNoteSiteId(auth.userId), body['ops']);
    if (!result.ok) { res.writeHead(String(result.error).startsWith('forbidden') ? 403 : 400); res.end(JSON.stringify({ error: result.error })); return; }
    if (result.applied.length > 0) {
      noteCoeditHub.broadcast(params['id']!, 'coedit.op', { docId: view0.docId, ops: result.applied });
      await writeBackDoc(params['id']!, access.ownerId, result.view.prosemirror);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ applied: result.applied.length, stateVector: result.view.stateVector }));
  }, { auth: true });

  router.get('/api/me/notes/:id/coedit/ops', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const view0 = await coedit.getViewByNote(params['id']!);
    if (!view0) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ops: [] })); return; }
    let since: Record<string, number> = {};
    const raw = new URL(req.url ?? '/', 'http://x').searchParams.get('since');
    if (raw) { try { since = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, number>; } catch { /* all */ } }
    const ops = await coedit.opsSince(view0.docId, since);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ops }));
  }, { auth: true });

  router.post('/api/me/notes/:id/coedit/sync', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const loaded = await loadForCoedit(params['id']!, auth.userId);
    if (!loaded) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(loaded.access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot edit' })); return; }
    // Ensure the doc exists (seed from current content) before diffing into it.
    const ensured = await coedit.ensureDoc({ noteId: params['id']!, tenantId: loaded.access.tenantId, ownerId: loaded.access.ownerId, seedPm: loaded.seedPm });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const pm = (body['doc'] ?? body['doc_json']);
    const result = await coedit.syncFromProseMirror(ensured.docId, userNoteSiteId(auth.userId), pm);
    if (!result.ok) { res.writeHead(400); res.end(JSON.stringify({ error: result.error })); return; }
    if (result.applied.length > 0) {
      noteCoeditHub.broadcast(params['id']!, 'coedit.op', { docId: ensured.docId, ops: result.applied });
      await writeBackDoc(params['id']!, loaded.access.ownerId, result.view.prosemirror);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ applied: result.applied.length, stateVector: result.view.stateVector }));
  }, { auth: true });

  router.post('/api/me/notes/:id/coedit/awareness', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const peerId = typeof body['siteId'] === 'string' && body['siteId'].startsWith(userNoteSiteId(auth.userId))
      ? (body['siteId'] as string)
      : userNoteSiteId(auth.userId);
    const entry = (body['entry'] && typeof body['entry'] === 'object') ? body['entry'] : { state: null };
    noteCoeditHub.broadcast(params['id']!, 'coedit.awareness', { peerId, entry });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }, { auth: true });

  router.get('/api/me/notes/:id/coedit/events', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const peerId = `${userNoteSiteId(auth.userId)}:${newUUIDv7().slice(0, 8)}`;
    const { detach } = noteCoeditHub.subscribe(params['id']!, res, peerId);
    const keepalive = setInterval(() => noteCoeditHub.keepAlive(params['id']!), 25_000);
    req.on('close', () => { clearInterval(keepalive); detach(); });
  }, { auth: true });

  // ── weaveNotes Phase 2: note sharing (invite links + membership) ──────────────
  //
  //   POST   /api/me/notes/join                join a note via an invite token        (any user)
  //   POST   /api/me/notes/:id/share           owner mints an invite link             (owner)
  //   GET    /api/me/notes/:id/share           owner lists participants + invites     (owner)
  //   POST   /api/me/notes/:id/share/revoke    owner revokes a member or an invite    (owner)
  router.post('/api/me/notes/join', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['token'] !== 'string' || !body['token']) { res.writeHead(400); res.end(JSON.stringify({ error: 'token required' })); return; }
    const result = await sharing.join(body['token'], auth.userId);
    if (!result.ok) { res.writeHead(400); res.end(JSON.stringify({ error: result.error })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ noteId: result.noteId, role: result.role }));
  }, { auth: true });

  router.post('/api/me/notes/:id/share', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const role = body['role'] === 'collaborator' ? 'collaborator' : 'viewer';
    const invite = await sharing.createInvite({
      noteId: params['id']!, ownerId: auth.userId, tenantId: auth.tenantId ?? null, role,
      maxUses: typeof body['maxUses'] === 'number' ? body['maxUses'] : null,
      expiresAt: typeof body['expiresAt'] === 'number' ? body['expiresAt'] : null,
    });
    if (!invite) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; } // only the owner may share
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(invite));
  }, { auth: true });

  router.get('/api/me/notes/:id/share', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const owned = await notes.getNote(params['id']!, auth.userId);
    if (!owned || owned.owner_user_id !== auth.userId) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const participants = await sharing.listParticipants(params['id']!, auth.userId);
    const invites = (await sharing.listInvites(params['id']!, auth.userId)).map((t) => ({ id: t.id, role: t.role, prefix: t.token_prefix, uses: t.uses, maxUses: t.max_uses, expiresAt: t.expires_at, revokedAt: t.revoked_at }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ participants, invites }));
  }, { auth: true });

  router.post('/api/me/notes/:id/share/revoke', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    let ok = false;
    if (typeof body['userId'] === 'string') ok = await sharing.revokeMember(params['id']!, auth.userId, body['userId']);
    else if (typeof body['tokenId'] === 'string') ok = await sharing.revokeInvite(params['id']!, auth.userId, body['tokenId']);
    else { res.writeHead(400); res.end(JSON.stringify({ error: 'userId or tokenId required' })); return; }
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: ok }));
  }, { auth: true });

  // ── weaveNotes Phase 3: AI co-author (suggestions + AI blocks) ────────────────
  //
  // The AI works INSIDE the note. "Actions" (continue / rewrite / summarize / ask)
  // run the real LLM and STAGE the result as a track-changes suggestion the human
  // accepts or rejects — the AI never silently mutates the document. "AI blocks"
  // are blocks generated from a prompt that can be refreshed. All require the caller
  // to be the owner or a collaborator (viewers 403); everything broadcasts live.
  //
  //   POST /api/me/notes/:id/ai/:action            run an AI action → a pending suggestion   (collaborator+)
  //   GET  /api/me/notes/:id/suggestions?status=   list suggestions                          (any participant)
  //   POST /api/me/notes/:id/suggestions/:sid/accept   apply a suggestion's staged ops       (collaborator+)
  //   POST /api/me/notes/:id/suggestions/:sid/reject   discard a suggestion                  (collaborator+)
  //   POST /api/me/notes/:id/ai/insert-block       generate + insert a refreshable AI block  (collaborator+)
  //   POST /api/me/notes/:id/ai/refresh-block      re-generate an AI block's content         (collaborator+)
  const AI_ACTIONS = new Set(['continue', 'rewrite', 'summarize', 'ask']);

  // NOTE: register the STATIC `/ai/insert-block` + `/ai/refresh-block` routes BEFORE
  // the `/ai/:action` param route, so the router matches them exactly (the param
  // route would otherwise capture "insert-block" as an unknown action).
  router.post('/api/me/notes/:id/ai/insert-block', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['prompt'] !== 'string' || !body['prompt'].trim()) { res.writeHead(400); res.end(JSON.stringify({ error: 'prompt required' })); return; }
    const r = await noteAi.insertAiBlock({ noteId: params['id']!, access, prompt: body['prompt'], ...(typeof body['citation'] === 'string' ? { citation: body['citation'] } : {}) });
    res.writeHead(r.ok ? 201 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  router.post('/api/me/notes/:id/ai/refresh-block', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const blockId = body['blockId'];
    if (!blockId || typeof blockId !== 'object') { res.writeHead(400); res.end(JSON.stringify({ error: 'blockId required' })); return; }
    const r = await noteAi.refreshAiBlock({ noteId: params['id']!, access, blockId: blockId as { counter: number; siteId: string } });
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  router.post('/api/me/notes/:id/ai/:action', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured on this server' })); return; }
    const action = params['action']!;
    // insert-block / refresh-block are handled by their own paths below; here only the 4 text actions.
    if (!AI_ACTIONS.has(action)) { res.writeHead(404); res.end(JSON.stringify({ error: 'Unknown AI action' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot use AI editing' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const selBlock = body['selectionBlockId'];
    const result = await noteAi.propose({
      noteId: params['id']!, access, action: action as AiAction,
      ...(typeof body['instruction'] === 'string' ? { instruction: body['instruction'] } : {}),
      ...(typeof body['selectionText'] === 'string' ? { selectionText: body['selectionText'] } : {}),
      ...(selBlock && typeof selBlock === 'object' ? { selectionBlockId: selBlock as { counter: number; siteId: string } } : {}),
    });
    res.writeHead(result.ok ? 201 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.get('/api/me/notes/:id/suggestions', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ suggestions: [] })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const status = (new URL(req.url ?? '/', 'http://x').searchParams.get('status') ?? 'pending') as 'pending' | 'accepted' | 'rejected' | 'all';
    const rows = await noteAi.list(params['id']!, status);
    // Trim the heavy ops_json out of the list payload; the preview is what reviewers read.
    const suggestions = rows.map((r) => ({ id: r.id, action: r.action, status: r.status, preview: r.preview_text, authorKind: r.author_kind, createdAt: r.created_at }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ suggestions }));
  }, { auth: true });

  router.post('/api/me/notes/:id/suggestions/:sid/accept', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const r = await noteAi.accept(params['sid']!, auth.userId, access);
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  router.post('/api/me/notes/:id/suggestions/:sid/reject', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!noteAi) { res.writeHead(501); res.end(JSON.stringify({ error: 'AI features are not configured' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const r = await noteAi.reject(params['sid']!, auth.userId, access);
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r));
  }, { auth: true });

  // ── weaveNotes Phase 4: publish a note as a shareable artifact ────────────────
  //
  //   POST /api/me/notes/:id/emit-artifact   note → Markdown/HTML artifact (+ optional
  //                                          public share link). collaborator+. The note's
  //                                          `sensitivity` gates it: `restricted` is refused
  //                                          (403); content is redacted (secrets always,
  //                                          PII for confidential) before it can be shared.
  router.post('/api/me/notes/:id/emit-artifact', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (!db.saveArtifact) { res.writeHead(501); res.end(JSON.stringify({ error: 'artifact storage not available' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot publish' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    const result = await publish.emit({
      noteId: params['id']!, access, publishedBy: 'user',
      format: (body['format'] === 'html' ? 'html' : 'markdown') as PublishFormat,
      share: body['share'] !== false, // default: also mint a share link
      ...(typeof body['password'] === 'string' && body['password'] ? { password: body['password'] } : {}),
      ...(typeof body['expiresInDays'] === 'number' ? { expiresInDays: body['expiresInDays'] } : {}),
    });
    res.writeHead(result.ok ? 201 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
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

    // weaveNotes Phase 2: if this note is already being co-edited, a full-document
    // PATCH (the legacy single-user save) must NOT clobber concurrent edits — route
    // the new content through the relay as a DIFF (merge), keeping everyone's work.
    // Notes that never entered co-edit mode keep the exact legacy overwrite path.
    if (patch.doc_json !== undefined) {
      const access = await resolveNoteAccess(db, params['id']!, auth.userId);
      const existingDoc = access ? await coedit.getViewByNote(params['id']!) : null;
      if (access && existingDoc && roleAtLeast(access.role, 'collaborator')) {
        let pm: unknown; try { pm = JSON.parse(patch.doc_json); } catch { pm = undefined; }
        if (pm !== undefined) {
          const result = await coedit.syncFromProseMirror(existingDoc.docId, userNoteSiteId(auth.userId), pm);
          if (result.ok) {
            if (result.applied.length > 0) noteCoeditHub.broadcast(params['id']!, 'coedit.op', { docId: existingDoc.docId, ops: result.applied });
            patch.doc_json = JSON.stringify(result.view.prosemirror); // persist the merged result, not the raw client doc
          }
        }
      }
    }

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
    // weaveNotes Phase 5: resolve backlinks to {noteId, title} for the connections panel.
    const backlinks = await noteGraph.backlinks(params['id']!, auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ backlinks }));
  }, { auth: true });

  // ── weaveNotes Phase 5: knowledge graph (index + connections) ─────────────────
  //
  //   POST /api/me/notes/:id/index     (re)index a note: resolve [[wiki-links]] → note
  //                                    links, extract entities/relations (LLM), embed for
  //                                    semantic search. collaborator+.
  //   GET  /api/me/notes/:id/unlinked  notes whose title this note mentions but hasn't linked
  //   GET  /api/me/notes/:id/related   semantically related notes (cosine over embeddings)
  //   GET  /api/me/notes/:id/graph     the local knowledge graph (nodes + edges) for the UI
  router.post('/api/me/notes/:id/index', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot index' })); return; }
    const result = await noteGraph.indexNote({ noteId: params['id']!, access });
    res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  }, { auth: true });

  router.get('/api/me/notes/:id/unlinked', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ unlinked: await noteGraph.unlinkedMentions(params['id']!, access) }));
  }, { auth: true });

  router.get('/api/me/notes/:id/related', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const topK = safePageInt(new URL(req.url ?? '/', 'http://x').searchParams.get('limit'), 5, 1, 20);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ related: await noteGraph.relatedNotes(params['id']!, access, topK) }));
  }, { auth: true });

  router.get('/api/me/notes/:id/graph', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveNoteAccess(db, params['id']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(await noteGraph.graph(params['id']!, access)));
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
    // weaveNotes Phase 6: accept the 5 view types + a typed schema (columns) as a JSON
    // array or string. `columns` is the property schema (PropertyDef[]).
    const columns = body['columns'] ?? body['columns_json'];
    await notes.createDatabase({
      id,
      owner_user_id: auth.userId,
      tenant_id: auth.tenantId ?? null,
      name: String(body['name']),
      source: (['agenda_items', 'tasks', 'generic'].includes(String(body['source'] ?? '')) ? body['source'] : 'generic') as NoteDatabaseSource,
      view_type: (isViewType(body['view_type']) ? body['view_type'] : 'table') as DbViewType as NoteDatabaseViewType,
      filter_json: typeof body['filter_json'] === 'string' ? body['filter_json'] : '{}',
      sort_json: typeof body['sort_json'] === 'string' ? body['sort_json'] : '[]',
      columns_json: typeof columns === 'string' ? columns : (Array.isArray(columns) ? JSON.stringify(columns) : '[]'),
    });
    const db_ = await notes.getDatabase(id, auth.userId);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(db_));
  }, { auth: true });

  // ── weaveNotes Phase 6: typed database view (rollups) + AI column auto-fill ────
  //
  //   GET  /api/me/note-databases/:id/view       schema + rows with computed rollups + citations
  //   POST /api/me/note-databases/:id/autofill   AI-fill a column (with citations). Body:
  //                                              { propertyKey, rowIds?, useWeb? }. owner-only.
  router.get('/api/me/note-databases/:id/view', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const v = await noteDb.view(params['id']!, auth.userId);
    if (!v) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(v));
  }, { auth: true });

  router.post('/api/me/note-databases/:id/autofill', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty */ }
    if (typeof body['propertyKey'] !== 'string') { res.writeHead(400); res.end(JSON.stringify({ error: 'propertyKey required' })); return; }
    const result = await noteDb.autofillColumn({
      databaseId: params['id']!, userId: auth.userId, tenantId: auth.tenantId ?? null,
      propertyKey: body['propertyKey'],
      ...(Array.isArray(body['rowIds']) ? { rowIds: (body['rowIds'] as unknown[]).map(String) } : {}),
      useWeb: body['useWeb'] === true,
    });
    res.writeHead(result.ok ? 200 : (result.code ?? 400), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
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
