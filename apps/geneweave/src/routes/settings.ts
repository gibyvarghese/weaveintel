import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../db.js';
import { json, readBody } from '../server-core.js';
import type { Router } from '../server-core.js';

export function registerSettingsRoutes(
  router: Router,
  db: DatabaseAdapter,
): void {

  // ── User preferences routes ────────────────────────────────

  router.get('/api/user/preferences', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const prefs = await db.getUserPreferences(auth.userId);
    json(res, 200, { preferences: prefs ?? { default_mode: 'direct', theme: 'light', show_process_card: 1 } });
  });

  router.post('/api/user/preferences', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const mode = (body['default_mode'] as string) || 'direct';
    const theme = (body['theme'] as string) || 'light';
    const rawShow = body['show_process_card'];
    const showProcessCard = rawShow === undefined ? true : Boolean(rawShow);
    if (!['direct', 'agent', 'supervisor'].includes(mode)) {
      json(res, 400, { error: 'default_mode must be "direct", "agent", or "supervisor"' }); return;
    }
    if (!['light', 'dark'].includes(theme)) {
      json(res, 400, { error: 'theme must be "light" or "dark"' }); return;
    }
    await db.saveUserPreferences(auth.userId, mode, theme, showProcessCard);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Chat settings routes ───────────────────────────────────

  router.get('/api/chats/:chatId/settings', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const settings = await db.getChatSettings(chat.id);
    json(res, 200, {
      settings: settings ?? { chat_id: chat.id, mode: 'direct', system_prompt: null, timezone: null, enabled_tools: null, redaction_enabled: 0, redaction_patterns: null, workers: null },
    });
  });

  router.post('/api/chats/:chatId/settings', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const mode = (body['mode'] as string) || 'direct';
    if (!['direct', 'agent', 'supervisor'].includes(mode)) {
      json(res, 400, { error: 'mode must be "direct", "agent", or "supervisor"' }); return;
    }

    // Apply tool policy: if enabledTools not provided, apply defaults for the mode
    // This allows tools to be auto-selected based on the mode
    const toolPolicy = (() => {
      if (body['enabledTools'] !== undefined && body['enabledTools'] !== null) {
        // User explicitly provided tools
        return body['enabledTools'];
      }
      // Auto-select based on mode - get from chat engine's tool policy
      // For now, we replicate the policy here; ideally this would be imported
      const DEFAULT_TOOLS: Record<string, string[]> = {
        direct: [],
        agent: ['datetime', 'timezone_info', 'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list', 'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status', 'reminder_create', 'reminder_list', 'reminder_cancel', 'calculator', 'json_format', 'text_analysis', 'memory_recall', 'memory_search', 'memory_remember', 'memory_forget', 'memory_list_entities', 'memory_list_episodes', 'memory_get_profile', 'web_search', 'cse_run_code', 'cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'browser_open', 'browser_close', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_select', 'browser_type', 'browser_hover', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_detect_auth', 'browser_login', 'browser_save_cookies', 'browser_handoff_request', 'browser_handoff_resume'],
        supervisor: ['datetime', 'timezone_info', 'calculator', 'json_format', 'text_analysis'],
      };
      return DEFAULT_TOOLS[mode] ?? [];
    })();

    await db.saveChatSettings({
      chatId: chat.id,
      mode,
      systemPrompt: (body['systemPrompt'] as string) ?? undefined,
      timezone: (body['timezone'] as string) ?? undefined,
      enabledTools: JSON.stringify(toolPolicy),
      redactionEnabled: !!body['redactionEnabled'],
      redactionPatterns: body['redactionPatterns'] ? JSON.stringify(body['redactionPatterns']) : undefined,
      workers: body['workers'] ? JSON.stringify(body['workers']) : undefined,
    });

    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── User memory routes — users manage their own memory ────

  // GET /api/user/memory — returns all memory types for the authenticated user
  router.get('/api/user/memory', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '', 'http://localhost');
    const limit = Math.min(100, parseInt(url.searchParams.get('limit') ?? '50', 10));
    const [entities, semantic, episodic, procedural, working] = await Promise.all([
      db.listEntities(auth.userId),
      db.listSemanticMemory(auth.userId, limit),
      db.listEpisodicMemory(auth.userId, limit),
      db.listProceduralMemory(auth.userId),
      db.listWorkingMemorySnapshots(auth.userId, Math.min(20, limit)),
    ]);
    json(res, 200, {
      entities: entities.map((e) => ({
        id: e.id,
        entityName: e.entity_name,
        entityType: e.entity_type,
        facts: (() => { try { return JSON.parse(e.facts) as Record<string, unknown>; } catch { return {}; } })(),
        confidence: e.confidence,
        source: e.source,
        updatedAt: e.updated_at,
      })),
      semantic: semantic.map((m) => ({
        id: m.id,
        content: m.content,
        memoryType: m.memory_type,
        source: m.source,
        createdAt: m.created_at,
      })),
      episodic: episodic.map((ep) => ({
        id: ep.id,
        messageRole: ep.message_role,
        content: ep.content,
        importance: ep.importance,
        tags: (() => { try { return ep.tags ? JSON.parse(ep.tags) as string[] : []; } catch { return []; } })(),
        consolidated: ep.consolidated === 1,
        createdAt: ep.created_at,
      })),
      procedural: procedural.map((p) => ({
        id: p.id,
        agentId: p.agent_id,
        instructionDelta: p.instruction_delta,
        status: p.status,
        confidence: p.confidence,
        proposedBy: p.proposed_by,
        appliedAt: p.applied_at,
        createdAt: p.created_at,
      })),
      working: working.map((w) => ({
        id: w.id,
        chatId: w.chat_id,
        agentId: w.agent_id,
        content: (() => { try { return JSON.parse(w.content) as Record<string, unknown>; } catch { return {}; } })(),
        savedAt: w.created_at,
      })),
    });
  });

  // DELETE /api/user/memory/semantic/:id — user deletes a single semantic memory
  router.del('/api/user/memory/semantic/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteSemanticMemory(params['id']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // DELETE /api/user/memory/entity/:entityName — user forgets an entity
  router.del('/api/user/memory/entity/:entityName', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteEntity(auth.userId, decodeURIComponent(params['entityName']!));
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // DELETE /api/user/memory/episodic/:id — user removes an episodic event
  router.del('/api/user/memory/episodic/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteEpisodicMemory(params['id']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // DELETE /api/user/memory/working/:id — user deletes a working memory snapshot
  router.del('/api/user/memory/working/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWorkingMemorySnapshot(params['id']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // DELETE /api/user/memory/all — full memory wipe (all types) for the user
  router.del('/api/user/memory/all', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await Promise.all([
      db.clearUserSemanticMemory(auth.userId),
      db.clearUserEntityMemory(auth.userId),
      db.clearUserEpisodicMemory(auth.userId),
      db.clearUserWorkingMemory(auth.userId),
    ]);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

}
