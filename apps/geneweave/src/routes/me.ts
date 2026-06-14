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
import { MeRunExecutor, isTerminalRunStatus } from '../me-run-executor.js';

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
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
    const offset = Number(url.searchParams.get('offset') ?? '0');
    type RunStatus = 'pending'|'running'|'completed'|'failed'|'cancelled';
    const validStatuses: RunStatus[] = ['pending','running','completed','failed','cancelled'];
    const status = validStatuses.includes(statusParam as RunStatus) ? statusParam as RunStatus : undefined;
    const runs = await db.listUserRuns(auth.userId, { status, limit, offset });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runs }));
  }, { auth: true });

  router.get('/api/me/runs/:runId', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const run = await db.getUserRun(params['runId']!, auth.userId);
    if (!run) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(run));
  }, { auth: true });

  // SSE event stream — resumable via ?after=<sequence>
  router.get('/api/me/runs/:runId/events', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const run = await db.getUserRun(params['runId']!, auth.userId);
    if (!run) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }

    const url = new URL(req.url ?? '/', 'http://x');
    const afterSeq = Number(url.searchParams.get('after') ?? '-1');

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

    // Replay all persisted events after the cursor.
    const events = await db.listUserRunEvents(run.id, afterSeq);
    for (const ev of events) {
      subscriber.replay({
        runId: run.id,
        sequence: ev.sequence,
        kind: ev.kind,
        payload: JSON.parse(ev.payload),
        timestamp: Date.parse(ev.created_at ?? '') || Date.now(),
      });
    }

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
    }, 15_000);
    req.socket?.on('close', () => { clearInterval(keepalive); detach(); });
  }, { auth: true });

  router.post('/api/me/runs/:runId/events', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const run = await db.getUserRun(params['runId']!, auth.userId);
    if (!run) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

    // Append + broadcast through the executor so client-originated events are
    // serialized with executor writes (gap-free sequence) and fanned out live.
    const kind = typeof body['kind'] === 'string' ? body['kind'] : 'client.event';
    const payload = (typeof body['payload'] === 'object' && body['payload'] !== null)
      ? (body['payload'] as Record<string, unknown>)
      : body;
    const sequence = await runExecutor.appendEvent(run.id, kind, payload);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sequence }));
  }, { auth: true });

  router.post('/api/me/runs/:runId/cancel', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const run = await db.getUserRun(params['runId']!, auth.userId);
    if (!run) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
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

  router.post('/api/me/tasks/:taskId/complete', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    try {
      const task = await completeActionItem(params['taskId']!, { repository: taskRepo });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    } catch (err) {
      res.writeHead(404); res.end(JSON.stringify({ error: String(err) }));
    }
  }, { auth: true });

  router.post('/api/me/tasks/:taskId/cancel', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
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
