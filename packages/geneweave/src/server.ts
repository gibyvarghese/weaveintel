/**
 * @weaveintel/geneweave — HTTP server + routes
 *
 * Zero-dependency HTTP server built on node:http with a hand-rolled router,
 * JSON body parsing, cookie handling, CORS, auth middleware, and SSE support.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from './db.js';
import type { ChatEngine } from './chat.js';
import { DashboardService } from './dashboard.js';
import { getAvailableTools } from './tools.js';
import {
  authenticateRequest,
  verifyCSRF,
  hashPassword,
  verifyPassword,
  signJWT,
  generateCSRFToken,
  setAuthCookie,
  clearAuthCookie,
  type AuthContext,
} from './auth.js';
import { getHTML } from './ui.js';

// ─── Router ──────────────────────────────────────────────────

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  auth: AuthContext | null,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  requireAuth: boolean;
  requireCSRF: boolean;
}

class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' + path.replace(/:(\w+)/g, (_, key: string) => { keys.push(key); return '([^/]+)'; }) + '$',
    );
    this.routes.push({
      method,
      pattern,
      keys,
      handler,
      requireAuth: opts?.auth ?? false,
      requireCSRF: opts?.csrf ?? false,
    });
  }

  get(path: string, handler: Handler, opts?: { auth?: boolean }): void {
    this.add('GET', path, handler, opts);
  }

  post(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void {
    this.add('POST', path, handler, { auth: opts?.auth, csrf: opts?.csrf ?? true });
  }

  del(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void {
    this.add('DELETE', path, handler, { auth: opts?.auth, csrf: opts?.csrf ?? true });
  }

  put(path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }): void {
    this.add('PUT', path, handler, { auth: opts?.auth, csrf: opts?.csrf ?? true });
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = pathname.match(route.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => { params[key] = m[i + 1]!; });
      return { route, params };
    }
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 1_048_576; // 1 MB
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) { req.destroy(); reject(new Error('Request body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ─── Server factory ──────────────────────────────────────────

export interface ServerConfig {
  db: DatabaseAdapter;
  chatEngine: ChatEngine;
  jwtSecret: string;
  corsOrigin?: string;
}

export function createGeneWeaveServer(config: ServerConfig): Server {
  const { db, chatEngine, jwtSecret, corsOrigin } = config;
  const dashboard = new DashboardService(db);
  const router = new Router();
  const uiHtml = getHTML();

  // ── Auth routes ────────────────────────────────────────────

  router.post('/api/auth/register', async (req, res) => {
    const raw = await readBody(req);
    let body: { name?: string; email?: string; password?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const { name, email, password } = body;
    if (!name || !email || !password) { json(res, 400, { error: 'name, email, and password required' }); return; }
    if (password.length < 8) { json(res, 400, { error: 'Password must be at least 8 characters' }); return; }

    const existing = await db.getUserByEmail(email);
    if (existing) { json(res, 409, { error: 'Email already registered' }); return; }

    const userId = randomUUID();
    const passwordHash = hashPassword(password);
    await db.createUser({ id: userId, email, name, passwordHash });

    const sessionId = randomUUID();
    const csrfToken = generateCSRFToken();
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    await db.createSession({ id: sessionId, userId, csrfToken, expiresAt });

    const token = signJWT({ userId, email, sessionId }, jwtSecret);
    setAuthCookie(res, token);
    json(res, 201, { user: { id: userId, email, name }, csrfToken });
  }, { csrf: false });

  router.post('/api/auth/login', async (req, res) => {
    const raw = await readBody(req);
    let body: { email?: string; password?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const { email, password } = body;
    if (!email || !password) { json(res, 400, { error: 'email and password required' }); return; }

    const user = await db.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      json(res, 401, { error: 'Invalid credentials' });
      return;
    }

    const sessionId = randomUUID();
    const csrfToken = generateCSRFToken();
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    await db.createSession({ id: sessionId, userId: user.id, csrfToken, expiresAt });

    const token = signJWT({ userId: user.id, email: user.email, sessionId }, jwtSecret);
    setAuthCookie(res, token);
    json(res, 200, { user: { id: user.id, email: user.email, name: user.name }, csrfToken });
  }, { csrf: false });

  router.post('/api/auth/logout', async (_req, _res, _params, auth) => {
    if (auth) await db.deleteSession(auth.sessionId);
    clearAuthCookie(_res);
    json(_res, 200, { ok: true });
  }, { auth: false, csrf: false });

  router.get('/api/auth/me', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const user = await db.getUserById(auth.userId);
    if (!user) { json(res, 401, { error: 'User not found' }); return; }
    json(res, 200, { user: { id: user.id, email: user.email, name: user.name }, csrfToken: auth.csrfToken });
  });

  // ── Model routes ───────────────────────────────────────────

  router.get('/api/models', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const models = chatEngine.getAvailableModels();
    json(res, 200, {
      models,
      defaultModel: (chatEngine as any).config.defaultProvider + ':' + (chatEngine as any).config.defaultModel,
    });
  });

  // ── Tools routes ───────────────────────────────────────────

  router.get('/api/tools', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { tools: getAvailableTools() });
  });

  // ── Chat settings routes ───────────────────────────────────

  router.get('/api/chats/:chatId/settings', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const settings = await db.getChatSettings(chat.id);
    json(res, 200, {
      settings: settings ?? { chat_id: chat.id, mode: 'direct', system_prompt: null, enabled_tools: null, redaction_enabled: 0, redaction_patterns: null, workers: null },
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

    await db.saveChatSettings({
      chatId: chat.id,
      mode,
      systemPrompt: (body['systemPrompt'] as string) ?? undefined,
      enabledTools: body['enabledTools'] ? JSON.stringify(body['enabledTools']) : undefined,
      redactionEnabled: !!body['redactionEnabled'],
      redactionPatterns: body['redactionPatterns'] ? JSON.stringify(body['redactionPatterns']) : undefined,
      workers: body['workers'] ? JSON.stringify(body['workers']) : undefined,
    });

    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

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

  // ── Chat routes ────────────────────────────────────────────

  router.get('/api/chats', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chats = await db.getUserChats(auth.userId);
    json(res, 200, { chats });
  });

  router.post('/api/chats', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { title?: string; model?: string; provider?: string };
    try { body = JSON.parse(raw); } catch { body = {}; }

    const chatId = randomUUID();
    const chat = {
      id: chatId,
      userId: auth.userId,
      title: body.title ?? 'New Chat',
      model: body.model ?? (chatEngine as any).config.defaultModel,
      provider: body.provider ?? (chatEngine as any).config.defaultProvider,
    };
    await db.createChat(chat);
    const created = await db.getChat(chatId, auth.userId);
    json(res, 201, { chat: created });
  }, { auth: true, csrf: true });

  router.get('/api/chats/:chatId/messages', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }
    const messages = await db.getMessages(chat.id);
    json(res, 200, { messages });
  });

  router.post('/api/chats/:chatId/messages', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }

    const raw = await readBody(req);
    let body: { content?: string; stream?: boolean; model?: string; provider?: string; maxTokens?: number; temperature?: number };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    if (!body.content) { json(res, 400, { error: 'content required' }); return; }

    const opts = {
      model: body.model ?? chat.model,
      provider: body.provider ?? chat.provider,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
    };

    if (body.stream) {
      await chatEngine.streamMessage(res, auth.userId, chat.id, body.content, opts);
    } else {
      const result = await chatEngine.sendMessage(auth.userId, chat.id, body.content, opts);
      json(res, 200, result);
    }
  }, { auth: true, csrf: true });

  router.del('/api/chats/:chatId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteChat(params['chatId']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Dashboard routes ───────────────────────────────────────

  router.get('/api/dashboard/overview', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const data = await dashboard.getOverview(auth.userId, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined);
    json(res, 200, data);
  });

  router.get('/api/dashboard/costs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const data = await dashboard.getCostBreakdown(auth.userId, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined);
    json(res, 200, data);
  });

  router.get('/api/dashboard/performance', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const data = await dashboard.getPerformance(auth.userId, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined);
    json(res, 200, data);
  });

  router.get('/api/dashboard/evals', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    const evals = await db.getEvals(auth.userId, from, to);
    json(res, 200, { evals });
  });

  // ── Admin: Prompts ──────────────────────────────────────────

  router.get('/api/admin/prompts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const prompts = await db.listPrompts();
    json(res, 200, { prompts });
  });

  router.get('/api/admin/prompts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const prompt = await db.getPrompt(params['id']!);
    if (!prompt) { json(res, 404, { error: 'Prompt not found' }); return; }
    json(res, 200, { prompt });
  });

  router.post('/api/admin/prompts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['template']) { json(res, 400, { error: 'name and template required' }); return; }
    const id = 'prompt-' + randomUUID().slice(0, 8);
    await db.createPrompt({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      category: (body['category'] as string) ?? null, template: body['template'] as string,
      variables: body['variables'] ? JSON.stringify(body['variables']) : null,
      version: (body['version'] as string) ?? '1.0', is_default: body['is_default'] ? 1 : 0, enabled: body['enabled'] !== false ? 1 : 0,
    });
    const prompt = await db.getPrompt(id);
    json(res, 201, { prompt });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPrompt(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['template'] !== undefined) fields['template'] = body['template'];
    if (body['variables'] !== undefined) fields['variables'] = JSON.stringify(body['variables']);
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['is_default'] !== undefined) fields['is_default'] = body['is_default'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePrompt(params['id']!, fields as any);
    const prompt = await db.getPrompt(params['id']!);
    json(res, 200, { prompt });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePrompt(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Guardrails ──────────────────────────────────────

  router.get('/api/admin/guardrails', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const guardrails = await db.listGuardrails();
    json(res, 200, { guardrails });
  });

  router.get('/api/admin/guardrails/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const g = await db.getGuardrail(params['id']!);
    if (!g) { json(res, 404, { error: 'Guardrail not found' }); return; }
    json(res, 200, { guardrail: g });
  });

  router.post('/api/admin/guardrails', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['type']) { json(res, 400, { error: 'name and type required' }); return; }
    const id = 'guard-' + randomUUID().slice(0, 8);
    await db.createGuardrail({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      type: body['type'] as string, stage: (body['stage'] as string) ?? 'pre',
      config: body['config'] ? JSON.stringify(body['config']) : null,
      priority: (body['priority'] as number) ?? 0, enabled: body['enabled'] !== false ? 1 : 0,
    });
    const guardrail = await db.getGuardrail(id);
    json(res, 201, { guardrail });
  }, { auth: true, csrf: true });

  router.put('/api/admin/guardrails/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getGuardrail(params['id']!);
    if (!existing) { json(res, 404, { error: 'Guardrail not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['type'] !== undefined) fields['type'] = body['type'];
    if (body['stage'] !== undefined) fields['stage'] = body['stage'];
    if (body['config'] !== undefined) fields['config'] = JSON.stringify(body['config']);
    if (body['priority'] !== undefined) fields['priority'] = body['priority'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateGuardrail(params['id']!, fields as any);
    const guardrail = await db.getGuardrail(params['id']!);
    json(res, 200, { guardrail });
  }, { auth: true, csrf: true });

  router.del('/api/admin/guardrails/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteGuardrail(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Routing Policies ────────────────────────────────

  router.get('/api/admin/routing', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.listRoutingPolicies();
    json(res, 200, { policies });
  });

  router.get('/api/admin/routing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const p = await db.getRoutingPolicy(params['id']!);
    if (!p) { json(res, 404, { error: 'Routing policy not found' }); return; }
    json(res, 200, { policy: p });
  });

  router.post('/api/admin/routing', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['strategy']) { json(res, 400, { error: 'name and strategy required' }); return; }
    const id = 'route-' + randomUUID().slice(0, 8);
    await db.createRoutingPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      strategy: body['strategy'] as string,
      constraints: body['constraints'] ? JSON.stringify(body['constraints']) : null,
      weights: body['weights'] ? JSON.stringify(body['weights']) : null,
      fallback_model: (body['fallback_model'] as string) ?? null,
      fallback_provider: (body['fallback_provider'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const policy = await db.getRoutingPolicy(id);
    json(res, 201, { policy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/routing/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getRoutingPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Routing policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['strategy'] !== undefined) fields['strategy'] = body['strategy'];
    if (body['constraints'] !== undefined) fields['constraints'] = JSON.stringify(body['constraints']);
    if (body['weights'] !== undefined) fields['weights'] = JSON.stringify(body['weights']);
    if (body['fallback_model'] !== undefined) fields['fallback_model'] = body['fallback_model'];
    if (body['fallback_provider'] !== undefined) fields['fallback_provider'] = body['fallback_provider'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateRoutingPolicy(params['id']!, fields as any);
    const policy = await db.getRoutingPolicy(params['id']!);
    json(res, 200, { policy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/routing/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteRoutingPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Workflows ───────────────────────────────────────

  router.get('/api/admin/workflows', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const workflows = await db.listWorkflowDefs();
    json(res, 200, { workflows });
  });

  router.get('/api/admin/workflows/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const w = await db.getWorkflowDef(params['id']!);
    if (!w) { json(res, 404, { error: 'Workflow not found' }); return; }
    json(res, 200, { workflow: w });
  });

  router.post('/api/admin/workflows', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['steps'] || !body['entry_step_id']) { json(res, 400, { error: 'name, steps, and entry_step_id required' }); return; }
    const id = 'wf-' + randomUUID().slice(0, 8);
    await db.createWorkflowDef({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      version: (body['version'] as string) ?? '1.0',
      steps: JSON.stringify(body['steps']),
      entry_step_id: body['entry_step_id'] as string,
      metadata: body['metadata'] ? JSON.stringify(body['metadata']) : null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const workflow = await db.getWorkflowDef(id);
    json(res, 201, { workflow });
  }, { auth: true, csrf: true });

  router.put('/api/admin/workflows/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getWorkflowDef(params['id']!);
    if (!existing) { json(res, 404, { error: 'Workflow not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['steps'] !== undefined) fields['steps'] = JSON.stringify(body['steps']);
    if (body['entry_step_id'] !== undefined) fields['entry_step_id'] = body['entry_step_id'];
    if (body['metadata'] !== undefined) fields['metadata'] = JSON.stringify(body['metadata']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateWorkflowDef(params['id']!, fields as any);
    const workflow = await db.getWorkflowDef(params['id']!);
    json(res, 200, { workflow });
  }, { auth: true, csrf: true });

  router.del('/api/admin/workflows/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWorkflowDef(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Tool Configs ────────────────────────────────────

  router.get('/api/admin/tools', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const tools = await db.listToolConfigs();
    json(res, 200, { tools });
  });

  router.get('/api/admin/tools/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const t = await db.getToolConfig(params['id']!);
    if (!t) { json(res, 404, { error: 'Tool config not found' }); return; }
    json(res, 200, { tool: t });
  });

  router.post('/api/admin/tools', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'tool-' + randomUUID().slice(0, 8);
    await db.createToolConfig({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      category: (body['category'] as string) ?? null, risk_level: (body['risk_level'] as string) ?? 'low',
      requires_approval: body['requires_approval'] ? 1 : 0,
      max_execution_ms: (body['max_execution_ms'] as number) ?? null,
      rate_limit_per_min: (body['rate_limit_per_min'] as number) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const tool = await db.getToolConfig(id);
    json(res, 201, { tool });
  }, { auth: true, csrf: true });

  router.put('/api/admin/tools/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getToolConfig(params['id']!);
    if (!existing) { json(res, 404, { error: 'Tool config not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['risk_level'] !== undefined) fields['risk_level'] = body['risk_level'];
    if (body['requires_approval'] !== undefined) fields['requires_approval'] = body['requires_approval'] ? 1 : 0;
    if (body['max_execution_ms'] !== undefined) fields['max_execution_ms'] = body['max_execution_ms'];
    if (body['rate_limit_per_min'] !== undefined) fields['rate_limit_per_min'] = body['rate_limit_per_min'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateToolConfig(params['id']!, fields as any);
    const tool = await db.getToolConfig(params['id']!);
    json(res, 200, { tool });
  }, { auth: true, csrf: true });

  router.del('/api/admin/tools/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteToolConfig(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Workflow Runs ──────────────────────────────────────────

  router.get('/api/workflow-runs', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const runs = await db.listWorkflowRuns();
    json(res, 200, { runs });
  });

  router.get('/api/workflow-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }
    json(res, 200, { run });
  });

  router.post('/api/workflow-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const workflow_id = body['workflow_id'] as string | undefined;
    const input = body['input'] as Record<string, unknown> | undefined;
    if (!workflow_id) { json(res, 400, { error: 'workflow_id is required' }); return; }
    const id = randomUUID();
    await db.createWorkflowRun({
      id,
      workflow_id,
      status: 'pending',
      state: JSON.stringify({ currentStepId: '', variables: input ?? {}, history: [] }),
      input: input ? JSON.stringify(input) : null,
      error: null,
      started_at: new Date().toISOString(),
    });
    json(res, 201, { ok: true, id });
  }, { auth: true, csrf: true });

  router.put('/api/workflow-runs/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    const body = JSON.parse(raw) as Partial<Omit<import('./db.js').WorkflowRunRow, 'id' | 'started_at'>>;
    await db.updateWorkflowRun(params['id']!, body);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Guardrail Evaluations ──────────────────────────────────

  router.get('/api/guardrail-evals', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chatId = url.searchParams.get('chat_id') ?? undefined;
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const evals = await db.listGuardrailEvals(chatId, limit);
    json(res, 200, { evals });
  });

  // ── Admin: Human Task Policies ─────────────────────────────

  router.get('/api/admin/task-policies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const policies = await db.listHumanTaskPolicies();
    json(res, 200, { taskPolicies: policies });
  });

  router.get('/api/admin/task-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const p = await db.getHumanTaskPolicy(params['id']!);
    if (!p) { json(res, 404, { error: 'Task policy not found' }); return; }
    json(res, 200, { taskPolicy: p });
  });

  router.post('/api/admin/task-policies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['trigger']) { json(res, 400, { error: 'name and trigger required' }); return; }
    const id = 'htp-' + randomUUID().slice(0, 8);
    await db.createHumanTaskPolicy({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      trigger: body['trigger'] as string, task_type: (body['task_type'] as string) ?? 'approval',
      default_priority: (body['default_priority'] as string) ?? 'normal',
      sla_hours: (body['sla_hours'] as number) ?? null, auto_escalate_after_hours: (body['auto_escalate_after_hours'] as number) ?? null,
      assignment_strategy: (body['assignment_strategy'] as string) ?? 'round-robin',
      assign_to: (body['assign_to'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const taskPolicy = await db.getHumanTaskPolicy(id);
    json(res, 201, { taskPolicy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/task-policies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getHumanTaskPolicy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Task policy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['trigger'] !== undefined) fields['trigger'] = body['trigger'];
    if (body['task_type'] !== undefined) fields['task_type'] = body['task_type'];
    if (body['default_priority'] !== undefined) fields['default_priority'] = body['default_priority'];
    if (body['sla_hours'] !== undefined) fields['sla_hours'] = body['sla_hours'];
    if (body['auto_escalate_after_hours'] !== undefined) fields['auto_escalate_after_hours'] = body['auto_escalate_after_hours'];
    if (body['assignment_strategy'] !== undefined) fields['assignment_strategy'] = body['assignment_strategy'];
    if (body['assign_to'] !== undefined) fields['assign_to'] = body['assign_to'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateHumanTaskPolicy(params['id']!, fields as any);
    const taskPolicy = await db.getHumanTaskPolicy(params['id']!);
    json(res, 200, { taskPolicy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/task-policies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteHumanTaskPolicy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Task Contracts ──────────────────────────────────

  router.get('/api/admin/contracts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const contracts = await db.listTaskContracts();
    json(res, 200, { contracts });
  });

  router.get('/api/admin/contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getTaskContract(params['id']!);
    if (!c) { json(res, 404, { error: 'Contract not found' }); return; }
    json(res, 200, { contract: c });
  });

  router.post('/api/admin/contracts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name']) { json(res, 400, { error: 'name required' }); return; }
    const id = 'tc-' + randomUUID().slice(0, 8);
    await db.createTaskContract({
      id, name: body['name'] as string, description: (body['description'] as string) ?? null,
      input_schema: body['input_schema'] ? (typeof body['input_schema'] === 'string' ? body['input_schema'] as string : JSON.stringify(body['input_schema'])) : null,
      output_schema: body['output_schema'] ? (typeof body['output_schema'] === 'string' ? body['output_schema'] as string : JSON.stringify(body['output_schema'])) : null,
      acceptance_criteria: body['acceptance_criteria'] ? (typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] as string : JSON.stringify(body['acceptance_criteria'])) : '[]',
      max_attempts: (body['max_attempts'] as number) ?? null,
      timeout_ms: (body['timeout_ms'] as number) ?? null,
      evidence_required: body['evidence_required'] ? (typeof body['evidence_required'] === 'string' ? body['evidence_required'] as string : JSON.stringify(body['evidence_required'])) : null,
      min_confidence: (body['min_confidence'] as number) ?? null,
      require_human_review: body['require_human_review'] ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const contract = await db.getTaskContract(id);
    json(res, 201, { contract });
  }, { auth: true, csrf: true });

  router.put('/api/admin/contracts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getTaskContract(params['id']!);
    if (!existing) { json(res, 404, { error: 'Contract not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['input_schema'] !== undefined) fields['input_schema'] = typeof body['input_schema'] === 'string' ? body['input_schema'] : JSON.stringify(body['input_schema']);
    if (body['output_schema'] !== undefined) fields['output_schema'] = typeof body['output_schema'] === 'string' ? body['output_schema'] : JSON.stringify(body['output_schema']);
    if (body['acceptance_criteria'] !== undefined) fields['acceptance_criteria'] = typeof body['acceptance_criteria'] === 'string' ? body['acceptance_criteria'] : JSON.stringify(body['acceptance_criteria']);
    if (body['max_attempts'] !== undefined) fields['max_attempts'] = body['max_attempts'];
    if (body['timeout_ms'] !== undefined) fields['timeout_ms'] = body['timeout_ms'];
    if (body['evidence_required'] !== undefined) fields['evidence_required'] = typeof body['evidence_required'] === 'string' ? body['evidence_required'] : JSON.stringify(body['evidence_required']);
    if (body['min_confidence'] !== undefined) fields['min_confidence'] = body['min_confidence'];
    if (body['require_human_review'] !== undefined) fields['require_human_review'] = body['require_human_review'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updateTaskContract(params['id']!, fields as any);
    const contract = await db.getTaskContract(params['id']!);
    json(res, 200, { contract });
  }, { auth: true, csrf: true });

  router.del('/api/admin/contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteTaskContract(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Seed data ───────────────────────────────────────

  router.post('/api/admin/seed', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.seedDefaultData();
    json(res, 200, { ok: true, message: 'Default data seeded' });
  }, { auth: true, csrf: true });

  // ── Health ─────────────────────────────────────────────────

  router.get('/health', async (_req, res) => {
    json(res, 200, { status: 'ok', service: 'geneweave', timestamp: new Date().toISOString() });
  });

  // ── HTTP server ────────────────────────────────────────────

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // API routing
    const matched = router.match(method, pathname);
    if (matched) {
      try {
        // Authenticate
        const auth = await authenticateRequest(req, db, jwtSecret);

        // Check auth requirement
        if (matched.route.requireAuth && !auth) {
          json(res, 401, { error: 'Authentication required' });
          return;
        }

        // Check CSRF for mutating requests
        if (matched.route.requireCSRF && auth && !verifyCSRF(req, auth)) {
          json(res, 403, { error: 'Invalid CSRF token' });
          return;
        }

        await matched.route.handler(req, res, matched.params, auth);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Internal server error';
        console.error(`[geneWeave] Error handling ${method} ${pathname}:`, err);
        if (!res.headersSent) json(res, 500, { error: msg });
      }
      return;
    }

    // Serve UI for all non-API routes (SPA)
    if (method === 'GET') {
      html(res, 200, uiHtml);
      return;
    }

    json(res, 404, { error: 'Not found' });
  });

  return server;
}
