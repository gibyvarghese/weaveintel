/**
 * @weaveintel/geneweave — HTTP server + routes
 *
 * Zero-dependency HTTP server built on node:http with a hand-rolled router,
 * JSON body parsing, cookie handling, CORS, auth middleware, and SSE support.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter } from './db.js';
import type { ChatEngine } from './chat.js';
import type { ChatAttachment } from './chat.js';
import { DashboardService } from './dashboard.js';
import { getAvailableTools } from './tools.js';
import { canPersonaAccess, isValidPersona, normalizePersona, personaPermissions } from './rbac.js';
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
import { getHTML } from './ui-server.js';
import { registerAdminRoutes } from './server-admin.js';
import { registerSVRoutes } from './features/scientific-validation/index.js';
import { encryptCredential, decryptCredential } from './vault.js';
import { setBrowserAuthProvider, type SSOPassThroughAuth } from '@weaveintel/tools-browser';
import { OAuthClient, createOAuthProvider, type OAuthProviderName } from '@weaveintel/oauth';
import { getAllProviders, getProvider, checkAllProviders, type ExternalCredential } from './password-providers.js';

// ─── Router ──────────────────────────────────────────────────

// Hand-rolled URL router built on RegExp matching. Supports
// param extraction (:id), auth enforcement, and CSRF validation.
// POST/PUT/DELETE routes require CSRF by default.
// This avoids pulling in Express or Fastify as dependencies.

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
    const maxFromEnv = Number.parseInt(process.env['GENEWEAVE_MAX_REQUEST_BODY_BYTES'] ?? '', 10);
    const MAX = Number.isFinite(maxFromEnv) && maxFromEnv > 0
      ? maxFromEnv
      : 50 * 1024 * 1024; // 50 MB default to support attachment payloads.
    let tooLarge = false;

    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        reject(new Error('Request body too large'));
        return;
      }
      resolve(Buffer.concat(chunks).toString());
    });
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

function permissionForAdminRoute(path: string): string {
  if (path === '/api/admin/upgrade' || path.startsWith('/api/admin/tenants')) {
    return 'admin:platform:write';
  }
  if (path.startsWith('/api/admin/rbac')) {
    return 'admin:platform:write';
  }
  return 'admin:tenant:write';
}

function ensurePermission(
  auth: AuthContext | null,
  permission: string,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!auth) {
    return { ok: false, status: 401, error: 'Not authenticated' };
  }
  if (!canPersonaAccess(auth.persona, permission)) {
    return { ok: false, status: 403, error: `Missing permission: ${permission}` };
  }
  return { ok: true };
}

async function ensureAtLeastOneTenantAdmin(db: DatabaseAdapter, preferredUserId?: string): Promise<void> {
  const users = await db.listUsers();
  if (users.length === 0) return;

  const hasAdmin = users.some((u) => {
    const persona = normalizePersona(u.persona, 'user');
    return persona === 'tenant_admin' || persona === 'platform_admin';
  });
  if (hasAdmin) return;

  const preferred = preferredUserId ? users.find((u) => u.id === preferredUserId) : undefined;
  const fallback = preferred ?? users
    .slice()
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
  if (!fallback) return;

  await db.updateUserPersona(fallback.id, 'tenant_admin');
}

// ─── OAuth Flow State (in-memory, production should use Redis) ──────────

const oauthClient = new OAuthClient();
const oauthStateStore = new Map<string, { userId: string | null; provider: OAuthProviderName; expiresAt: number }>();

function setOAuthState(state: string, value: { userId: string | null; provider: OAuthProviderName; expiresAt: number }): void {
  oauthStateStore.set(state, value);
}

function getOAuthState(state: string): { userId: string | null; provider: OAuthProviderName; expiresAt: number } | null {
  const found = oauthStateStore.get(state);
  if (!found) return null;
  if (Date.now() > found.expiresAt) {
    oauthStateStore.delete(state);
    return null;
  }
  return found;
}

function deleteOAuthState(state: string): void {
  oauthStateStore.delete(state);
}

function normalizePublicOrigin(value: string): string {
  const parsed = new URL(value);
  return parsed.origin;
}

function resolveRequestOrigin(req: IncomingMessage): string {
  const hostHeader = req.headers['host'];
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host) throw new Error('Missing Host header');
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return normalizePublicOrigin(`${protocol}://${host}`);
}

function buildOAuthProviderFromRequest(provider: OAuthProviderName, req: IncomingMessage, publicBaseUrl?: string) {
  const baseUrl = publicBaseUrl ? normalizePublicOrigin(publicBaseUrl) : resolveRequestOrigin(req);
  const redirectUri = `${baseUrl}/api/oauth/callback`;
  const clientId = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_ID`];
  const clientSecret = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) throw new Error(`${provider} credentials not configured`);
  return createOAuthProvider(provider, clientId, clientSecret, redirectUri);
}

const oauthStateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of oauthStateStore.entries()) {
    if (now > value.expiresAt) oauthStateStore.delete(key);
  }
}, 60_000);
oauthStateCleanupTimer.unref?.();

// ─── Server factory ─────────────────────────────────────────

// createGeneWeaveServer() wires together all HTTP routes:
//   /api/auth/*       — Login/register/logout (JWT cookies, scrypt hashing)
//   /api/chats/*      — CRUD + streaming chat via ChatEngine (SSE)
//   /api/dashboard/*  — Analytics from DashboardService
//   /api/admin/*      — Admin CRUD for guardrails, routing, prompts, etc.
//   /*                — SPA fallback serving the embedded UI from ui.ts─

export interface ServerConfig {
  db: DatabaseAdapter;
  chatEngine: ChatEngine;
  jwtSecret: string;
  corsOrigin?: string;
  providers?: Record<string, { apiKey: string }>;
  publicBaseUrl?: string;
}

export function createGeneWeaveServer(config: ServerConfig): Server {
  const { db, chatEngine, jwtSecret, corsOrigin, providers, publicBaseUrl } = config;
  const dashboard = new DashboardService(db);
  const router = new Router();
  const uiHtml = getHTML();

  // ── Auth routes ────────────────────────────────────────

  // Auth routes use signJWT/verifyJWT + hashPassword/verifyPassword from auth.ts.
  // Sessions are stored in the database; JWT cookie (HttpOnly, SameSite=Strict)
  // carries the session reference. CSRF tokens are returned to the client and
  // validated on state-changing requests.────

  router.post('/api/auth/register', async (req, res) => {
    const raw = await readBody(req);
    let body: { name?: string; email?: string; password?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const { name, email, password } = body;
    if (!name || !email || !password) { json(res, 400, { error: 'name, email, and password required' }); return; }
    if (password.length < 8) { json(res, 400, { error: 'Password must be at least 8 characters' }); return; }

    const existing = await db.getUserByEmail(email);
    if (existing) { json(res, 409, { error: 'Email already registered' }); return; }

    const users = await db.listUsers();
    const assignedPersona = users.length === 0 ? 'tenant_admin' : 'tenant_user';

    const userId = randomUUID();
    const passwordHash = hashPassword(password);
    await db.createUser({ id: userId, email, name, passwordHash, persona: assignedPersona });
    await ensureAtLeastOneTenantAdmin(db, userId);

    const sessionId = randomUUID();
    const csrfToken = generateCSRFToken();
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    await db.createSession({ id: sessionId, userId, csrfToken, expiresAt });

    const token = signJWT({ userId, email, sessionId }, jwtSecret);
    setAuthCookie(res, token);
    const created = await db.getUserById(userId);
    json(res, 201, { user: { id: userId, email, name, persona: created?.persona ?? assignedPersona }, csrfToken });
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

    await ensureAtLeastOneTenantAdmin(db, user.id);
    const effectiveUser = (await db.getUserById(user.id)) ?? user;

    const sessionId = randomUUID();
    const csrfToken = generateCSRFToken();
    const expiresAt = new Date(Date.now() + 86400_000).toISOString();
    await db.createSession({ id: sessionId, userId: effectiveUser.id, csrfToken, expiresAt });

    const token = signJWT({ userId: effectiveUser.id, email: effectiveUser.email, sessionId }, jwtSecret);
    setAuthCookie(res, token);
    json(res, 200, {
      user: { id: effectiveUser.id, email: effectiveUser.email, name: effectiveUser.name, persona: effectiveUser.persona, tenantId: effectiveUser.tenant_id },
      csrfToken,
      permissions: personaPermissions(effectiveUser.persona),
    });
  }, { csrf: false });

  router.post('/api/auth/logout', async (_req, _res, _params, auth) => {
    if (auth) await db.deleteSession(auth.sessionId);
    clearAuthCookie(_res);
    json(_res, 200, { ok: true });
  }, { auth: false, csrf: false });

  router.get('/api/auth/me', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await ensureAtLeastOneTenantAdmin(db, auth.userId);
    const user = await db.getUserById(auth.userId);
    if (!user) { json(res, 401, { error: 'User not found' }); return; }
    json(res, 200, {
      user: { id: user.id, email: user.email, name: user.name, persona: user.persona, tenantId: user.tenant_id },
      csrfToken: auth.csrfToken,
      permissions: personaPermissions(user.persona),
    });
  });

  // Auth check endpoint for UI bootstrap.
  // Always returns 200 to avoid noisy console "Failed to load resource: 401" on logged-out startup.
  router.get('/api/auth/check', async (_req, res, _params, auth) => {
    if (!auth) {
      json(res, 200, { authenticated: false });
      return;
    }

    await ensureAtLeastOneTenantAdmin(db, auth.userId);
    const user = await db.getUserById(auth.userId);
    if (!user) {
      json(res, 200, { authenticated: false });
      return;
    }

    json(res, 200, {
      authenticated: true,
      user: { id: user.id, email: user.email, name: user.name, persona: user.persona, tenantId: user.tenant_id },
      csrfToken: auth.csrfToken,
      permissions: personaPermissions(user.persona),
    });
  });

  router.get('/api/auth/permissions', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, {
      persona: auth.persona,
      effectivePersona: isValidPersona(auth.persona) ? auth.persona : null,
      permissions: personaPermissions(auth.persona),
    });
  }, { auth: true });

  // ── OAuth routes ───────────────────────────────────────────

  // List all linked OAuth accounts for the authenticated user
  router.get('/api/oauth/accounts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const accounts = await db.listOAuthLinkedAccounts(auth.userId);
    // Return sanitized account info (no sensitive data)
    const sanitized = accounts.map(acc => ({
      id: acc.id,
      provider: acc.provider,
      email: acc.email,
      name: acc.name,
      picture_url: acc.picture_url,
      linked_at: acc.linked_at,
      last_used_at: acc.last_used_at,
    }));
    json(res, 200, { accounts: sanitized });
  });

  // Unlink an OAuth account
  router.post('/api/oauth/accounts/:provider/unlink', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const provider = params['provider'];
    if (!provider) { json(res, 400, { error: 'Provider required' }); return; }
    
    await db.deleteOAuthLinkedAccount(auth.userId, provider);
    json(res, 200, { ok: true });
  });

  // Generate OAuth authorization URL for a provider
  // Expected body: { provider: 'google' | 'github' | 'microsoft' | 'apple' | 'facebook' }
  router.post('/api/oauth/authorize-url', async (req, res, _params, auth) => {
    const raw = await readBody(req);
    let body: { provider?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const provider = body.provider?.toLowerCase() as OAuthProviderName | undefined;
    if (!provider) { json(res, 400, { error: 'provider required' }); return; }
    if (!['google', 'github', 'microsoft', 'apple', 'facebook'].includes(provider)) {
      json(res, 400, { error: 'Invalid provider' }); return;
    }

    try {
      const state = randomUUID();
      const oauthProvider = buildOAuthProviderFromRequest(provider, req);
      const { authUrl } = await oauthClient.generateAuthorizationUrl(oauthProvider, state);
      setOAuthState(state, { userId: auth?.userId ?? null, provider, expiresAt: Date.now() + 600_000 });
      json(res, 200, { authUrl });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      json(res, 500, { error: msg });
    }
  }, { auth: false, csrf: false });

  // OAuth callback handler (handles redirect from providers)
  const handleOAuthCallback = async (req: IncomingMessage, res: ServerResponse, callbackParams: Record<string, string>) => {
    const { code, state, error } = callbackParams;

    if (error) { json(res, 400, { error: `OAuth error: ${error}` }); return; }
    if (!code || !state) { json(res, 400, { error: 'Missing code or state' }); return; }

    const stateData = getOAuthState(state);
    if (!stateData) { json(res, 400, { error: 'Invalid or expired state' }); return; }
    if (Date.now() > stateData.expiresAt) { json(res, 400, { error: 'State expired' }); return; }

    const { userId: stateUserId, provider } = stateData;

    try {
      const oauthProvider = buildOAuthProviderFromRequest(provider, req);
      const { token } = await oauthClient.exchangeCodeForToken(oauthProvider, code, state);
      const oauthProfile = await oauthClient.getUserProfile(oauthProvider, token.access_token, token);

      const existingLinked = await db.getOAuthLinkedAccountByProviderUserId(provider, oauthProfile.id);

      // Prevent linking a provider identity already bound to a different account.
      if (stateUserId && existingLinked && existingLinked.user_id !== stateUserId) {
        json(res, 409, { error: 'This OAuth account is already linked to another user' });
        return;
      }

      let resolvedUserId = stateUserId;

      if (!resolvedUserId && existingLinked) {
        resolvedUserId = existingLinked.user_id;
      }

      if (!resolvedUserId) {
        resolvedUserId = randomUUID();
        const fallbackEmail = (oauthProfile.email && oauthProfile.email.includes('@'))
          ? oauthProfile.email
          : `${provider}-${oauthProfile.id}@oauth.local`;
        const fallbackName = oauthProfile.name || `${provider} user`;
        await db.createUser({
          id: resolvedUserId,
          email: fallbackEmail,
          name: fallbackName,
          passwordHash: hashPassword(randomUUID()),
        });
      }

      await db.createOAuthLinkedAccount({
        id: randomUUID(),
        user_id: resolvedUserId,
        provider,
        provider_user_id: oauthProfile.id,
        email: oauthProfile.email || `${provider}-${oauthProfile.id}@oauth.local`,
        name: oauthProfile.name || 'User',
        picture_url: oauthProfile.picture || null,
        last_used_at: new Date().toISOString(),
      });

      // For OAuth sign-in from logged-out state, establish a session cookie.
      if (!stateUserId) {
        const user = await db.getUserById(resolvedUserId);
        if (!user) throw new Error('User not found after OAuth sign-in');
        const sessionId = randomUUID();
        const csrfToken = generateCSRFToken();
        const expiresAt = new Date(Date.now() + 86400_000).toISOString();
        await db.createSession({ id: sessionId, userId: resolvedUserId, csrfToken, expiresAt });
        const jwt = signJWT({ userId: resolvedUserId, email: user.email, sessionId }, jwtSecret);
        setAuthCookie(res, jwt);
      }

      html(
        res,
        200,
        '<html><body><script>if(window.opener){window.opener.postMessage({type:"oauth-success"}, window.location.origin);}window.close();</script>Account linked successfully! You can close this window.</body></html>',
      );
    } catch (err) {
      json(res, 500, { error: `Failed to link account: ${(err as Error).message}` });
    } finally {
      deleteOAuthState(state);
    }
  };

  router.get('/api/oauth/callback', async (req, res) => {
    const url = req.url ?? '';
    const queryStr = url.split('?')[1] ?? '';
    const params: Record<string, string> = {};
    queryStr.split('&').forEach(pair => {
      const [key, val] = pair.split('=');
      if (key && val) params[decodeURIComponent(key)] = decodeURIComponent(val);
    });
    await handleOAuthCallback(req, res, params);
  }, { auth: false });

  router.post('/api/oauth/callback', async (req, res) => {
    const raw = await readBody(req);
    const body = new URLSearchParams(raw);
    const params: Record<string, string> = {};
    for (const [key, value] of body.entries()) params[key] = value;
    await handleOAuthCallback(req, res, params);
  }, { auth: false, csrf: false });

  // ── Model routes ───────────────────────────────────────────

  router.get('/api/models', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const models = await chatEngine.getAvailableModels();
    json(res, 200, {
      models,
      defaultModel: (chatEngine as any).config.defaultProvider + ':' + (chatEngine as any).config.defaultModel,
    });
  });

  // ── Tools routes ───────────────────────────────────────────

  router.get('/api/tools', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    json(res, 200, { tools: getAvailableTools(auth.persona), persona: normalizePersona(auth.persona) });
  });

  // ── User preferences routes ────────────────────────────────

  router.get('/api/user/preferences', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const prefs = await db.getUserPreferences(auth.userId);
    json(res, 200, { preferences: prefs ?? { default_mode: 'direct', theme: 'light' } });
  });

  router.post('/api/user/preferences', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const mode = (body['default_mode'] as string) || 'direct';
    const theme = (body['theme'] as string) || 'light';
    if (!['direct', 'agent', 'supervisor'].includes(mode)) {
      json(res, 400, { error: 'default_mode must be "direct", "agent", or "supervisor"' }); return;
    }
    if (!['light', 'dark'].includes(theme)) {
      json(res, 400, { error: 'theme must be "light" or "dark"' }); return;
    }
    await db.saveUserPreferences(auth.userId, mode, theme);
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
        agent: ['datetime', 'timezone_info', 'timer_start', 'timer_pause', 'timer_resume', 'timer_stop', 'timer_status', 'timer_list', 'stopwatch_start', 'stopwatch_lap', 'stopwatch_pause', 'stopwatch_resume', 'stopwatch_stop', 'stopwatch_status', 'reminder_create', 'reminder_list', 'reminder_cancel', 'calculator', 'json_format', 'text_analysis', 'memory_recall', 'web_search', 'cse_run_code', 'cse_session_status', 'cse_end_session', 'browser_open', 'browser_close', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_snapshot', 'browser_screenshot', 'browser_click', 'browser_fill', 'browser_select', 'browser_type', 'browser_hover', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_detect_auth', 'browser_login', 'browser_save_cookies', 'browser_handoff_request', 'browser_handoff_resume'],
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

  // ── Chat routes ────────────────────────────────────────

  // Chat routes delegate to ChatEngine which orchestrates WeaveIntel:
  //   • GET /api/chats          — list user’s conversations
  //   • POST /api/chats         — create a new chat (sets model + provider)
  //   • POST /api/chats/:id/messages — send a message, returns SSE stream
  //     ChatEngine.streamMessage() wires: redaction → guardrails → model → eval────

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

  router.put('/api/chats/:chatId', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }

    const raw = await readBody(req);
    let body: { title?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const title = String(body.title ?? '').trim();
    if (!title) { json(res, 400, { error: 'title required' }); return; }

    await db.updateChatTitle(chat.id, auth.userId, title.slice(0, 200));
    const updated = await db.getChat(chat.id, auth.userId);
    json(res, 200, { chat: updated });
  }, { auth: true, csrf: true });

  router.post('/api/chats/:chatId/messages', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const chat = await db.getChat(params['chatId']!, auth.userId);
    if (!chat) { json(res, 404, { error: 'Chat not found' }); return; }

    const raw = await readBody(req);
    let body: {
      content?: string;
      stream?: boolean;
      model?: string;
      provider?: string;
      maxTokens?: number;
      temperature?: number;
      attachments?: ChatAttachment[];
    };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const normalizedContent = typeof body.content === 'string' ? body.content.trim() : '';

    const normalizedAttachments = Array.isArray(body.attachments)
      ? body.attachments
          .slice(0, 8)
          .filter((a): a is ChatAttachment => {
            return !!a
              && typeof a.name === 'string'
              && a.name.trim().length > 0
              && typeof a.mimeType === 'string'
              && a.mimeType.trim().length > 0
              && typeof a.size === 'number'
              && Number.isFinite(a.size)
              && a.size > 0
              && a.size <= 4 * 1024 * 1024;
          })
      : undefined;

    if (!normalizedContent && (!normalizedAttachments || normalizedAttachments.length === 0)) {
      json(res, 400, { error: 'content or attachments required' });
      return;
    }

    const opts = {
      model: body.model ?? chat.model,
      provider: body.provider ?? chat.provider,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
      attachments: normalizedAttachments,
    };

    if (body.stream) {
      await chatEngine.streamMessage(res, auth.userId, chat.id, normalizedContent, opts);
    } else {
      const result = await chatEngine.sendMessage(auth.userId, chat.id, normalizedContent, opts);
      json(res, 200, result);
    }
  }, { auth: true, csrf: true });

  router.del('/api/chats/:chatId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteChat(params['chatId']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Dashboard routes ───────────────────────────────────

  // Dashboard routes use DashboardService which queries the metrics table.
  // Each endpoint returns aggregated data for the authenticated user:
  //   • /overview     — total chats, messages, token usage, cost summary
  //   • /costs        — per-model cost breakdown over time
  //   • /performance  — latency percentiles and throughput
  //   • /evals        — eval assertion results (pass/fail/score)────

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


  // ── Admin routes (extracted to server-admin.ts) ─────────
  // Admin CRUD for guardrails, routing policies, prompts, tools,
  // workflows, HITL policies, and system settings. Each entity
  // maps to a database table via the DatabaseAdapter.
  const adminRouter = {
    get: (path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }) => {
      router.get(path, async (req, res, params, auth) => {
        const gate = ensurePermission(auth, permissionForAdminRoute(path));
        if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
        await handler(req, res, params, auth);
      }, opts);
    },
    post: (path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }) => {
      router.post(path, async (req, res, params, auth) => {
        const gate = ensurePermission(auth, permissionForAdminRoute(path));
        if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
        await handler(req, res, params, auth);
      }, opts);
    },
    put: (path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }) => {
      router.put(path, async (req, res, params, auth) => {
        const gate = ensurePermission(auth, permissionForAdminRoute(path));
        if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
        await handler(req, res, params, auth);
      }, opts);
    },
    del: (path: string, handler: Handler, opts?: { auth?: boolean; csrf?: boolean }) => {
      router.del(path, async (req, res, params, auth) => {
        const gate = ensurePermission(auth, permissionForAdminRoute(path));
        if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
        await handler(req, res, params, auth);
      }, opts);
    },
  };

  registerAdminRoutes(adminRouter, db, json, readBody, providers, html);

  // ── Scientific Validation feature routes ────────────────────
  registerSVRoutes(router, db, json, readBody);

  router.get('/api/admin/rbac/personas', async (_req, res, _params, auth) => {
    const gate = ensurePermission(auth, 'admin:platform:write');
    if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
    json(res, 200, {
      personas: ['platform_admin', 'tenant_admin', 'tenant_user', 'agent_worker', 'agent_researcher', 'agent_supervisor'],
    });
  }, { auth: true });

  router.get('/api/admin/rbac/users', async (_req, res, _params, auth) => {
    const gate = ensurePermission(auth, 'admin:platform:write');
    if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
    const users = await db.listUsers();
    json(res, 200, {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        persona: normalizePersona(user.persona),
        tenantId: user.tenant_id,
        createdAt: user.created_at,
      })),
    });
  }, { auth: true });

  router.post('/api/admin/rbac/users/:id/persona', async (req, res, params, auth) => {
    const gate = ensurePermission(auth, 'admin:platform:write');
    if (!gate.ok) { json(res, gate.status, { error: gate.error }); return; }
    const targetUser = await db.getUserById(params['id']!);
    if (!targetUser) { json(res, 404, { error: 'User not found' }); return; }

    const raw = await readBody(req);
    let body: { persona?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!isValidPersona(body.persona)) {
      json(res, 400, { error: 'Invalid persona value' });
      return;
    }
    const nextPersona = body.persona.trim().toLowerCase();

    await db.updateUserPersona(targetUser.id, nextPersona);
    json(res, 200, {
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        persona: nextPersona,
        tenantId: targetUser.tenant_id,
      },
    });
  }, { auth: true, csrf: true });

  // ── Website Credentials (Browser Auth Vault) ───────────────

  router.get('/api/credentials', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const rows = await db.listWebsiteCredentials(auth.userId);
    // Never expose encrypted creds to client — return metadata only
    const creds = rows.map(r => ({
      id: r.id,
      siteName: r.site_name,
      siteUrlPattern: r.site_url_pattern,
      authMethod: r.auth_method,
      lastUsedAt: r.last_used_at,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
    json(res, 200, { credentials: creds });
  }, { auth: true });

  router.post('/api/credentials', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { siteName?: string; siteUrlPattern?: string; authMethod?: string; config?: Record<string, unknown> };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body.siteName || !body.siteUrlPattern || !body.authMethod || !body.config) {
      json(res, 400, { error: 'siteName, siteUrlPattern, authMethod, and config are required' }); return;
    }
    const id = `wc-${randomUUID().slice(0, 8)}`;
    const { encrypted, iv } = encryptCredential(body.config);
    await db.createWebsiteCredential({
      id,
      user_id: auth.userId,
      site_name: body.siteName,
      site_url_pattern: body.siteUrlPattern,
      auth_method: body.authMethod,
      credentials_encrypted: encrypted,
      encryption_iv: iv,
      last_used_at: null,
      status: 'active',
    });
    json(res, 201, { id, siteName: body.siteName, status: 'active' });
  }, { auth: true, csrf: true });

  router.put('/api/credentials/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getWebsiteCredential(params['id']!, auth.userId);
    if (!existing) { json(res, 404, { error: 'Credential not found' }); return; }
    const raw = await readBody(req);
    let body: { siteName?: string; siteUrlPattern?: string; authMethod?: string; config?: Record<string, unknown>; status?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const updates: Record<string, unknown> = {};
    if (body.siteName) updates['site_name'] = body.siteName;
    if (body.siteUrlPattern) updates['site_url_pattern'] = body.siteUrlPattern;
    if (body.authMethod) updates['auth_method'] = body.authMethod;
    if (body.status) updates['status'] = body.status;
    if (body.config) {
      const { encrypted, iv } = encryptCredential(body.config);
      updates['credentials_encrypted'] = encrypted;
      updates['encryption_iv'] = iv;
    }
    await db.updateWebsiteCredential(params['id']!, auth.userId, updates);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  router.del('/api/credentials/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deleteWebsiteCredential(params['id']!, auth.userId);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── External Password Manager Import ──────────────────────

  router.get('/api/password-providers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const statuses = await checkAllProviders();
    json(res, 200, statuses);
  }, { auth: true });

  router.post('/api/password-providers/import', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { provider: string; config?: Record<string, string>; search?: string };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body.provider) { json(res, 400, { error: 'provider is required' }); return; }

    const provider = getProvider(body.provider);
    if (!provider) { json(res, 400, { error: `Unknown provider: ${body.provider}` }); return; }

    const status = await provider.checkAvailability();
    if (!status.available) { json(res, 400, { error: `Provider unavailable: ${status.reason}` }); return; }

    let credentials: ExternalCredential[];
    try {
      credentials = await provider.listCredentials(body.config ?? {}, body.search);
    } catch (e: unknown) {
      json(res, 500, { error: `Import failed: ${e instanceof Error ? e.message : String(e)}` }); return;
    }

    // Bulk-import into vault
    let imported = 0;
    for (const cred of credentials) {
      if (!cred.username && !cred.password) continue;
      const id = `wc-${randomUUID().slice(0, 8)}`;
      const config: Record<string, unknown> = {
        type: 'form_fill',
        username: cred.username,
        password: cred.password,
      };
      const { encrypted, iv } = encryptCredential(config);
      try {
        await db.createWebsiteCredential({
          id,
          user_id: auth.userId,
          site_name: cred.title || 'Imported',
          site_url_pattern: cred.url || '*',
          auth_method: 'form_fill',
          credentials_encrypted: encrypted,
          encryption_iv: iv,
          last_used_at: null,
          status: 'active',
        });
        imported++;
      } catch { /* skip duplicates */ }
    }

    json(res, 200, { imported, total: credentials.length, provider: body.provider });
  }, { auth: true, csrf: true });

  // ── SSO Pass-Through (Identity Provider Sessions) ──────────

  router.get('/api/sso/providers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const linked = await db.listSSOLinkedAccounts(auth.userId);
    json(res, 200, { providers: linked });
  }, { auth: true });

  router.post('/api/sso/capture', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: { identityProvider: string; email?: string; cookies: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; expires?: number }> };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    
    if (!body.identityProvider || !body.cookies) {
      json(res, 400, { error: 'identityProvider and cookies are required' }); return;
    }

    const ssoSession: SSOPassThroughAuth = {
      method: 'sso_passthrough',
      identityProvider: body.identityProvider,
      email: body.email,
      cookies: body.cookies,
    };

    const { encrypted, iv } = encryptCredential(ssoSession);
    const id = `sso-${randomUUID().slice(0, 8)}`;
    
    try {
      await db.createSSOLinkedAccount({
        id,
        user_id: auth.userId,
        identity_provider: body.identityProvider,
        email: body.email,
        session_encrypted: encrypted,
        encryption_iv: iv,
      });
      json(res, 201, { id, provider: body.identityProvider, email: body.email, cookiesCaptured: body.cookies.length });
    } catch (e: unknown) {
      json(res, 500, { error: `Failed to save SSO session: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, { auth: true, csrf: true });

  router.del('/api/sso/providers/:provider', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const provider = params['provider']!;
    await db.deleteSSOLinkedAccount(auth.userId, provider);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Wire Browser Auth Provider ─────────────────────────────
  // Connects the credential vault to the browser auth tools so
  // browser_login can look up and decrypt stored credentials.

  setBrowserAuthProvider({
    async getCredential(url: string, userId?: string) {
      // Prefer credentials scoped to the current authenticated user.
      const rows = userId
        ? (await db.listWebsiteCredentials(userId)).filter(r => r.status === 'active')
        : await db.listAllActiveWebsiteCredentials();
      for (const row of rows) {
        try {
          const pattern = row.site_url_pattern;
          // Convert glob or literal URL to regex: *.example.com/* → .*\.example\.com\/.*
          const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
          if (new RegExp(`^${escaped}$`, 'i').test(url) || url.includes(pattern.replace(/\*/g, ''))) {
            const config = decryptCredential(row.credentials_encrypted);
            return config as import('@weaveintel/tools-browser').BrowserAuthConfig;
          }
        } catch { /* skip broken entries */ }
      }
      return null;
    },
    async getSSOSession(identityProvider: string, userId?: string) {
      if (!userId) return null;
      const row = await db.getSSOLinkedAccount(userId, identityProvider);
      if (!row) return null;
      try {
        const session = decryptCredential<SSOPassThroughAuth>(row.session_encrypted);
        return session;
      } catch {
        return null;
      }
    },
    async saveSSOSession(session: import('@weaveintel/tools-browser').SSOPassThroughAuth, userId?: string) {
      if (!userId) return;
      const { encrypted, iv } = encryptCredential(session);
      await db.createSSOLinkedAccount({
        id: `sso-${randomUUID().slice(0, 8)}`,
        user_id: userId,
        identity_provider: session.identityProvider,
        email: session.email,
        session_encrypted: encrypted,
        encryption_iv: iv,
      });
    },
    async listSSOProviders(userId?: string) {
      if (!userId) return [];
      const linked = await db.listSSOLinkedAccounts(userId);
      return linked.map(p => ({
        provider: p.identity_provider,
        email: p.email ?? undefined,
        linkedAt: p.linked_at,
      }));
    },
  });

  // ── Health ─────────────────────────────────────────────────

  // ── Compute Sandbox Engine (CSE) ───────────────────────────

  router.get('/api/sandbox/status', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { getCSE, isCSEEnabled } = await import('./cse.js');
    if (!isCSEEnabled()) {
      json(res, 200, { enabled: false, message: 'CSE is not configured. Set CSE_PROVIDER or cloud credentials.' });
      return;
    }
    const cse = await getCSE();
    if (!cse) { json(res, 503, { error: 'CSE unavailable' }); return; }
    const health = await cse.healthCheck();
    json(res, health.healthy ? 200 : 503, { enabled: true, ...health });
  });

  router.post('/api/sandbox/execute', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { getCSE, isCSEEnabled } = await import('./cse.js');
    if (!isCSEEnabled()) { json(res, 503, { error: 'CSE is not configured' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { code, language, chatId, sessionId, files, env: envVars, timeoutMs, networkAccess, withBrowser } = body;

    if (!code || typeof code !== 'string' || code.trim() === '') {
      json(res, 400, { error: 'code is required' });
      return;
    }

    // Restrict env vars to safe keys only (no overriding system vars)
    const safeEnv: Record<string, string> = {};
    if (envVars && typeof envVars === 'object') {
      for (const [k, v] of Object.entries(envVars as Record<string, unknown>)) {
        if (/^[A-Z_][A-Z0-9_]*$/i.test(k) && typeof v === 'string') safeEnv[k] = v;
      }
    }

    const cse = await getCSE();
    if (!cse) { json(res, 503, { error: 'CSE unavailable' }); return; }

    const languageValue =
      language === 'python' ||
      language === 'javascript' ||
      language === 'typescript' ||
      language === 'bash' ||
      language === 'shell'
        ? language
        : undefined;

    const result = await cse.run({
      code,
      language: languageValue,
      userId: auth.userId,
      chatId: typeof chatId === 'string' ? chatId : undefined,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      files: Array.isArray(files) ? files as Array<{ name: string; content: string; binary?: boolean }> : undefined,
      env: safeEnv,
      timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
      networkAccess: typeof networkAccess === 'boolean' ? networkAccess : undefined,
      withBrowser: typeof withBrowser === 'boolean' ? withBrowser : false,
    });

    json(res, result.status === 'success' ? 200 : 422, result);
  }, { auth: true, csrf: true });

  router.get('/api/sandbox/sessions', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { getCSE, isCSEEnabled } = await import('./cse.js');
    if (!isCSEEnabled()) { json(res, 200, { sessions: [] }); return; }
    const cse = await getCSE();
    if (!cse) { json(res, 200, { sessions: [] }); return; }
    json(res, 200, { sessions: cse.listSessions() });
  });

  router.del('/api/sandbox/sessions/:sessionId', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    const { getCSE } = await import('./cse.js');
    const cse = await getCSE();
    if (!cse) { json(res, 404, { error: 'No active CSE' }); return; }
    const sessionId = params['sessionId'];
    if (!sessionId) { json(res, 400, { error: 'sessionId required' }); return; }
    await cse.terminateSession(sessionId);
    json(res, 200, { terminated: true, sessionId });
  }, { auth: true, csrf: true });

  router.get('/health', async (_req, res) => {
    json(res, 200, { status: 'ok', service: 'geneweave', timestamp: new Date().toISOString() });
  });

  // ── Avatar static files ────────────────────────────────────

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const avatarDirs = [
    join(__dirname, '..', 'avatar'),
    join(__dirname, '..', 'avatars'),
    join(process.cwd(), 'packages', 'geneweave', 'avatar'),
    join(process.cwd(), 'packages', 'geneweave', 'avatars'),
    join(process.cwd(), 'avatar'),
    join(process.cwd(), 'avatars'),
  ];
  const distDir = join(__dirname, '..', 'dist');
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

    console.log(`[DEBUG] Request: ${method} ${pathname}`);

    // Serve UI module files (but NOT admin-schema.js - it's embedded in HTML)
    if ((method === 'GET' || method === 'HEAD') && pathname.match(/^\/(?:ui(?:\/|\.))/)) {
      // Map /ui.js to /ui-client.js (client-side only module)
      let filename = pathname.slice(1);
      if (filename === 'ui.js') {
        filename = 'ui-client.js';
      }
      const filepath = join(distDir, filename);
      try {
        const data = await fsReadFile(filepath);
        const contentType = filename.endsWith('.js') ? 'application/javascript' : 'application/json';
        res.writeHead(200, {
          'Content-Type': contentType + '; charset=utf-8',
          'Content-Length': data.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        });
        if (method === 'GET') {
          res.end(data);
        } else {
          res.end(); // HEAD request: don't send body
        }
        return;
      } catch (err) {
        json(res, 404, { error: 'Not found' });
        return;
      }
    }

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
        if (!res.headersSent) {
          if (msg === 'Request body too large') {
            json(res, 413, { error: 'Request body too large' });
          } else {
            json(res, 500, { error: msg });
          }
        }
      }
      return;
    }

    // Serve avatar images
    const avatarMatch = pathname.match(/^\/avatar\/(avatar-\d+\.webp)$/);
    if (method === 'GET' && avatarMatch) {
      const filename = avatarMatch[1]!;
      let data: Buffer | null = null;
      for (const dir of avatarDirs) {
        try {
          data = await fsReadFile(join(dir, filename));
          break;
        } catch {
          // Try next candidate directory.
        }
      }
      if (data) {
        res.writeHead(200, {
          'Content-Type': 'image/webp',
          'Content-Length': data.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(data);
      } else {
        json(res, 404, { error: 'Avatar not found' });
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
