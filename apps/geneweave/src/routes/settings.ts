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
        agent: ['datetime', 'timezone_info', 'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list', 'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status', 'reminder_create', 'reminder_list', 'reminder_cancel', 'calculator', 'json_format', 'text_analysis', 'memory_recall', 'web_search', 'cse_run_code', 'cse_run_data_analysis', 'cse_session_status', 'cse_end_session', 'browser_open', 'browser_close', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_select', 'browser_type', 'browser_hover', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_detect_auth', 'browser_login', 'browser_save_cookies', 'browser_handoff_request', 'browser_handoff_resume'],
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

}
