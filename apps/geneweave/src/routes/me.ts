/**
 * /api/me — User-scope API routes
 *
 * Provides interaction-model-agnostic endpoints for the weaveIntel platform:
 *
 *   Runs:
 *     POST   /api/me/runs                        create a new run
 *     GET    /api/me/runs                        list user's runs (filterable)
 *     GET    /api/me/runs/:runId                 get run record
 *     GET    /api/me/runs/:runId/events          SSE event stream (resumable)
 *     POST   /api/me/runs/:runId/events          post a client-originated event
 *     POST   /api/me/runs/:runId/cancel          cancel a running run
 *
 *   Catalog:
 *     GET    /api/me/catalog?surface=<id>        surface catalog for the caller
 *
 *   Theme:
 *     GET    /api/me/theme                       per-tenant design tokens
 *
 *   Tasks:
 *     GET    /api/me/tasks                       list action-item tasks
 *     POST   /api/me/tasks                       create action-item
 *     POST   /api/me/tasks/:taskId/complete      complete a task
 *     POST   /api/me/tasks/:taskId/cancel        cancel a task
 *
 *   Reminders:
 *     GET    /api/me/reminders                   list reminders
 *     POST   /api/me/reminders                   create a reminder trigger
 *     POST   /api/me/reminders/:id/reschedule    reschedule a one-shot reminder
 *     DELETE /api/me/reminders/:id               delete a reminder
 *
 *   Devices & notifications:
 *     POST   /api/me/devices                     register a push device
 *     DELETE /api/me/devices/:token              unregister a device
 *     GET    /api/me/notification-preferences    get preferences
 *     PUT    /api/me/notification-preferences    update preferences
 *
 * Chat compatibility shim (permanent — no deprecation):
 *   /api/chats endpoints are handled in routes/chat.ts and MUST remain.
 *
 * Vocabulary: no "chat", "conversation", "message" (HTTP sense), "turn"
 * in this file's public API surface.
 */

import { newUUIDv7, weaveContext } from '@weaveintel/core';
import { createActionItem, completeActionItem, cancelActionItem } from '@weaveintel/human-tasks';
import { createReminderTrigger, rescheduleReminder } from '@weaveintel/triggers';
import type { Router } from '../server-core.js';
import { readBody } from '../server-core.js';
import type { DatabaseAdapter } from '../db-types.js';
import { createMeCatalogResolver } from '../me-catalog.js';
import { resolveTenantThemeTokens } from '../tenant-theme.js';
import type { SurfaceCatalogResolver } from '@weaveintel/core';
import type { NotificationsHub } from '../notifications-wiring.js';
import { meTaskRepo as taskRepo, meTriggerStore as triggerStore } from './me-stores.js';
import { safePageInt } from './index.js';
import { MeRunExecutor, isTerminalRunStatus } from '../me-run-executor.js';
import { loadRunStreamConfig, clientStreamConfig } from '../chat-run-stream-utils.js';
import { runApprovals } from '../me-run-approvals.js';
import { createSqlRunJournal } from '../run-substrate-sql.js';
import { createSqlPresenceManager, withAgentPeer } from '../presence-sql.js';
import { loadCollaborationConfig, clientCollabConfig } from '../collab-config.js';
import { resolveRunAccess, createSqlSessionManager, mintShareToken, hashShareToken, annotatePresenceRoles } from '../shared-session-sql.js';
import { roleAtLeast, type SessionRole } from '@weaveintel/collaboration';

/**
 * Register all /api/me routes on the provided router.
 *
 * @param router   The server Router instance
 * @param db       DatabaseAdapter (for runs, devices, prefs)
 * @param opts.runExecutor  Optional run executor. When supplied, `POST
 *   /api/me/runs` dispatches the run (producing live events) and the SSE
 *   stream live-tails appended events. When omitted, the run surface degrades
 *   to the historical record-only behaviour (create + manual events) so tests
 *   and embedded callers keep working with no executor wired.
 */
