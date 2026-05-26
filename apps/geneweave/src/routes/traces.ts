import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from '../db.js';
import { DashboardService } from '../dashboard.js';
import { json } from '../server-core.js';
import type { Router } from '../server-core.js';

export function registerTraceRoutes(
  router: Router,
  db: DatabaseAdapter,
  dashboard: DashboardService,
): void {

  // ── Trace routes ───────────────────────────────────────────

  router.get('/api/chats/:chatId/traces', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const traces = await db.getChatTraces(chat.id);
    json(res, 200, { traces });
  });

  router.get('/api/dashboard/traces', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);
    const traces = await db.getUserTraces(auth.userId, Math.min(limit, 500));
    json(res, 200, { traces });
  });

  router.get('/api/dashboard/agent-activity', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const rows = await db.getAgentActivity(auth.userId, Math.min(limit, 200));
    const activity = rows.map(row => {
      let meta: any = {};
      try { meta = JSON.parse(row.metadata || '{}'); } catch { /* ignore */ }
      return {
        id: row.id,
        chatId: row.chat_id,
        chatTitle: row.chat_title,
        chatModel: row.chat_model,
        chatProvider: row.chat_provider,
        content: row.content,
        tokensUsed: row.tokens_used,
        cost: row.cost,
        latencyMs: row.latency_ms,
        createdAt: row.created_at,
        mode: meta.mode || 'direct',
        agentName: meta.agentName || null,
        systemPrompt: meta.systemPrompt || null,
        enabledTools: meta.enabledTools || [],
        redactionEnabled: meta.redactionEnabled || false,
        model: meta.model || row.chat_model,
        provider: meta.provider || row.chat_provider,
        steps: meta.steps || [],
        eval: meta.eval || null,
        traceId: meta.traceId || null,
      };
    });
    json(res, 200, { activity });
  });

}
