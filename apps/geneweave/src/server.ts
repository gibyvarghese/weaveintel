/**
 * @weaveintel/geneweave — HTTP server + routes
 *
 * Zero-dependency HTTP server built on node:http with a hand-rolled router,
 * JSON body parsing, cookie handling, CORS, auth middleware, and SSE support.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';
import { join, dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseAdapter } from './db.js';
import type { ChatEngine } from './chat.js';
import type { ChatAttachment } from './chat.js';
import { getOrCreateModel } from './chat.js';
import { DashboardService } from './dashboard.js';
import { getAvailableTools, BUILTIN_TOOLS } from './tools.js';
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
import { SVChatBridge } from './features/scientific-validation/chat-bridge.js';
import { createSVToolMap } from './features/scientific-validation/tools/index.js';
import { DbToolPolicyResolver } from './tool-policy-resolver.js';
import { DbToolAuditEmitter } from './tool-audit-emitter.js';
import { encryptCredential, decryptCredential } from './vault.js';
import { setBrowserAuthProvider, type SSOPassThroughAuth } from '@weaveintel/tools-browser';
import { weaveContext } from '@weaveintel/core';
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

  // ── Hypothesis Validation feature routes ────────────────────
  // Build async model factories from the configured providers (models are cached by chat-runtime).
  const svProviderCfg = providers?.['openai'] ?? providers?.['anthropic'] ?? { apiKey: '' };
  const svProviderKey = providers?.['openai'] ? 'openai' : 'anthropic';
  const svRunner = new SVChatBridge({
    db,
    makeReasoningModel: () => getOrCreateModel(
      svProviderKey,
      svProviderKey === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-20250514',
      svProviderCfg,
    ),
    makeToolModel: () => getOrCreateModel(
      svProviderKey,
      svProviderKey === 'openai' ? 'gpt-4o-mini' : 'claude-haiku-4-20250414',
      svProviderCfg,
    ),
    toolMap: { ...BUILTIN_TOOLS, ...createSVToolMap() },
    policyResolver: new DbToolPolicyResolver(db),
    auditEmitter: new DbToolAuditEmitter(db),
  });
  registerSVRoutes(router, db, json, readBody, svRunner);

  // ── SGAP workflow execution routes ─────────────────────────

  router.post('/api/sgap/workflows/:workflowTemplateId/run', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const template = await db.getSgapTableRow('sg_workflow_templates', params['workflowTemplateId']!);
    if (!template) { json(res, 404, { error: 'Workflow template not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    }

    const brandId = String(body['brand_id'] ?? template['brand_id'] ?? '');
    if (!brandId) { json(res, 400, { error: 'brand_id is required' }); return; }

    const brand = await db.getSgapTableRow('sg_brands', brandId);
    if (!brand) { json(res, 404, { error: 'Brand not found' }); return; }

    const runId = randomUUID();
    const threadId = randomUUID();
    const now = new Date().toISOString();
    await db.createSgapWorkflowRun({
      id: runId,
      application_scope: 'sgap',
      brand_id: brandId,
      workflow_template_id: params['workflowTemplateId']!,
      status: 'running',
      current_stage: 'strategy',
      current_agent_id: undefined,
      input_json: JSON.stringify(body),
      state_json: JSON.stringify({ history: [{ stage: 'strategy', started_at: now }], initiated_by: auth.userId }),
      error_message: undefined,
      completed_at: undefined,
    });

    await db.createSgapAgentThread({
      id: threadId,
      application_scope: 'sgap',
      workflow_run_id: runId,
      stage: 'strategy',
    });

    const ceoAgent = await db.getSgapTableRow('sgap_agents', '593098bf-2f3d-4627-a7ee-b785e0ba2f8a');
    const strategistAgent = await db.getSgapTableRow('sgap_agents', '53025851-bf2d-49be-a070-f3a597f2daf4');
    if (ceoAgent && strategistAgent) {
      await db.createSgapAgentMessage({
        id: randomUUID(),
        application_scope: 'sgap',
        thread_id: threadId,
        from_agent_id: String(ceoAgent['id']),
        to_agent_id: String(strategistAgent['id']),
        message_type: 'instruction',
        content_json: JSON.stringify({
          task: 'Create the strategy phase plan',
          brand_name: String(brand['name'] ?? ''),
          objective: String(template['description'] ?? 'Drive growth outcomes with channel-ready content'),
        }),
        requires_response: 1,
        responded: 0,
        response_message_id: undefined,
        response_json: undefined,
        responded_at: undefined,
      });
    }

    await db.createSgapAuditLog({
      id: randomUUID(),
      application_scope: 'sgap',
      workflow_run_id: runId,
      agent_id: String(ceoAgent?.['id'] ?? 'system'),
      action: 'workflow_started',
      details_json: JSON.stringify({
        brand_id: brandId,
        workflow_template_id: params['workflowTemplateId'],
        initiated_by: auth.userId,
      }),
    });

    const run = await db.getSgapWorkflowRun(runId);
    const threads = await db.listSgapAgentThreads(runId);
    json(res, 201, { run, threads });
  }, { auth: true, csrf: true });

  router.get('/api/sgap/workflow-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getSgapWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }

    const threads = await db.listSgapAgentThreads(run.id);
    const approvals = await db.listSgapApprovals(run.id);
    const audit = await db.listSgapAuditLog(run.id, undefined, 200);
    json(res, 200, { run, threads, approvals, audit });
  }, { auth: true });

  router.post('/api/sgap/workflow-runs/:id/cancel', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getSgapWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }

    await db.updateSgapWorkflowRun(run.id, {
      status: 'cancelled',
      completed_at: new Date().toISOString(),
    });

    const preferredAuditAgentId = run.current_agent_id || '593098bf-2f3d-4627-a7ee-b785e0ba2f8a';
    const preferredAuditAgent = await db.getSgapAgent(preferredAuditAgentId);
    const fallbackAuditAgent = preferredAuditAgent ? null : (await db.listSgapAgents())[0] ?? null;
    const auditAgentId = preferredAuditAgent?.id || fallbackAuditAgent?.id || null;

    if (auditAgentId) {
      try {
        await db.createSgapAuditLog({
          id: randomUUID(),
          application_scope: 'sgap',
          workflow_run_id: run.id,
          agent_id: auditAgentId,
          action: 'workflow_cancelled',
          details_json: JSON.stringify({ cancelled_by: auth.userId }),
        });
      } catch {
        // Best-effort audit logging should not block cancellation.
      }
    }

    const updated = await db.getSgapWorkflowRun(run.id);
    json(res, 200, { run: updated });
  }, { auth: true, csrf: true });

  router.post('/api/sgap/workflow-runs/:id/phase2/execute', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const run = await db.getSgapWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    }

    const configuredProviders = Object.entries(providers ?? {}).filter(([, cfg]) => Boolean(cfg?.apiKey?.trim()));
    if (configuredProviders.length === 0) {
      json(res, 503, { error: 'No model providers configured for SGAP Phase 2 execution' });
      return;
    }

    const requestedProvider = String(body['provider'] ?? '').trim();
    const requestedModel = String(body['model'] ?? '').trim();
    const fallbackProvider = providers?.['openai'] ? 'openai' : providers?.['anthropic'] ? 'anthropic' : configuredProviders[0]![0];
    const selectedProvider = requestedProvider && providers?.[requestedProvider] ? requestedProvider : fallbackProvider;

    const isModelCompatibleWithProvider = (providerName: string, modelName: string): boolean => {
      const normalized = modelName.toLowerCase();
      if (!normalized) return false;
      if (providerName === 'openai') return !normalized.includes('claude');
      if (providerName === 'anthropic') return normalized.includes('claude');
      return true;
    };

    const defaultModelForProvider = (providerName: string): string => {
      if (providerName === 'openai') return 'gpt-4o-mini';
      if (providerName === 'anthropic') return 'claude-sonnet-4-20250514';
      return 'mock-model';
    };

    const selectedModel = requestedModel && isModelCompatibleWithProvider(selectedProvider, requestedModel)
      ? requestedModel
      : defaultModelForProvider(selectedProvider);

    const providerCandidates = [
      selectedProvider,
      ...configuredProviders.map(([name]) => name).filter((name) => name !== selectedProvider),
    ];

    const getModelForProvider = async (providerName: string) => {
      const modelName = requestedModel && isModelCompatibleWithProvider(providerName, requestedModel)
        ? requestedModel
        : defaultModelForProvider(providerName);
      const config = providers?.[providerName];
      if (!config) throw new Error(`Missing provider configuration for ${providerName}`);
      const modelInstance = await getOrCreateModel(providerName, modelName, config);
      return { providerName, modelName, modelInstance };
    };

    const safeParse = (input: string | null | undefined): Record<string, unknown> => {
      if (!input) return {};
      try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        // ignore parse errors
      }
      return {};
    };

    const runState = safeParse(run.state_json);
    const brandRow = await db.getSgapTableRow('sg_brands', run.brand_id);
    const strategySummary = typeof brandRow?.['goals_json'] === 'string' && String(brandRow['goals_json']).trim()
      ? `Brand goals JSON: ${String(brandRow['goals_json'])}`
      : '';

    const phase2Configs = await db.listSgapPhase2Configs(run.brand_id, run.workflow_template_id);
    const phase2Config = phase2Configs.find((row) => row.enabled === 1) ?? null;

    const agents = await db.listSgapAgents();
    const byRole = (role: string) => agents.find((agent) => agent.role === role && agent.enabled === 1) ?? null;
    const byId = (id?: string) => (id ? agents.find((agent) => agent.id === id && agent.enabled === 1) ?? null : null);

    const writer = byId(phase2Config?.writer_agent_id) ?? byRole('writer');
    const researcher = byId(phase2Config?.researcher_agent_id) ?? byRole('researcher');
    const editor = byId(phase2Config?.editor_agent_id) ?? byRole('editor');
    const compliance = byRole('compliance');
    if (!writer || !researcher || !editor) {
      json(res, 400, { error: 'Phase 2 requires writer, researcher, and editor agents to be configured' });
      return;
    }

    const loadRolePromptAndSkill = async (role: string, fallbackPrompt: string) => {
      const promptMap: Record<string, string> = {
        writer: 'sgap.writer.system',
        researcher: 'sgap.researcher.system',
        editor: 'sgap.editor.system',
      };
      const promptKey = promptMap[role];
      const prompt = promptKey ? await db.getPromptByKey(promptKey) : null;

      const roleSkillNameMap: Record<string, string> = {
        writer: 'SGAP Writer',
        researcher: 'SGAP Researcher',
        editor: 'SGAP Editor',
      };
      const allSkills = await db.listSkills();
      const roleSkillName = roleSkillNameMap[role];
      const skill = roleSkillName
        ? allSkills.find((candidate) => candidate.name === roleSkillName && candidate.enabled === 1) ?? null
        : null;

      return {
        promptText: prompt?.template ?? fallbackPrompt,
        skillText: skill?.instructions ?? '',
      };
    };

    const generateStageOutput = async (role: string, fallbackPrompt: string, task: string): Promise<string> => {
      const loaded = await loadRolePromptAndSkill(role, fallbackPrompt);
      const systemText = [
        loaded.promptText,
        loaded.skillText ? `Skill Guidance:\n${loaded.skillText}` : '',
        'Workflow Boundary: You must produce output only for your assigned stage in the SGAP phase 2 chain.',
      ].filter(Boolean).join('\n\n');

      let lastError: unknown = null;
      for (const providerName of providerCandidates) {
        try {
          const { modelName, modelInstance } = await getModelForProvider(providerName);
          const response = await modelInstance.generate(
            weaveContext({
              userId: auth.userId,
              executionId: randomUUID(),
              metadata: {
                sgap_run_id: run.id,
                stage: role,
                workflow_stage: 'phase2',
                model_provider: providerName,
                model_name: modelName,
              },
            }),
            {
              messages: [
                { role: 'system', content: systemText },
                { role: 'user', content: task },
              ],
              temperature: 0.3,
              maxTokens: 1000,
            },
          );
          return String(response.content ?? '').trim();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('All configured model providers failed');
    };

    const queueRows = await db.listSgapTableRows('sg_content_queue');
    const requestedItemIds = Array.isArray(body['content_item_ids'])
      ? body['content_item_ids'].map((value) => String(value))
      : null;
    const maxItems = Math.max(1, Math.min(10, Number(body['max_items'] ?? 3)));

    const targetItems = queueRows
      .filter((row) => row['brand_id'] === run.brand_id && Number(row['enabled'] ?? 1) === 1)
      .filter((row) => requestedItemIds ? requestedItemIds.includes(String(row['id'])) : ['draft', 'ready'].includes(String(row['status'] ?? 'draft')))
      .slice(0, maxItems)
      .map((row) => ({
        id: String(row['id'] ?? ''),
        title: String(row['title'] ?? 'Untitled'),
        brief: String(row['brief'] ?? ''),
        format: String(row['format'] ?? 'text'),
        channel_id: String(row['channel_id'] ?? ''),
        content_text: String(row['content_text'] ?? ''),
      }));

    if (targetItems.length === 0) {
      json(res, 400, { error: 'No eligible content items found for phase 2 execution' });
      return;
    }

    const channels = await db.listSgapTableRows('sg_channels');
    const maxFeedbackRounds = Math.max(0, Math.min(5, phase2Config?.max_feedback_rounds ?? 2));
    const minResearchConfidence = Math.max(0, Math.min(1, phase2Config?.min_research_confidence ?? 0.7));
    const requireCitations = (phase2Config?.require_research_citations ?? 1) === 1;
    const autoEscalateToCompliance = (phase2Config?.auto_escalate_to_compliance ?? 1) === 1;

    const executionResults: Array<Record<string, unknown>> = [];
    for (const item of targetItems) {
      const channel = channels.find((row) => String(row['id'] ?? '') === item.channel_id);
      const platform = String(channel?.['platform'] ?? 'linkedin');

      const threadId = randomUUID();
      await db.createSgapAgentThread({
        id: threadId,
        application_scope: 'sgap',
        workflow_run_id: run.id,
        stage: 'phase2-content-creation',
      });

      let revisionIndex = 1;
      const writerTaskBase = [
        `Title: ${item.title}`,
        `Brief: ${item.brief}`,
        `Format: ${item.format}`,
        `Platform: ${platform}`,
        `Existing Content (if any): ${item.content_text || 'None'}`,
        strategySummary ? `Brand Strategy:\n${strategySummary}` : '',
        'Write publish-ready content that is specific, practical, and implementation-oriented.',
      ].filter(Boolean).join('\n\n');

      let writerOutput = await generateStageOutput('writer', writer.system_prompt, writerTaskBase);
      await db.createSgapContentRevision({
        id: randomUUID(),
        application_scope: 'sgap',
        workflow_run_id: run.id,
        content_item_id: item.id,
        agent_id: writer.id,
        stage: 'writer',
        revision_index: revisionIndex,
        content_text: writerOutput,
        notes_json: JSON.stringify({ reason: 'initial-draft' }),
      });

      await db.createSgapAgentMessage({
        id: randomUUID(),
        application_scope: 'sgap',
        thread_id: threadId,
        from_agent_id: writer.id,
        to_agent_id: researcher.id,
        message_type: 'draft',
        content_json: JSON.stringify({ content_item_id: item.id, draft: writerOutput, revision_index: revisionIndex }),
        requires_response: 1,
        responded: 0,
      });

      let confidence = 1;
      let citationsCount = 0;
      let researchOutput = '';
      let feedbackLoopCount = 0;

      const runResearchReview = async (draftText: string): Promise<void> => {
        const researchTask = [
          `Review this draft for factual quality and implementation correctness for ${platform}.`,
          'Return strict JSON with keys: confidence (0..1), citations (string[]), risks (string[]), feedback (string).',
          `Draft:\n${draftText}`,
        ].join('\n\n');
        researchOutput = await generateStageOutput('researcher', researcher.system_prompt, researchTask);

        let parsed: Record<string, unknown> = {};
        try {
          const maybe = JSON.parse(researchOutput);
          if (maybe && typeof maybe === 'object') parsed = maybe as Record<string, unknown>;
        } catch {
          parsed = {};
        }

        const parsedConfidence = Number(parsed['confidence']);
        confidence = Number.isFinite(parsedConfidence) ? parsedConfidence : 0.5;
        const citations = Array.isArray(parsed['citations']) ? parsed['citations'] : [];
        citationsCount = citations.length;
      };

      await runResearchReview(writerOutput);
      while ((confidence < minResearchConfidence || (requireCitations && citationsCount === 0)) && feedbackLoopCount < maxFeedbackRounds) {
        feedbackLoopCount += 1;

        await db.createSgapAgentMessage({
          id: randomUUID(),
          application_scope: 'sgap',
          thread_id: threadId,
          from_agent_id: researcher.id,
          to_agent_id: writer.id,
          message_type: 'feedback',
          content_json: JSON.stringify({
            content_item_id: item.id,
            confidence,
            citations_count: citationsCount,
            feedback: researchOutput,
          }),
          requires_response: 1,
          responded: 0,
        });

        const rewriteTask = [
          writerTaskBase,
          `Research feedback loop ${feedbackLoopCount}:\n${researchOutput}`,
          'Rewrite and strengthen evidence quality. Keep it publish-ready and practical.',
        ].join('\n\n');
        writerOutput = await generateStageOutput('writer', writer.system_prompt, rewriteTask);
        revisionIndex += 1;

        await db.createSgapContentRevision({
          id: randomUUID(),
          application_scope: 'sgap',
          workflow_run_id: run.id,
          content_item_id: item.id,
          agent_id: writer.id,
          stage: 'writer',
          revision_index: revisionIndex,
          content_text: writerOutput,
          notes_json: JSON.stringify({ reason: 'research-feedback-loop', loop: feedbackLoopCount }),
        });

        await runResearchReview(writerOutput);
      }

      await db.createSgapContentRevision({
        id: randomUUID(),
        application_scope: 'sgap',
        workflow_run_id: run.id,
        content_item_id: item.id,
        agent_id: researcher.id,
        stage: 'researcher',
        revision_index: revisionIndex,
        content_text: researchOutput,
        notes_json: JSON.stringify({ confidence, citations_count: citationsCount }),
      });

      let finalStatus = 'ready';
      if ((confidence < minResearchConfidence || (requireCitations && citationsCount === 0)) && autoEscalateToCompliance && compliance) {
        finalStatus = 'blocked';
        await db.createSgapApproval({
          id: randomUUID(),
          application_scope: 'sgap',
          workflow_run_id: run.id,
          content_item_id: item.id,
          required_by_agent_id: writer.id,
          approval_from_agent_id: compliance.id,
          status: 'pending',
          feedback_json: JSON.stringify({ reason: 'phase2-low-confidence', confidence, citations_count: citationsCount }),
          resolved_at: undefined,
          resolved_by_agent_id: undefined,
        });
      }

      const editorTask = [
        `Finalize this draft for ${platform}.`,
        'Preserve technical accuracy and improve readability and flow.',
        `Draft:\n${writerOutput}`,
        `Research Notes:\n${researchOutput}`,
      ].join('\n\n');
      const editorOutput = await generateStageOutput('editor', editor.system_prompt, editorTask);

      await db.createSgapContentRevision({
        id: randomUUID(),
        application_scope: 'sgap',
        workflow_run_id: run.id,
        content_item_id: item.id,
        agent_id: editor.id,
        stage: 'editor',
        revision_index: revisionIndex,
        content_text: editorOutput,
        notes_json: JSON.stringify({ confidence, citations_count: citationsCount }),
      });

      await db.updateSgapTableRow('sg_content_queue', item.id, {
        content_text: editorOutput,
        status: finalStatus,
        metadata_json: JSON.stringify({
          phase2: {
            writer_agent_id: writer.id,
            researcher_agent_id: researcher.id,
            editor_agent_id: editor.id,
            feedback_loops: feedbackLoopCount,
            confidence,
            citations_count: citationsCount,
          },
        }),
        updated_at: new Date().toISOString(),
      });

      await db.createSgapAuditLog({
        id: randomUUID(),
        application_scope: 'sgap',
        workflow_run_id: run.id,
        agent_id: editor.id,
        action: 'phase2_content_finalized',
        details_json: JSON.stringify({
          content_item_id: item.id,
          feedback_loops: feedbackLoopCount,
          confidence,
          citations_count: citationsCount,
          status: finalStatus,
        }),
      });

      executionResults.push({
        content_item_id: item.id,
        title: item.title,
        platform,
        final_status: finalStatus,
        confidence,
        citations_count: citationsCount,
        feedback_loops: feedbackLoopCount,
      });
    }

    const blockedCount = executionResults.filter((item) => String(item['final_status']) === 'blocked').length;
    const nextStatus = blockedCount > 0 ? 'blocked' : 'running';
    const nextStage = blockedCount > 0 ? 'compliance-approval' : 'optimization-distribution';

    await db.updateSgapWorkflowRun(run.id, {
      status: nextStatus,
      current_stage: nextStage,
      state_json: JSON.stringify({
        ...runState,
        phase2: {
          executed_at: new Date().toISOString(),
          model_provider: selectedProvider,
          model: selectedModel,
          item_count: executionResults.length,
          blocked_count: blockedCount,
          results: executionResults,
        },
      }),
    });

    const updatedRun = await db.getSgapWorkflowRun(run.id);
    const revisions = await db.listSgapContentRevisions(run.id);
    json(res, 200, {
      run: updatedRun,
      phase2: {
        provider: selectedProvider,
        model: selectedModel,
        results: executionResults,
        revision_count: revisions.length,
      },
    });
  }, { auth: true, csrf: true });

  router.post('/api/sgap/workflow-runs/:id/phase3/execute', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const run = await db.getSgapWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    }

    const configuredProviders = Object.entries(providers ?? {}).filter(([, cfg]) => Boolean(cfg?.apiKey?.trim()));
    if (configuredProviders.length === 0) {
      json(res, 503, { error: 'No model providers configured for SGAP Phase 3 execution' });
      return;
    }

    const requestedProvider = String(body['provider'] ?? '').trim();
    const requestedModel = String(body['model'] ?? '').trim();
    const fallbackProvider = providers?.['openai'] ? 'openai' : providers?.['anthropic'] ? 'anthropic' : configuredProviders[0]![0];
    const selectedProvider = requestedProvider && providers?.[requestedProvider] ? requestedProvider : fallbackProvider;

    const isModelCompatibleWithProvider = (providerName: string, modelName: string): boolean => {
      const normalized = modelName.toLowerCase();
      if (!normalized) return false;
      if (providerName === 'openai') return !normalized.includes('claude');
      if (providerName === 'anthropic') return normalized.includes('claude');
      return true;
    };

    const defaultModelForProvider = (providerName: string): string => {
      if (providerName === 'openai') return 'gpt-4o-mini';
      if (providerName === 'anthropic') return 'claude-sonnet-4-20250514';
      return 'mock-model';
    };

    const selectedModel = requestedModel && isModelCompatibleWithProvider(selectedProvider, requestedModel)
      ? requestedModel
      : defaultModelForProvider(selectedProvider);

    const providerCandidates = [
      selectedProvider,
      ...configuredProviders.map(([name]) => name).filter((name) => name !== selectedProvider),
    ];

    const getModelForProvider = async (providerName: string) => {
      const modelName = requestedModel && isModelCompatibleWithProvider(providerName, requestedModel)
        ? requestedModel
        : defaultModelForProvider(providerName);
      const config = providers?.[providerName];
      if (!config) throw new Error(`Missing provider configuration for ${providerName}`);
      const modelInstance = await getOrCreateModel(providerName, modelName, config);
      return { providerName, modelName, modelInstance };
    };

    const safeParse = (input: string | null | undefined): Record<string, unknown> => {
      if (!input) return {};
      try {
        const parsed = JSON.parse(input);
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
      } catch {
        // ignore parse errors
      }
      return {};
    };

    const runState = safeParse(run.state_json);
    const phase3Configs = await db.listSgapPhase3Configs(run.brand_id, run.workflow_template_id);
    const phase3Config = phase3Configs.find((row) => row.enabled === 1) ?? null;

    const agents = await db.listSgapAgents();
    const byRole = (role: string) => agents.find((agent) => agent.role === role && agent.enabled === 1) ?? null;
    const byId = (id?: string) => (id ? agents.find((agent) => agent.id === id && agent.enabled === 1) ?? null : null);

    const socialManager = byId(phase3Config?.social_manager_agent_id) ?? byRole('social-manager');
    const analytics = byId(phase3Config?.analytics_agent_id) ?? byRole('analytics');
    if (!socialManager || !analytics) {
      json(res, 400, { error: 'Phase 3 requires social-manager and analytics agents to be configured' });
      return;
    }

    const loadRolePromptAndSkill = async (role: string, fallbackPrompt: string) => {
      const promptMap: Record<string, string> = {
        'social-manager': 'sgap.social_manager.system',
        analytics: 'sgap.analytics.system',
      };
      const promptKey = promptMap[role];
      const prompt = promptKey ? await db.getPromptByKey(promptKey) : null;

      const roleSkillNameMap: Record<string, string> = {
        'social-manager': 'SGAP Distribution Lead',
        analytics: 'SGAP Analytics Lead',
      };
      const allSkills = await db.listSkills();
      const roleSkillName = roleSkillNameMap[role];
      const skill = roleSkillName
        ? allSkills.find((candidate) => candidate.name === roleSkillName && candidate.enabled === 1) ?? null
        : null;

      return {
        promptText: prompt?.template ?? fallbackPrompt,
        skillText: skill?.instructions ?? '',
      };
    };

    const generateStageOutput = async (role: string, fallbackPrompt: string, task: string): Promise<string> => {
      const loaded = await loadRolePromptAndSkill(role, fallbackPrompt);
      const systemText = [
        loaded.promptText,
        loaded.skillText ? `Skill Guidance:\n${loaded.skillText}` : '',
        'Workflow Boundary: You must produce output only for your assigned stage in the SGAP phase 3 chain.',
      ].filter(Boolean).join('\n\n');

      let lastError: unknown = null;
      for (const providerName of providerCandidates) {
        try {
          const { modelName, modelInstance } = await getModelForProvider(providerName);
          const response = await modelInstance.generate(
            weaveContext({
              userId: auth.userId,
              executionId: randomUUID(),
              metadata: {
                sgap_run_id: run.id,
                stage: role,
                workflow_stage: 'phase3',
                model_provider: providerName,
                model_name: modelName,
              },
            }),
            {
              messages: [
                { role: 'system', content: systemText },
                { role: 'user', content: task },
              ],
              temperature: 0.25,
              maxTokens: 900,
            },
          );
          return String(response.content ?? '').trim();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('All configured model providers failed');
    };

    const queueRows = await db.listSgapTableRows('sg_content_queue');
    const requestedItemIds = Array.isArray(body['content_item_ids'])
      ? body['content_item_ids'].map((value) => String(value))
      : null;
    const maxItems = Math.max(1, Math.min(10, Number(body['max_items'] ?? 3)));

    const targetItems = queueRows
      .filter((row) => row['brand_id'] === run.brand_id && Number(row['enabled'] ?? 1) === 1)
      .filter((row) => requestedItemIds ? requestedItemIds.includes(String(row['id'])) : ['ready', 'scheduled'].includes(String(row['status'] ?? 'draft')))
      .slice(0, maxItems)
      .map((row) => ({
        id: String(row['id'] ?? ''),
        title: String(row['title'] ?? 'Untitled'),
        brief: String(row['brief'] ?? ''),
        content_text: String(row['content_text'] ?? ''),
        channel_id: String(row['channel_id'] ?? ''),
        metadata_json: String(row['metadata_json'] ?? ''),
      }))
      .filter((row) => row.content_text.trim().length > 0);

    if (targetItems.length === 0) {
      json(res, 400, { error: 'No eligible ready content items found for phase 3 execution' });
      return;
    }

    const channels = await db.listSgapTableRows('sg_channels');
    const channelPlatforms = channels
      .filter((row) => String(row['brand_id'] ?? '') === run.brand_id)
      .map((row) => String(row['platform'] ?? '').toLowerCase())
      .filter(Boolean);

    const configuredPlatforms = (() => {
      try {
        const parsed = JSON.parse(phase3Config?.primary_platforms_json ?? '[]');
        if (Array.isArray(parsed)) {
          return parsed.map((value) => String(value).toLowerCase()).filter(Boolean);
        }
      } catch {
        // ignore
      }
      return [] as string[];
    })();

    const platforms = (configuredPlatforms.length > 0 ? configuredPlatforms : channelPlatforms.length > 0 ? channelPlatforms : ['linkedin'])
      .slice(0, 8);

    const publishMode = String(body['publish_mode'] ?? phase3Config?.publish_mode ?? 'draft');
    const scheduleStrategy = String(phase3Config?.schedule_strategy ?? 'best_window');
    const minEngagementTarget = Number(phase3Config?.min_engagement_target ?? 0.03);

    const platformToolMap: Record<string, string> = {
      x: 'social_x_post',
      linkedin: 'social_linkedin_post',
      facebook: 'social_facebook_post',
      instagram: 'social_instagram_post',
      tiktok: 'social_tiktok_post',
      youtube: 'social_youtube_post',
      medium: 'social_medium_post',
      devto: 'social_devto_post',
      hashnode: 'social_hashnode_post',
      substack: 'social_substack_post',
      blogger: 'social_blogger_post',
    };

    const phase3Results: Array<Record<string, unknown>> = [];
    for (const item of targetItems) {
      const threadId = randomUUID();
      await db.createSgapAgentThread({
        id: threadId,
        application_scope: 'sgap',
        workflow_run_id: run.id,
        stage: 'phase3-distribution-optimization',
      });

      for (const platform of platforms) {
        const distributionTask = [
          `Prepare a platform-optimized distribution variant for ${platform}.`,
          `Title: ${item.title}`,
          `Brief: ${item.brief}`,
          `Core Content:\n${item.content_text}`,
          `Publish Mode: ${publishMode}`,
          `Schedule Strategy: ${scheduleStrategy}`,
          'Return publish-ready text suitable for this platform only.',
        ].join('\n\n');

        const distributionText = await generateStageOutput('social-manager', socialManager.system_prompt, distributionTask);

        const analyticsTask = [
          `Create KPI optimization guidance for ${platform}.`,
          `Minimum engagement target: ${minEngagementTarget}`,
          'Return strict JSON with keys: optimal_time_iso, kpi_targets, hashtags, notes, projected_engagement.',
          `Distribution Draft:\n${distributionText}`,
        ].join('\n\n');
        const analyticsOutput = await generateStageOutput('analytics', analytics.system_prompt, analyticsTask);

        let analyticsJson: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(analyticsOutput);
          if (parsed && typeof parsed === 'object') analyticsJson = parsed as Record<string, unknown>;
        } catch {
          analyticsJson = { notes: analyticsOutput };
        }

        const scheduledFor = String(analyticsJson['optimal_time_iso'] ?? new Date(Date.now() + 3600 * 1000).toISOString());
        const hashtags = Array.isArray(analyticsJson['hashtags']) ? analyticsJson['hashtags'] : [];
        const projectedEngagement = Number(analyticsJson['projected_engagement'] ?? 0);
        const toolName = platformToolMap[platform] ?? 'social_post';

        const planId = randomUUID();
        await db.createSgapDistributionPlan({
          id: planId,
          application_scope: 'sgap',
          workflow_run_id: run.id,
          content_item_id: item.id,
          social_manager_agent_id: socialManager.id,
          analytics_agent_id: analytics.id,
          platform,
          publish_mode: publishMode,
          scheduled_for: scheduledFor,
          tool_name: toolName,
          distribution_text: distributionText,
          hashtags_json: JSON.stringify(hashtags),
          optimization_notes_json: JSON.stringify({
            kpi_targets: analyticsJson['kpi_targets'] ?? {},
            notes: analyticsJson['notes'] ?? '',
            projected_engagement: projectedEngagement,
          }),
          tool_result_json: JSON.stringify({ status: 'planned', publish_mode: publishMode }),
          status: publishMode === 'publish' ? 'scheduled' : 'planned',
        });

        await db.createSgapAgentMessage({
          id: randomUUID(),
          application_scope: 'sgap',
          thread_id: threadId,
          from_agent_id: socialManager.id,
          to_agent_id: analytics.id,
          message_type: 'handoff',
          content_json: JSON.stringify({ content_item_id: item.id, platform, distribution_plan_id: planId }),
          requires_response: 0,
          responded: 1,
          response_message_id: undefined,
          response_json: undefined,
          responded_at: undefined,
        });

        await db.createSgapContentPerformance({
          id: randomUUID(),
          application_scope: 'sgap',
          content_item_id: item.id,
          brand_id: run.brand_id,
          platform,
          published_at: scheduledFor,
          views: 0,
          engagement: 0,
          reach: 0,
          impressions: 0,
          clicks: 0,
          conversions: 0,
          metadata_json: JSON.stringify({
            workflow_run_id: run.id,
            distribution_plan_id: planId,
            kpi_targets: analyticsJson['kpi_targets'] ?? {},
            projected_engagement: projectedEngagement,
          }),
          synced_at: new Date().toISOString(),
        });

        phase3Results.push({
          content_item_id: item.id,
          platform,
          distribution_plan_id: planId,
          tool_name: toolName,
          publish_mode: publishMode,
          scheduled_for: scheduledFor,
          projected_engagement: projectedEngagement,
        });
      }

      await db.updateSgapTableRow('sg_content_queue', item.id, {
        status: publishMode === 'publish' ? 'scheduled' : 'ready',
        metadata_json: JSON.stringify({
          ...safeParse(item.metadata_json),
          phase3: {
            workflow_run_id: run.id,
            publish_mode: publishMode,
            platforms,
          },
        }),
        updated_at: new Date().toISOString(),
      });
    }

    await db.createSgapAuditLog({
      id: randomUUID(),
      application_scope: 'sgap',
      workflow_run_id: run.id,
      agent_id: analytics.id,
      action: 'phase3_distribution_planned',
      details_json: JSON.stringify({
        publish_mode: publishMode,
        platform_count: platforms.length,
        planned_records: phase3Results.length,
      }),
    });

    await db.updateSgapWorkflowRun(run.id, {
      status: 'running',
      current_stage: 'performance-review',
      current_agent_id: analytics.id,
      state_json: JSON.stringify({
        ...runState,
        phase3: {
          executed_at: new Date().toISOString(),
          model_provider: selectedProvider,
          model: selectedModel,
          publish_mode: publishMode,
          planned_records: phase3Results.length,
          results: phase3Results,
        },
      }),
    });

    const updatedRun = await db.getSgapWorkflowRun(run.id);
    const plans = await db.listSgapDistributionPlans(run.id);
    json(res, 200, {
      run: updatedRun,
      phase3: {
        provider: selectedProvider,
        model: selectedModel,
        publish_mode: publishMode,
        plans_count: plans.length,
        results: phase3Results,
      },
    });
  }, { auth: true, csrf: true });

  // ── SGAP Production Listing/Detail APIs ───────────────────

  router.get('/api/sgap/workflow-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const brandId = url.searchParams.get('brand_id') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const allRuns = await db.listSgapTableRows('sgap_workflow_runs') as Array<Record<string, unknown>>;
    let filtered = allRuns;
    if (brandId) filtered = filtered.filter((r) => r['brand_id'] === brandId);
    if (status) filtered = filtered.filter((r) => r['status'] === status);
    const total = filtered.length;
    const runs = filtered.slice(offset, offset + limit);
    json(res, 200, { runs, total, limit, offset });
  }, { auth: true });

  router.get('/api/sgap/brands', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const brands = await db.listSgapTableRows('sg_brands');
    json(res, 200, { brands });
  }, { auth: true });

  router.get('/api/sgap/brands/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const brand = await db.getSgapTableRow('sg_brands', params['id']!);
    if (!brand) { json(res, 404, { error: 'Brand not found' }); return; }
    const allChannels = await db.listSgapTableRows('sg_channels') as Array<Record<string, unknown>>;
    const channels = allChannels.filter((c) => c['brand_id'] === params['id']);
    const allRuns = await db.listSgapTableRows('sgap_workflow_runs') as Array<Record<string, unknown>>;
    const recentRuns = allRuns.filter((r) => r['brand_id'] === params['id']).slice(0, 10);
    json(res, 200, { brand, channels, recent_runs: recentRuns });
  }, { auth: true });

  router.get('/api/sgap/brands/:id/content', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const brand = await db.getSgapTableRow('sg_brands', params['id']!);
    if (!brand) { json(res, 404, { error: 'Brand not found' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const status = url.searchParams.get('status') ?? undefined;
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const allContent = await db.listSgapTableRows('sg_content_queue') as Array<Record<string, unknown>>;
    let filtered = allContent.filter((c) => c['brand_id'] === params['id']);
    if (status) filtered = filtered.filter((c) => c['status'] === status);
    const total = filtered.length;
    const items = filtered.slice(offset, offset + limit);
    json(res, 200, { items, total, limit, offset });
  }, { auth: true });

  router.get('/api/sgap/brands/:id/channels', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const brand = await db.getSgapTableRow('sg_brands', params['id']!);
    if (!brand) { json(res, 404, { error: 'Brand not found' }); return; }
    const allChannels = await db.listSgapTableRows('sg_channels') as Array<Record<string, unknown>>;
    const channels = allChannels.filter((c) => c['brand_id'] === params['id']);
    json(res, 200, { channels });
  }, { auth: true });

  router.get('/api/sgap/brands/:id/performance', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const brand = await db.getSgapTableRow('sg_brands', params['id']!);
    if (!brand) { json(res, 404, { error: 'Brand not found' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '20'), 100);
    const insights = await db.listSgapBrandPerformanceInsights(params['id']!, limit);
    json(res, 200, { brand_id: params['id'], insights });
  }, { auth: true });

  router.get('/api/sgap/workflow-runs/:id/revisions', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getSgapWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }
    const allRevisions = await db.listSgapTableRows('sgap_content_revisions') as Array<Record<string, unknown>>;
    const revisions = allRevisions.filter((r) => r['workflow_run_id'] === params['id']);
    json(res, 200, { revisions });
  }, { auth: true });

  router.get('/api/sgap/workflow-runs/:id/distribution-plans', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getSgapWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }
    const plans = await db.listSgapDistributionPlans(params['id']!);
    json(res, 200, { plans });
  }, { auth: true });

  router.get('/api/sgap/workflow-runs/:id/messages', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getSgapWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }
    const allThreads = await db.listSgapTableRows('sgap_agent_threads') as Array<Record<string, unknown>>;
    const threadIds = allThreads.filter((t) => t['workflow_run_id'] === params['id']).map((t) => t['id'] as string);
    const allMessages = await db.listSgapTableRows('sgap_agent_messages') as Array<Record<string, unknown>>;
    const messages = allMessages.filter((m) => threadIds.includes(m['thread_id'] as string))
      .sort((a, b) => String(a['created_at'] ?? '').localeCompare(String(b['created_at'] ?? '')));
    json(res, 200, { messages });
  }, { auth: true });

  router.post('/api/sgap/approvals/:id/approve', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const approval = await db.getSgapTableRow('sgap_approvals', params['id']!);
    if (!approval) { json(res, 404, { error: 'Approval not found' }); return; }
    const row = approval as Record<string, unknown>;
    if (row['status'] !== 'pending') {
      json(res, 409, { error: 'Approval already resolved' }); return;
    }
    const raw = await readBody(req);
    let body: { feedback?: string } = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    }
    await db.updateSgapTableRow('sgap_approvals', params['id']!, {
      status: 'approved',
      resolved_at: new Date().toISOString(),
      resolved_by: auth.userId,
      feedback: body.feedback ?? '',
    });
    const updated = await db.getSgapTableRow('sgap_approvals', params['id']!);
    json(res, 200, { approval: updated });
  }, { auth: true, csrf: true });

  router.post('/api/sgap/approvals/:id/reject', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const approval = await db.getSgapTableRow('sgap_approvals', params['id']!);
    if (!approval) { json(res, 404, { error: 'Approval not found' }); return; }
    const row = approval as Record<string, unknown>;
    if (row['status'] !== 'pending') {
      json(res, 409, { error: 'Approval already resolved' }); return;
    }
    const raw = await readBody(req);
    let body: { feedback?: string } = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    }
    await db.updateSgapTableRow('sgap_approvals', params['id']!, {
      status: 'rejected',
      resolved_at: new Date().toISOString(),
      resolved_by: auth.userId,
      feedback: body.feedback ?? '',
    });
    const updated = await db.getSgapTableRow('sgap_approvals', params['id']!);
    json(res, 200, { approval: updated });
  }, { auth: true, csrf: true });

  // ── SGAP Phase 4: Performance Review ─────────────────────

  router.post('/api/sgap/workflow-runs/:id/phase4/execute', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const run = await db.getSgapWorkflowRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Workflow run not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    }

    const configuredProviders = Object.entries(providers ?? {}).filter(([, cfg]) => Boolean(cfg?.apiKey?.trim()));
    if (configuredProviders.length === 0) {
      json(res, 503, { error: 'No model providers configured for SGAP Phase 4 execution' });
      return;
    }

    const requestedProvider = String(body['provider'] ?? '').trim();
    const requestedModel = String(body['model'] ?? '').trim();
    const fallbackProvider = providers?.['openai'] ? 'openai' : providers?.['anthropic'] ? 'anthropic' : configuredProviders[0]![0];
    const selectedProvider = requestedProvider && providers?.[requestedProvider] ? requestedProvider : fallbackProvider;

    const isModelCompatibleWithProvider = (providerName: string, modelName: string): boolean => {
      const normalized = modelName.toLowerCase();
      if (!normalized) return false;
      if (providerName === 'openai') return !normalized.includes('claude');
      if (providerName === 'anthropic') return normalized.includes('claude');
      return true;
    };

    const defaultModelForProvider = (providerName: string): string => {
      if (providerName === 'openai') return 'gpt-4o-mini';
      if (providerName === 'anthropic') return 'claude-sonnet-4-20250514';
      return 'mock-model';
    };

    const selectedModel = requestedModel && isModelCompatibleWithProvider(selectedProvider, requestedModel)
      ? requestedModel
      : defaultModelForProvider(selectedProvider);

    const providerCandidates = [
      selectedProvider,
      ...configuredProviders.map(([name]) => name).filter((name) => name !== selectedProvider),
    ];

    const getModelForProvider = async (providerName: string) => {
      const modelName = requestedModel && isModelCompatibleWithProvider(providerName, requestedModel)
        ? requestedModel
        : defaultModelForProvider(providerName);
      const config = providers?.[providerName];
      if (!config) throw new Error(`Missing provider configuration for ${providerName}`);
      const modelInstance = await getOrCreateModel(providerName, modelName, config);
      return { providerName, modelName, modelInstance };
    };

    const safeParse = (input: string | null | undefined): Record<string, unknown> => {
      if (!input) return {};
      try { return JSON.parse(input); } catch { return {}; }
    };

    // Load context: distribution plans and performance data for this run
    const plans = await db.listSgapDistributionPlans(params['id']!);
    const allPerf = await db.listSgapTableRows('sgap_content_performance') as Array<Record<string, unknown>>;
    const runPerf = allPerf.filter((p) => p['workflow_run_id'] === params['id']);
    const reviewWindowDays = Number(body['review_window_days'] ?? 7);

    // Load analytics agent from phase4 config or fall back to finding any analytics agent
    const phase4Configs = await db.listSgapPhase4Configs(run.brand_id as string);
    const phase4Config = phase4Configs[0];
    const kpiThresholds = phase4Config ? safeParse(phase4Config.kpi_thresholds_json) : {};

    const platforms = [...new Set(plans.map((p) => (p as unknown as Record<string, unknown>)['platform'] as string).filter(Boolean))];
    const insights: Array<Record<string, unknown>> = [];
    const analyticsPromptRecord = await db.getPromptByKey('sgap.phase4.analytics_review');
    const brandRow = await db.getSgapTableRow('sg_brands', run.brand_id);

    const perfSummary = runPerf.length > 0
      ? JSON.stringify(runPerf.slice(0, 10), null, 2)
      : 'No performance data yet for this run. Use distribution plan data to forecast improvement areas.';

    const plansSummary = plans.length > 0
      ? JSON.stringify((plans as unknown as Array<Record<string, unknown>>).slice(0, 10).map((p) => ({
          platform: p['platform'],
          status: p['status'],
          publish_mode: p['publish_mode'],
          distribution_text: String(p['distribution_text'] ?? '').slice(0, 200),
        })), null, 2)
      : 'No distribution plans found.';

    const renderAnalyticsPrompt = (template: string, values: Record<string, string>): string =>
      template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => values[key] ?? '');

    const analyticsPromptTemplate = analyticsPromptRecord?.template
      ?? [
        'You are the SGAP analytics agent for {{brand_name}}. Review the following performance data and produce structured insights.',
        '',
        'DISTRIBUTION PLANS ({{plan_count}} plans):',
        '{{plans_summary}}',
        '',
        'CONTENT PERFORMANCE ({{perf_count}} items):',
        '{{performance_summary}}',
        '',
        'KPI THRESHOLDS:',
        '{{kpi_thresholds}}',
        '',
        'REVIEW WINDOW: {{review_window_days}} days',
      ].join('\n');

    let lastError: Error | undefined;
    for (const providerName of providerCandidates) {
      try {
        const { providerName: usedProvider, modelName: usedModel, modelInstance } = await getModelForProvider(providerName);

        const systemPrompt = renderAnalyticsPrompt(analyticsPromptTemplate, {
          brand_name: String(brandRow?.['name'] ?? run.brand_id),
          plan_count: String(plans.length),
          plans_summary: plansSummary,
          perf_count: String(runPerf.length),
          performance_summary: perfSummary,
          kpi_thresholds: JSON.stringify(kpiThresholds),
          review_window_days: String(reviewWindowDays),
        });

        const userPrompt = [
          `Analyze SGAP workflow run ${params['id']} performance across platforms: ${platforms.length > 0 ? platforms.join(', ') : 'multiple'}.`,
          'Provide a structured performance review with:',
          '1. Overall engagement score (0-1)',
          '2. Per-platform insights (if multiple platforms)',
          '3. Top 3 actionable improvement recommendations',
          '4. Content quality assessment',
          '5. Next cycle improvements',
          '',
          'Respond as JSON: { "overall_score": number, "platform_insights": [{"platform": string, "score": number, "notes": string}], "recommendations": string[], "action_items": string[], "summary": string }',
        ].join('\n');

        const response = await modelInstance.generate(
          weaveContext({
            userId: auth.userId,
            executionId: randomUUID(),
            metadata: {
              sgap_run_id: params['id'],
              stage: 'analytics',
              workflow_stage: 'phase4',
              model_provider: providerName,
              model_name: usedModel,
            },
          }),
          {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          },
        );

        let parsed: Record<string, unknown> = {};
        const responseText = String(response.content ?? '').trim();
        try {
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        } catch { /* use empty */ }

        const overallScore = typeof parsed['overall_score'] === 'number' ? parsed['overall_score'] : 0.5;
        const summary = String(parsed['summary'] ?? responseText.slice(0, 500));
        const recommendations = Array.isArray(parsed['recommendations']) ? parsed['recommendations'] : [summary];
        const actionItems = Array.isArray(parsed['action_items']) ? parsed['action_items'] : [];
        const platformInsights = Array.isArray(parsed['platform_insights']) ? parsed['platform_insights'] : [];

        // Create overall summary insight
        const summaryInsightId = await db.createSgapPerformanceInsight({
          id: randomUUID(),
          application_scope: 'sgap',
          workflow_run_id: params['id']!,
          brand_id: run.brand_id as string,
          analytics_agent_id: phase4Config?.analytics_agent_id ?? '',
          platform: 'all',
          insight_type: 'summary',
          score: overallScore,
          recommendation: recommendations.join('\n'),
          raw_metrics_json: JSON.stringify({ run_id: params['id'], perf_count: runPerf.length }),
          action_items_json: JSON.stringify(actionItems),
        });

        insights.push({ id: summaryInsightId, platform: 'all', insight_type: 'summary', score: overallScore });

        // Create per-platform insights
        for (const pi of platformInsights as Array<Record<string, unknown>>) {
          const insightId = await db.createSgapPerformanceInsight({
            id: randomUUID(),
            application_scope: 'sgap',
            workflow_run_id: params['id']!,
            brand_id: run.brand_id as string,
            analytics_agent_id: phase4Config?.analytics_agent_id ?? '',
            platform: String(pi['platform'] ?? 'unknown'),
            insight_type: 'platform_specific',
            score: typeof pi['score'] === 'number' ? pi['score'] : overallScore,
            recommendation: String(pi['notes'] ?? ''),
            raw_metrics_json: JSON.stringify(pi),
            action_items_json: JSON.stringify([]),
          });
          insights.push({ id: insightId, platform: pi['platform'], insight_type: 'platform_specific', score: pi['score'] });
        }

        // Transition run stage to completed
        await db.updateSgapWorkflowRun(params['id']!, {
          current_stage: 'completed',
          status: 'completed',
          completed_at: new Date().toISOString(),
        });

        const updatedRun = await db.getSgapWorkflowRun(params['id']!);
        json(res, 200, {
          run: updatedRun,
          phase4: {
            provider: usedProvider,
            model: usedModel,
            review_window_days: reviewWindowDays,
            insights_count: insights.length,
            insights,
          },
        });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
    }

    json(res, 502, { error: `Phase 4 execution failed across all providers: ${lastError?.message ?? 'unknown error'}` });
  }, { auth: true, csrf: true });

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
    if (process.env['NODE_ENV'] === 'production') { json(res, 404, { error: 'Not found' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:write')) {
      json(res, 403, { error: 'Missing permission: admin:platform:write' });
      return;
    }
    const statuses = await checkAllProviders();
    json(res, 200, statuses);
  }, { auth: true });

  router.post('/api/password-providers/import', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    if (process.env['NODE_ENV'] === 'production') { json(res, 404, { error: 'Not found' }); return; }
    if (!canPersonaAccess(auth.persona, 'admin:platform:write')) {
      json(res, 403, { error: 'Missing permission: admin:platform:write' });
      return;
    }
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
  const distDirResolved = resolve(distDir);
  const staticModuleExtensions = new Set(['.js', '.css', '.map']);
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

    // Serve UI module files (but NOT admin-schema.js - it's embedded in HTML)
    if ((method === 'GET' || method === 'HEAD') && pathname.match(/^\/(?:ui(?:\/|\.)|features\/)/)) {
      // Map /ui.js to /ui-client.js (client-side only module)
      let filename = pathname.slice(1);
      if (filename === 'ui.js') {
        filename = 'ui-client.js';
      }

      let decodedFilename = filename;
      try {
        decodedFilename = decodeURIComponent(filename);
      } catch {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const hasInvalidSegment = decodedFilename
        .split('/')
        .some((segment) => segment === '..' || segment.includes('\0'));
      if (hasInvalidSegment) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const filepath = resolve(distDirResolved, decodedFilename);
      if (!filepath.startsWith(distDirResolved + sep)) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      const extension = extname(filepath);
      if (!staticModuleExtensions.has(extension)) {
        json(res, 404, { error: 'Not found' });
        return;
      }

      try {
        const data = await fsReadFile(filepath);
        const contentType = extension === '.js'
          ? 'application/javascript'
          : extension === '.css'
            ? 'text/css'
            : 'application/json';
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
        const correlationId = randomUUID();
        console.error(`[geneWeave][${correlationId}] Error handling ${method} ${pathname}:`, err);
        if (!res.headersSent) {
          if (msg === 'Request body too large') {
            json(res, 413, { error: 'Request body too large' });
          } else {
            json(res, 500, { error: 'Internal server error', correlationId });
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