export function registerMeRoutes(
  router: Router,
  db: DatabaseAdapter,
  opts: {
    catalogResolver?: SurfaceCatalogResolver;
    notifications?: NotificationsHub;
    runExecutor?: MeRunExecutor;
  } = {},
): void {

  const catalogResolver = opts.catalogResolver ?? createMeCatalogResolver(db);
  const notifications = opts.notifications;
  // A no-producing executor still provides the per-run SSE bus + serialized
  // append path, so the live-tail + resumable contract holds even when no
  // agent is wired (e.g. unit tests, embedded callers).
  const runExecutor = opts.runExecutor ?? new MeRunExecutor({ db });

  // ─── Runs ───────────────────────────────────────────────────────────────

  router.post('/api/me/runs', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

    // Idempotency: check Idempotency-Key header
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? undefined;
    if (idempotencyKey) {
      const existing = await db.getIdempotencyRecordByKey(idempotencyKey);
      if (existing) {
        const run = await db.getUserRun(existing.result_json ?? '', auth.userId);
        if (run) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(run));
          return;
        }
      }
    }

    const runId = newUUIDv7();
    await db.createUserRun({
      id: runId,
      user_id: auth.userId,
      status: 'pending',
      ...(auth.tenantId ? { tenant_id: auth.tenantId } : {}),
      ...(typeof body['surface'] === 'string' ? { surface: body['surface'] } : {}),
      ...(body['metadata'] !== undefined ? { metadata: JSON.stringify(body['metadata']) } : {}),
    });

    if (idempotencyKey) {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db.createIdempotencyRecord({
        id: newUUIDv7(),
        key: idempotencyKey,
        result_json: runId,
        expires_at: expiresAt,
      });
    }

    const run = await db.getUserRun(runId, auth.userId);

    // SP3: dispatch the run through the executor (non-blocking). The response
    // returns immediately; the run produces events + flips status in the
    // background. When no producing agent is wired the executor is a no-op and
    // the run stays `pending` (record-only behaviour preserved).
    if (runExecutor.canProduce) {
      runExecutor.start({
        runId,
        userId: auth.userId,
        ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
        ...(auth.persona !== undefined ? { persona: auth.persona } : {}),
        ...(typeof body['surface'] === 'string' ? { surface: body['surface'] } : {}),
        input: (typeof body['input'] === 'object' && body['input'] !== null)
          ? (body['input'] as Record<string, unknown>)
          : {},
        ...(typeof body['metadata'] === 'object' && body['metadata'] !== null
          ? { metadata: body['metadata'] as Record<string, unknown> }
          : {}),
      });
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(run));
  }, { auth: true });

  router.get('/api/me/runs', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const statusParam = url.searchParams.get('status');
    const limit = safePageInt(url.searchParams.get('limit'), 50, 1, 200);
    const offset = safePageInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
    type RunStatus = 'pending'|'running'|'completed'|'failed'|'cancelled';
    const validStatuses: RunStatus[] = ['pending','running','completed','failed','cancelled'];
    const status = validStatuses.includes(statusParam as RunStatus) ? statusParam as RunStatus : undefined;
    const runs = await db.listUserRuns(auth.userId, { status, limit, offset });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runs }));
  }, { auth: true });

  // Client run/stream tuning (sourced from the `run_stream_config` DB row).
  // Registered BEFORE `/:runId` so the literal path wins over the param route.
  // Clients (@weaveintel/client / geneweave-ui) fetch this and apply the
  // reconnect backoff / throttle so DB changes drive client behaviour.
  router.get('/api/me/runs/config', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await loadRunStreamConfig(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(clientStreamConfig(cfg)));
  }, { auth: true });

  // Collaboration Phase 1: presence cadence (heartbeat/TTL), DB-driven. Clients
  // fetch this and heartbeat at `presenceHeartbeatMs`.
  router.get('/api/me/collab/config', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const cfg = await loadCollaborationConfig(db);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(clientCollabConfig(cfg)));
  }, { auth: true });

  router.get('/api/me/runs/:runId', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: any participant (owner / collaborator / viewer) may VIEW the run.
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...access.run, role: access.role }));
  }, { auth: true });

  // SSE event stream — resumable via ?after=<sequence>
  router.get('/api/me/runs/:runId/events', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: any participant may READ the live stream (viewers watch).
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const run = access.run;

    const url = new URL(req.url ?? '/', 'http://x');
    const afterSeq = safePageInt(url.searchParams.get('after'), -1, -1, Number.MAX_SAFE_INTEGER);

    // Keepalive cadence comes from `run_stream_config` (DB), not a hardcoded 15s.
    const streamCfg = await loadRunStreamConfig(db);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Subscribe FIRST so any event appended during the replay window is
    // buffered (not lost). The subscriber dedups by sequence, so the
    // replay→live handoff is gap-free and duplicate-free.
    const { subscriber, detach } = runExecutor.subscribe(run.id, res, afterSeq);

    // Replay all persisted events after the cursor — THROUGH the core RunJournal
    // port (Collaboration Phase 0). `createSqlRunJournal` is the SQL adapter over
    // `user_run_events`; reading via the port (instead of the raw db method) is
    // what makes geneWeave's run pipeline run on the one canonical contract.
    // `journalMaxEvents` bounds the journal, so it bounds the replay too.
    const journal = createSqlRunJournal(db);
    const events = await journal.readAfter(
      { runId: run.id, afterSequence: afterSeq },
      { limit: streamCfg.journalMaxEvents },
    );
    for (const ev of events) {
      subscriber.replay({
        runId: run.id,
        sequence: ev.sequence,
        kind: ev.kind,
        payload: ev.payload,
        timestamp: ev.timestamp ?? Date.now(),
      });
    }

    // Collaboration Phase 1: send the CURRENT presence snapshot to the new
    // subscriber so it immediately sees who else is watching (presence is
    // ephemeral, so it is NOT in the journal above — it's read live here).
    try {
      const collabCfg = await loadCollaborationConfig(db);
      if (collabCfg.enabled) {
        const presence = createSqlPresenceManager(db, { ttlMs: collabCfg.presenceTtlMs });
        const humans = await presence.list({ runId: run.id, tenantId: run.tenant_id ?? '__default__' });
        const participants = await annotatePresenceRoles(withAgentPeer(humans, run.status, collabCfg.showAgentPresence), db, run);
        if (participants.length > 0) {
          subscriber.replay({ runId: run.id, sequence: -1, kind: 'presence.update', payload: { participants }, timestamp: Date.now() });
        }
      }
    } catch { /* presence snapshot is best-effort — never break the stream */ }

    // For terminal runs with nothing more coming, close after replay.
    if (isTerminalRunStatus(run.status)) {
      detach();
      if (!res.writableEnded) res.end();
      return;
    }

    // Flush buffered live events, then live-tail until the client disconnects
    // or a terminal event closes the stream.
    subscriber.activate();
    const keepalive = setInterval(() => {
      try {
        if (res.writableEnded) { clearInterval(keepalive); return; }
        res.write(': keepalive\n\n');
      } catch { clearInterval(keepalive); }
    }, Math.max(1000, streamCfg.heartbeatMs));
    req.socket?.on('close', () => { clearInterval(keepalive); detach(); });
  }, { auth: true });

  router.post('/api/me/runs/:runId/events', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: posting control events (input, approval decisions, steering) is a
    // WRITE — only owner + collaborator. A viewer who finds the run gets 403.
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (!roleAtLeast(access.role, 'collaborator')) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: viewers cannot send control events' })); return; }
    const run = access.run;
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

    const kind = typeof body['kind'] === 'string' ? body['kind'] : 'client.event';
    const payload = (typeof body['payload'] === 'object' && body['payload'] !== null)
      ? (body['payload'] as Record<string, unknown>)
      : body;

    // Phase 4: an approval decision resolves a pending HITL approval (resumes or
    // denies the paused run) rather than being recorded as a plain client event.
    if (kind === 'approval.decision') {
      const taskId = typeof payload['taskId'] === 'string' ? payload['taskId'] : '';
      const rawAction = payload['action'];
      const action = rawAction === 'approve' || rawAction === 'reject' || rawAction === 'modify' ? rawAction : 'reject';
      const resolved = taskId
        ? await runApprovals.resolve(taskId, action, {
            ...(typeof payload['feedback'] === 'string' ? { feedback: payload['feedback'] } : {}),
            ...(payload['modifiedArgs'] && typeof payload['modifiedArgs'] === 'object' ? { modifiedArgs: payload['modifiedArgs'] as Record<string, unknown> } : {}),
            decidedBy: auth.userId,
          })
        : false;
      res.writeHead(resolved ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resolved }));
      return;
    }

    // Append + broadcast through the executor so client-originated events are
    // serialized with executor writes (gap-free sequence) and fanned out live.
    const sequence = await runExecutor.appendEvent(run.id, kind, payload);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sequence }));
  }, { auth: true });

  // ── Presence (Collaboration Phase 1) — "who else is watching this run" ──────
  // POST = heartbeat (or `{ leave: true }` to leave). Identity is ALWAYS the
  // authenticated user (`auth.userId`) — never client-supplied — so presence
  // cannot be spoofed. `displayName` is a cosmetic label (capped, no PII). Each
  // heartbeat broadcasts the full participant snapshot to the run's live
  // subscribers and returns it to the caller. Presence is ephemeral (its own
  // `run_presence` table) and never journaled.
  router.post('/api/me/runs/:runId/presence', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: any participant (incl. viewers) may show presence on a run they
    // can access — that's what makes multi-user "who's watching" work.
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const run = access.run;

    const cfg = await loadCollaborationConfig(db);
    if (!cfg.enabled) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ participants: [] })); return; }
    const presence = createSqlPresenceManager(db, { ttlMs: cfg.presenceTtlMs });
    const scope = { runId: run.id, tenantId: run.tenant_id ?? '__default__' };

    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* empty body = plain heartbeat */ }

    let humans;
    if (body['leave'] === true) {
      humans = await presence.leave(scope, auth.userId);
    } else {
      const rawName = typeof body['displayName'] === 'string' ? body['displayName'] : `User ${auth.userId.slice(0, 8)}`;
      const state = typeof body['presence'] === 'string' ? body['presence'] : 'online';
      humans = await presence.heartbeat(scope, {
        userId: auth.userId,                       // server-derived identity (anti-spoof)
        displayName: rawName.slice(0, 64),         // cosmetic, length-capped, no PII
        presence: state,
        peerType: 'human',
        ...(body['cursor'] && typeof body['cursor'] === 'object' ? { cursor: body['cursor'] as Record<string, unknown> } : {}),
      });
    }
    const participants = await annotatePresenceRoles(withAgentPeer(humans, run.status, cfg.showAgentPresence), db, run);
    // Push the new snapshot to everyone watching (ephemeral — not journaled).
    runExecutor.broadcastEphemeral(run.id, 'presence.update', { participants });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ participants }));
  }, { auth: true });

  router.get('/api/me/runs/:runId/presence', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId); // any participant
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const run = access.run;
    const cfg = await loadCollaborationConfig(db);
    const presence = createSqlPresenceManager(db, { ttlMs: cfg.presenceTtlMs });
    const humans = await presence.list({ runId: run.id, tenantId: run.tenant_id ?? '__default__' });
    const participants = await annotatePresenceRoles(withAgentPeer(humans, run.status, cfg.showAgentPresence), db, run);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ participants }));
  }, { auth: true });

  router.post('/api/me/runs/:runId/cancel', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Phase 2: cancelling is an OWNER-only action (a higher tier than write).
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (access.role !== 'owner') { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: only the owner can cancel the run' })); return; }
    const run = access.run;
    if (isTerminalRunStatus(run.status)) {
      res.writeHead(409); res.end(JSON.stringify({ error: 'Run already in terminal state' })); return;
    }
    // Cooperatively abort the in-flight agent (if any). When a producing run
    // is active its loop emits the terminal `run.cancelled` event; otherwise
    // we flip status + append the terminal event ourselves.
    const wasActive = runExecutor.cancel(params['runId']!);
    await db.updateUserRunStatus(params['runId']!, auth.userId, 'cancelled');
    if (!wasActive) {
      await runExecutor.appendEvent(params['runId']!, 'run.cancelled', {}).catch(() => {});
    }
    if (notifications) {
      const updated = await db.getUserRun(params['runId']!, auth.userId);
      if (updated) {
        void notifications.notifyRunTerminal(updated, { attached: runExecutor.hasSubscriber(updated.id) }).catch(() => {});
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'cancelled' }));
  }, { auth: true });

  // ── Shared sessions + invite links (Collaboration Phase 2) ──────────────────
  // Share a run: OWNER-only. Creates the shared session (idempotent per run) and
  // mints an invite token granting `role` (default viewer). The plaintext token
  // is returned ONCE — only its SHA-256 hash is stored.
  router.post('/api/me/runs/:runId/share', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (access.role !== 'owner') { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden: only the owner can share a run' })); return; }
    const run = access.run;
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* default viewer */ }
    const role: SessionRole = body['role'] === 'collaborator' ? 'collaborator' : 'viewer'; // never mint an owner link
    const cfg = await loadCollaborationConfig(db);

    const sessions = createSqlSessionManager(db);
    const session = await sessions.createSession({ id: newUUIDv7(), runId: run.id, tenantId: run.tenant_id ?? '__default__', ownerId: auth.userId, maxParticipants: cfg.maxParticipantsPerRun });

    const { token, hash, prefix } = mintShareToken();
    const expiresAt = typeof body['expiresInMs'] === 'number' ? Date.now() + (body['expiresInMs'] as number) : null;
    const tokenId = newUUIDv7();
    await db.createShareToken({ id: tokenId, session_id: session.id, tenant_id: run.tenant_id ?? '__default__', role, token_hash: hash, token_prefix: prefix, ...(typeof body['maxUses'] === 'number' ? { max_uses: body['maxUses'] as number } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}), created_by: auth.userId, created_at: Date.now() });

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessionId: session.id, token, tokenId, role, expiresAt, url: `/shared/${token}` }));
  }, { auth: true });

  // Join via an invite token. Authenticated join (identity is server-derived).
  // Validates the token (hash match, live, not expired/revoked, under caps),
  // then idempotently creates the membership and returns the run id + role.
  router.post('/api/me/sessions/join', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* invalid */ }
    const token = typeof body['token'] === 'string' ? body['token'] : '';
    if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing token' })); return; }

    const row = await db.getShareTokenByHash(hashShareToken(token));
    const now = Date.now();
    // Uniform rejection (don't reveal which check failed → no enumeration).
    if (!row || row.revoked_at || (row.expires_at && row.expires_at < now) || (row.max_uses !== null && row.uses >= row.max_uses)) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'Invalid or expired link' })); return;
    }
    const session = await db.getSharedSessionById(row.session_id);
    if (!session || session.status !== 'live') { res.writeHead(403); res.end(JSON.stringify({ error: 'Invalid or expired link' })); return; }
    // Tenant gate: the token's tenant must match the joiner's session tenant.
    // (Both were stamped server-side; a cross-tenant token simply won't resolve.)

    const sessions = createSqlSessionManager(db);
    try {
      const participant = await sessions.join(session.id, auth.userId, row.role as SessionRole);
      await db.incrementShareTokenUses(row.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ runId: session.run_id, sessionId: session.id, role: participant.role }));
    } catch (err) {
      res.writeHead(409); res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Could not join' }));
    }
  }, { auth: true });

  // Read the shared session + its participants (any participant).
  router.get('/api/me/runs/:runId/session', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const sessions = createSqlSessionManager(db);
    const session = await sessions.getByRun(access.run.id);
    if (!session) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ shared: false, role: access.role, participants: [] })); return; }
    const participants = await sessions.listParticipants(session.id);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ shared: true, sessionId: session.id, ownerId: session.ownerId, role: access.role, participants }));
  }, { auth: true });

  // Revoke an invite token (OWNER-only) — already-joined members keep access
  // until removed; the link stops admitting new joiners.
  router.post('/api/me/runs/:runId/share/revoke', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const access = await resolveRunAccess(db, params['runId']!, auth.userId);
    if (!access || access.role !== 'owner') { res.writeHead(access ? 403 : 404); res.end(JSON.stringify({ error: access ? 'Forbidden' : 'Not found' })); return; }
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(await readBody(req)) as Record<string, unknown>; } catch { /* */ }
    const tokenId = typeof body['tokenId'] === 'string' ? body['tokenId'] : '';
    if (!tokenId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing tokenId' })); return; }
    await db.revokeShareToken(tokenId, Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: true }));
  }, { auth: true });

  // ─── Catalog ────────────────────────────────────────────────────────────

  router.get('/api/me/catalog', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const surfaceId = url.searchParams.get('surface') ?? 'web';
    const ctx = weaveContext({
      userId: auth.userId,
      ...(auth.tenantId ? { tenantId: auth.tenantId } : {}),
      metadata: { persona: auth.persona },
    });
    const [catalog, starters] = await Promise.all([
      catalogResolver.resolve(ctx, { surfaceId }),
      db.listStarterPrompts(surfaceId),
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      surfaceId: catalog.surfaceId,
      resolvedAt: catalog.resolvedAt,
      entries: catalog.entries,
      starterPrompts: starters.map((s) => ({
        id: s.id,
        label: s.label,
        promptText: s.prompt_text,
      })),
    }));
  }, { auth: true });

  // ─── Theme ──────────────────────────────────────────────────────────────
  // Per-tenant design tokens (colors / font families / radii) for the caller's
  // tenant. Fail-soft: any error degrades to `{ theme: null }` so the client
  // renders the base brand theme. WCAG-AA enforcement happens client-side.

  router.get('/api/me/theme', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    let theme = null;
    try {
      theme = await resolveTenantThemeTokens(db, auth.tenantId ?? null);
    } catch {
      theme = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ theme }));
  }, { auth: true });

  // ─── Tasks ──────────────────────────────────────────────────────────────

  router.get('/api/me/tasks', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const tasks = await taskRepo.listByAssignee(auth.userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks }));
  }, { auth: true });

  router.post('/api/me/tasks', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    // `actionable` marks a task that requires an explicit approve/deny decision
    // (an "approval") versus a plain to-do ("action item"). It is persisted on
    // the task so the Approvals vs Action-items split is grounded in real data,
    // not a client-side heuristic.
    const actionable = body['actionable'] === true;
    const task = createActionItem({
      assignee: auth.userId,
      title: String(body['title'] ?? 'Untitled task'),
      description: typeof body['description'] === 'string' ? body['description'] : undefined,
      dueAt: typeof body['dueAt'] === 'string' ? body['dueAt'] : undefined,
      data: { actionable },
      provenance: typeof body['provenance'] === 'object' && body['provenance'] !== null
        ? body['provenance'] as { sourceRunId?: string; sourceRef?: string; createdBy: 'agent'|'principal'|'system' }
        : { sourceRef: 'api', createdBy: 'principal' as const },
    });
    await taskRepo.save(task);
    if (notifications) {
      void notifications.notifyTask(
        { id: task.id, assignee: task.assignee, title: task.title, ...(auth.tenantId ? { tenantId: auth.tenantId } : {}) },
        { actionable },
      ).catch(() => {});
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(task));
  }, { auth: true });

  router.post('/api/me/tasks/:taskId/complete', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    try {
      const task = await completeActionItem(params['taskId']!, { repository: taskRepo });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (err) {
      res.writeHead(404); res.end(JSON.stringify({ error: String(err) }));
    }
  }, { auth: true });

  router.post('/api/me/tasks/:taskId/cancel', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    try {
      const task = await cancelActionItem(params['taskId']!, { repository: taskRepo });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (err) {
      res.writeHead(404); res.end(JSON.stringify({ error: String(err) }));
    }
  }, { auth: true });

  // ─── Notification actions ─────────────────────────────────────────────────

  router.post('/api/me/notifications/actions', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const taskId = typeof body['taskId'] === 'string' ? body['taskId'] : '';
    const actionId = typeof body['actionId'] === 'string' ? body['actionId'] : '';
    if (!taskId || !['approve', 'deny'].includes(actionId)) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'taskId and actionId (approve|deny) are required' })); return;
    }
    const task = await taskRepo.get(taskId);
    // Hide cross-principal tasks behind a 404 (no existence disclosure).
    if (!task || task.assignee !== auth.userId) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
    }
    // Idempotent: a task already in a terminal state returns the prior outcome.
    if (task.status === 'completed' || task.status === 'rejected' || task.status === 'expired') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alreadyResolved: true, status: task.status }));
      return;
    }
    const resolved = actionId === 'approve'
      ? await completeActionItem(taskId, { repository: taskRepo })
      : await cancelActionItem(taskId, { repository: taskRepo });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ resolved: true, status: resolved.status }));
  }, { auth: true, csrf: true });

  // ─── Reminders ──────────────────────────────────────────────────────────

  router.get('/api/me/reminders', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    // Merge trigger-store reminders (created via POST /api/me/reminders) with
    // temporal reminders the agent wrote via temporal tools. Both paths are
    // valid; the trigger-store set is keyed by id so DB rows with the same id
    // are deduplicated.
    const [storeReminders, temporalRows] = await Promise.all([
      triggerStore.listByOwner(auth.userId),
      db.listTemporalRemindersByUserId(auth.userId),
    ]);
    const seenIds = new Set(storeReminders.map((r) => r.id));
    const temporalAsReminders = temporalRows
      .filter((row) => !seenIds.has(row.id))
      .map((row) => ({
        id: row.id,
        key: row.id,
        enabled: row.status === 'scheduled',
        ownerPrincipalId: row.scope_id.split(':')[0],
        source: { kind: 'schedule', config: { fireAt: row.due_at, timezone: row.timezone } },
        target: { kind: 'reminder_bus', config: { label: row.text } },
        metadata: { oneShot: true, label: row.text },
      }));
    const reminders = [...storeReminders, ...temporalAsReminders];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reminders }));
  }, { auth: true });

  router.post('/api/me/reminders', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    let reminder;
    try {
      reminder = createReminderTrigger({
        ownerPrincipalId: auth.userId,
        label: String(body['label'] ?? 'Reminder'),
        ...(typeof body['fireAt'] === 'string' ? { fireAt: body['fireAt'] } : {}),
        ...(typeof body['rrule'] === 'string' ? { rrule: body['rrule'] } : {}),
        provenance: typeof body['provenance'] === 'object' && body['provenance'] !== null
          ? body['provenance'] as { sourceRunId?: string; sourceRef?: string }
          : undefined,
      });
    } catch (err) {
      res.writeHead(400); res.end(JSON.stringify({ error: String(err) })); return;
    }
    await triggerStore.save(reminder);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reminder));
  }, { auth: true });

  router.post('/api/me/reminders/:reminderId/reschedule', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    if (typeof body['fireAt'] !== 'string') {
      res.writeHead(400); res.end(JSON.stringify({ error: 'fireAt is required' })); return;
    }
    try {
      const updated = await rescheduleReminder(params['reminderId']!, body['fireAt'], triggerStore);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(updated));
    } catch (err) {
      res.writeHead(404); res.end(JSON.stringify({ error: String(err) }));
    }
  }, { auth: true });

  router.del('/api/me/reminders/:reminderId', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const reminderId = params['reminderId']!;
    // Try trigger store first (reminders created via POST /api/me/reminders).
    const storeReminder = await triggerStore.get(reminderId);
    if (storeReminder) {
      if (storeReminder.ownerPrincipalId !== auth.userId) {
        res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return;
      }
      await triggerStore.delete?.(reminderId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
    // Fall back to temporal_reminders (agent-created via temporal tools).
    const deleted = await db.deleteTemporalReminderById(reminderId, auth.userId);
    if (!deleted) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true }));
  }, { auth: true });

  // ─── Devices ────────────────────────────────────────────────────────────

  router.post('/api/me/devices', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const channel = body['channel'];
    if (!['web-push', 'apns', 'fcm'].includes(String(channel))) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid channel' })); return;
    }
    const token = String(body['token'] ?? '');
    if (!token) { res.writeHead(400); res.end(JSON.stringify({ error: 'token required' })); return; }
    await db.registerDevice({
      id: newUUIDv7(),
      user_id: auth.userId,
      channel: channel as 'web-push' | 'apns' | 'fcm',
      token,
      ...(typeof body['label'] === 'string' ? { label: body['label'] } : {}),
    });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ registered: true }));
  }, { auth: true });

  router.del('/api/me/devices/:token', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const token = decodeURIComponent(params['token']!);
    await db.removeDevice(auth.userId, token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ removed: true }));
  }, { auth: true });

  // ─── Notification preferences ────────────────────────────────────────────

  router.get('/api/me/notification-preferences', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const prefs = await db.getNotificationPrefs(auth.userId);
    if (!prefs) {
      // Return defaults when no preferences have been set yet
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled: true, categories: [], quietHours: null }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: prefs.enabled === 1,
      categories: prefs.categories ? ((): string[] => { try { return JSON.parse(prefs.categories) as string[]; } catch { return []; } })() : [],
      quietHours: prefs.quiet_hours ?? null,
    }));
  }, { auth: true });

  router.put('/api/me/notification-preferences', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    const existing = await db.getNotificationPrefs(auth.userId);
    await db.upsertNotificationPrefs(auth.userId, {
      id: existing?.id ?? newUUIDv7(),
      enabled: body['enabled'] !== false,
      categories: Array.isArray(body['categories']) ? body['categories'] as string[] : [],
      quiet_hours: typeof body['quietHours'] === 'string' ? body['quietHours'] : null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ saved: true }));
  }, { auth: true });
}
