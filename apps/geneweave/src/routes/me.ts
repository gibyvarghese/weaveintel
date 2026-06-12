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

import { newUUIDv7 } from '@weaveintel/core';
import { createActionItem, completeActionItem, cancelActionItem } from '@weaveintel/human-tasks';
import { InMemoryHumanTaskRepository } from '@weaveintel/human-tasks';
import { InMemoryTriggerStore, createReminderTrigger, rescheduleReminder } from '@weaveintel/triggers';
import type { Router } from '../server-core.js';
import { readBody } from '../server-core.js';
import type { DatabaseAdapter } from '../db-types.js';

// Module-level state — these are in-memory stores that persist for the
// process lifetime.  Production deployments should replace these with
// durable backends via @weaveintel/persistence.
const taskRepo = new InMemoryHumanTaskRepository();
const triggerStore = new InMemoryTriggerStore();

/**
 * Register all /api/me routes on the provided router.
 *
 * @param router   The server Router instance
 * @param db       DatabaseAdapter (for runs, devices, prefs)
 */
export function registerMeRoutes(router: Router, db: DatabaseAdapter): void {

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

    // Flush all events after the cursor, then keepalive
    const events = await db.listUserRunEvents(params['runId']!, afterSeq);
    for (const ev of events) {
      const envelope = { runId: run.id, sequence: ev.sequence, kind: ev.kind, payload: JSON.parse(ev.payload) };
      res.write(`data: ${JSON.stringify(envelope)}\n\n`);
    }

    // For terminal runs, close immediately
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      res.end();
      return;
    }

    // Keepalive comment every 15s; stream stays open until client disconnects
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
    }, 15_000);
    req.socket?.on('close', () => clearInterval(keepalive));
  }, { auth: true });

  router.post('/api/me/runs/:runId/events', async (req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const run = await db.getUserRun(params['runId']!, auth.userId);
    if (!run) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>;

    // Append event — sequence is derived from count of existing events + 1
    const existing = await db.listUserRunEvents(params['runId']!);
    const sequence = existing.length;
    await db.appendUserRunEvent({
      id: newUUIDv7(),
      run_id: run.id,
      sequence,
      kind: typeof body['kind'] === 'string' ? body['kind'] : 'client.event',
      payload: JSON.stringify(body['payload'] ?? body),
    });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sequence }));
  }, { auth: true });

  router.post('/api/me/runs/:runId/cancel', async (_req, res, params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const run = await db.getUserRun(params['runId']!, auth.userId);
    if (!run) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      res.writeHead(409); res.end(JSON.stringify({ error: 'Run already in terminal state' })); return;
    }
    await db.updateUserRunStatus(params['runId']!, auth.userId, 'cancelled');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'cancelled' }));
  }, { auth: true });

  // ─── Catalog ────────────────────────────────────────────────────────────

  router.get('/api/me/catalog', async (req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const url = new URL(req.url ?? '/', 'http://x');
    const surfaceId = url.searchParams.get('surface') ?? 'web';
    const [modes, starters] = await Promise.all([
      db.listModeLabels(surfaceId),
      db.listStarterPrompts(surfaceId),
    ]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      surfaceId,
      resolvedAt: new Date().toISOString(),
      entries: modes.map((m) => ({
        id: m.id,
        kind: 'mode',
        label: m.label,
        ...(m.description ? { description: m.description } : {}),
        ...(m.is_default ? { default: true } : {}),
        ...(m.metadata ? { metadata: JSON.parse(m.metadata) } : {}),
      })),
      starterPrompts: starters.map((s) => ({
        id: s.id,
        label: s.label,
        promptText: s.prompt_text,
      })),
    }));
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
    const task = createActionItem({
      assignee: auth.userId,
      title: String(body['title'] ?? 'Untitled task'),
      description: typeof body['description'] === 'string' ? body['description'] : undefined,
      dueAt: typeof body['dueAt'] === 'string' ? body['dueAt'] : undefined,
      provenance: typeof body['provenance'] === 'object' && body['provenance'] !== null
        ? body['provenance'] as { sourceRunId?: string; sourceRef?: string; createdBy: 'agent'|'principal'|'system' }
        : { sourceRef: 'api', createdBy: 'principal' as const },
    });
    await taskRepo.save(task);
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

  // ─── Reminders ──────────────────────────────────────────────────────────

  router.get('/api/me/reminders', async (_req, res, _params, auth) => {
    if (!auth) { res.writeHead(401); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
    const reminders = await triggerStore.listByOwner(auth.userId);
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
    const reminder = await triggerStore.get(params['reminderId']!);
    if (!reminder) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }
    if (reminder.ownerPrincipalId !== auth.userId) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return;
    }
    await triggerStore.delete?.(params['reminderId']!);
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
      categories: JSON.parse(prefs.categories) as string[],
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
