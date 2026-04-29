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
  verifyPasswordDetailed,
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
import { DbToolPolicyResolver, DbToolRateLimiter } from './tool-policy-resolver.js';
import { DbToolAuditEmitter } from './tool-audit-emitter.js';
import { recordChatFeedbackSignal } from './routing-feedback.js';
import { createMCPGateway, DEFAULT_EXPOSED_ALLOCATION_CLASSES, type LoadedGatewayConfig } from './mcp-gateway.js';
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

async function readBody(req: IncomingMessage, opts?: { maxBytes?: number }): Promise<string> {
  const release = await acquireBodyReadSlot();
  try {
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const maxFromEnv = Number.parseInt(process.env['GENEWEAVE_MAX_REQUEST_BODY_BYTES'] ?? '', 10);
      const maxBytes = opts?.maxBytes;
      const MAX = Number.isFinite(maxBytes) && maxBytes && maxBytes > 0
        ? maxBytes
        : Number.isFinite(maxFromEnv) && maxFromEnv > 0
          ? maxFromEnv
          : DEFAULT_REQUEST_BODY_BYTES;
      let tooLarge = false;

      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX) {
          tooLarge = true;
          req.resume();
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
  } finally {
    release();
  }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

interface AuthRateState {
  count: number;
  windowStart: number;
}

interface LoginFailureState {
  failures: number;
  blockedUntil: number;
}

const IS_TEST_ENV = process.env['NODE_ENV'] === 'test';

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const AUTH_WINDOW_MS = envInt('GENEWEAVE_AUTH_RATE_WINDOW_MS', 10 * 60_000);
const REGISTER_IP_LIMIT = envInt('GENEWEAVE_REGISTER_IP_LIMIT', IS_TEST_ENV ? 1_000 : 10);
const REGISTER_EMAIL_LIMIT = envInt('GENEWEAVE_REGISTER_EMAIL_LIMIT', IS_TEST_ENV ? 500 : 5);
const LOGIN_IP_LIMIT = envInt('GENEWEAVE_LOGIN_IP_LIMIT', IS_TEST_ENV ? 2_000 : 25);
const LOGIN_EMAIL_LIMIT = envInt('GENEWEAVE_LOGIN_EMAIL_LIMIT', IS_TEST_ENV ? 1_000 : 10);
const LOGIN_MAX_BACKOFF_MS = envInt('GENEWEAVE_LOGIN_MAX_BACKOFF_MS', IS_TEST_ENV ? 0 : 5 * 60_000);
const DEFAULT_REQUEST_BODY_BYTES = envInt('GENEWEAVE_DEFAULT_REQUEST_BODY_BYTES', IS_TEST_ENV ? 20 * 1024 * 1024 : 2 * 1024 * 1024);
const MAX_CONCURRENT_BODY_READS = envInt('GENEWEAVE_MAX_CONCURRENT_BODY_READS', IS_TEST_ENV ? 200 : 24);
const MAX_QUEUED_BODY_READS = envInt('GENEWEAVE_MAX_QUEUED_BODY_READS', IS_TEST_ENV ? 5_000 : 512);
const LARGE_REQUEST_BODY_BYTES = envInt('GENEWEAVE_LARGE_REQUEST_BODY_BYTES', 50 * 1024 * 1024);
const SERVER_REQUEST_TIMEOUT_MS = envInt('GENEWEAVE_SERVER_REQUEST_TIMEOUT_MS', 30_000);
const SERVER_HEADERS_TIMEOUT_MS = envInt('GENEWEAVE_SERVER_HEADERS_TIMEOUT_MS', 10_000);
const SERVER_KEEP_ALIVE_TIMEOUT_MS = envInt('GENEWEAVE_SERVER_KEEPALIVE_TIMEOUT_MS', 5_000);
const SERVER_MAX_HEADERS_COUNT = envInt('GENEWEAVE_SERVER_MAX_HEADERS_COUNT', 100);
const SERVER_MAX_REQUESTS_PER_SOCKET = envInt('GENEWEAVE_SERVER_MAX_REQUESTS_PER_SOCKET', 100);

const authRateStates = new Map<string, AuthRateState>();
const loginFailureStates = new Map<string, LoginFailureState>();
let activeBodyReads = 0;
const bodyReadWaiters: Array<() => void> = [];

function releaseBodyReadSlot(): void {
  if (activeBodyReads > 0) activeBodyReads -= 1;
  const next = bodyReadWaiters.shift();
  if (next) next();
}

async function acquireBodyReadSlot(): Promise<() => void> {
  if (activeBodyReads < MAX_CONCURRENT_BODY_READS) {
    activeBodyReads += 1;
    return releaseBodyReadSlot;
  }
  if (bodyReadWaiters.length >= MAX_QUEUED_BODY_READS) {
    throw new Error('Too many concurrent request bodies');
  }
  await new Promise<void>((resolve) => {
    bodyReadWaiters.push(resolve);
  });
  activeBodyReads += 1;
  return releaseBodyReadSlot;
}

function cleanupAuthRateState(now: number): void {
  for (const [key, state] of authRateStates.entries()) {
    if (now - state.windowStart > AUTH_WINDOW_MS) {
      authRateStates.delete(key);
    }
  }
  for (const [key, state] of loginFailureStates.entries()) {
    if (state.blockedUntil + AUTH_WINDOW_MS < now) {
      loginFailureStates.delete(key);
    }
  }
}

function readClientIp(req: IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function checkRateLimit(key: string, limit: number, windowMs: number): { limited: boolean; retryAfterMs: number } {
  const now = Date.now();
  cleanupAuthRateState(now);
  const current = authRateStates.get(key);
  if (!current || now - current.windowStart >= windowMs) {
    authRateStates.set(key, { count: 1, windowStart: now });
    return { limited: false, retryAfterMs: 0 };
  }
  if (current.count >= limit) {
    const retryAfterMs = Math.max(1_000, windowMs - (now - current.windowStart));
    return { limited: true, retryAfterMs };
  }
  current.count += 1;
  return { limited: false, retryAfterMs: 0 };
}

function checkAuthRateLimits(kind: 'login' | 'register', req: IncomingMessage, email?: string): { limited: boolean; retryAfterMs: number } {
  const ip = readClientIp(req);
  const ipLimit = kind === 'login' ? LOGIN_IP_LIMIT : REGISTER_IP_LIMIT;
  const emailLimit = kind === 'login' ? LOGIN_EMAIL_LIMIT : REGISTER_EMAIL_LIMIT;

  const ipCheck = checkRateLimit(`${kind}:ip:${ip}`, ipLimit, AUTH_WINDOW_MS);
  if (ipCheck.limited) return ipCheck;

  if (email) {
    const emailCheck = checkRateLimit(`${kind}:email:${email.toLowerCase()}`, emailLimit, AUTH_WINDOW_MS);
    if (emailCheck.limited) return emailCheck;
  }

  return { limited: false, retryAfterMs: 0 };
}

function getFailureKey(ip: string, email: string): string {
  return `${ip}|${email.toLowerCase()}`;
}

function getLoginBackoffMs(ip: string, email: string): number {
  const now = Date.now();
  cleanupAuthRateState(now);
  const key = getFailureKey(ip, email);
  const current = loginFailureStates.get(key);
  if (!current) return 0;
  return Math.max(0, current.blockedUntil - now);
}

function recordLoginFailure(ip: string, email: string): void {
  const key = getFailureKey(ip, email);
  const now = Date.now();
  const existing = loginFailureStates.get(key);
  const failures = (existing?.failures ?? 0) + 1;
  const backoffMs = Math.min(2 ** Math.min(failures, 8) * 1_000, LOGIN_MAX_BACKOFF_MS);
  loginFailureStates.set(key, {
    failures,
    blockedUntil: now + backoffMs,
  });
}

function clearLoginFailures(ip: string, email: string): void {
  loginFailureStates.delete(getFailureKey(ip, email));
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

const oauthClient = new OAuthClient();

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
  providers?: Record<string, { apiKey?: string }>;
  publicBaseUrl?: string;
  /**
   * Phase 4: snapshot of the gateway's exposure config loaded from the
   * `tool_catalog` row at startup. When omitted, code-level defaults are
   * used (for tests or embedded callers that have not seeded the catalog).
   */
  gatewayConfig?: LoadedGatewayConfig;
}

export function createGeneWeaveServer(config: ServerConfig): Server {
  const { db, chatEngine, jwtSecret, corsOrigin, providers, publicBaseUrl, gatewayConfig } = config;
  const dashboard = new DashboardService(db);
  const router = new Router();
  const uiHtml = getHTML();

  async function setOAuthState(state: string, value: { userId: string | null; provider: OAuthProviderName; expiresAt: number }): Promise<void> {
    await db.createOAuthFlowState({
      id: randomUUID(),
      state_key: state,
      user_id: value.userId,
      provider: value.provider,
      expires_at: new Date(value.expiresAt).toISOString(),
    });
  }

  async function consumeOAuthState(state: string): Promise<{ userId: string | null; provider: OAuthProviderName; expiresAt: number } | null> {
    const found = await db.consumeOAuthFlowStateByKey(state);
    if (!found) return null;
    return {
      userId: found.user_id,
      provider: found.provider as OAuthProviderName,
      expiresAt: Date.parse(found.expires_at),
    };
  }

  const oauthStateCleanupTimer = setInterval(() => {
    void db.deleteExpiredOAuthFlowStates().catch(() => {
      // Best effort cleanup only.
    });
  }, 60_000);
  oauthStateCleanupTimer.unref?.();

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

    const registerRate = checkAuthRateLimits('register', req, email);
    if (registerRate.limited) {
      const retryAfterSec = Math.ceil(registerRate.retryAfterMs / 1_000);
      res.setHeader('Retry-After', String(retryAfterSec));
      json(res, 429, { error: 'Too many registration attempts. Please retry later.' });
      return;
    }

    const existing = await db.getUserByEmail(email);
    if (existing) { json(res, 409, { error: 'Email already registered' }); return; }

    const users = await db.listUsers();
    const assignedPersona = users.length === 0 ? 'tenant_admin' : 'tenant_user';

    const userId = randomUUID();
    const passwordHash = await hashPassword(password);
    try {
      await db.createUser({ id: userId, email, name, passwordHash, persona: assignedPersona });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('UNIQUE constraint failed: users.email')) {
        json(res, 409, { error: 'Email already registered' });
        return;
      }
      throw error;
    }
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

    const clientIp = readClientIp(req);
    const lockedMs = getLoginBackoffMs(clientIp, email);
    if (lockedMs > 0) {
      const retryAfterSec = Math.ceil(lockedMs / 1_000);
      res.setHeader('Retry-After', String(retryAfterSec));
      json(res, 429, { error: 'Too many login attempts. Please retry later.' });
      return;
    }

    const loginRate = checkAuthRateLimits('login', req, email);
    if (loginRate.limited) {
      const retryAfterSec = Math.ceil(loginRate.retryAfterMs / 1_000);
      res.setHeader('Retry-After', String(retryAfterSec));
      json(res, 429, { error: 'Too many login attempts. Please retry later.' });
      return;
    }

    const user = await db.getUserByEmail(email);
    const verification = user
      ? await verifyPasswordDetailed(password, user.password_hash)
      : { ok: false, needsRehash: false };
    if (!user || !verification.ok) {
      recordLoginFailure(clientIp, email);
      json(res, 401, { error: 'Invalid credentials' });
      return;
    }

    clearLoginFailures(clientIp, email);

    if (verification.needsRehash) {
      const upgradedHash = await hashPassword(password);
      await db.updateUser(user.id, { passwordHash: upgradedHash });
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
      await setOAuthState(state, { userId: auth?.userId ?? null, provider, expiresAt: Date.now() + 600_000 });
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

    const stateData = await consumeOAuthState(state);
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
          passwordHash: await hashPassword(randomUUID()),
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

    const raw = await readBody(req, { maxBytes: LARGE_REQUEST_BODY_BYTES });
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

  // ── anyWeave Phase 5: Chat feedback bridge ─────────────
  // Authenticated users can submit a 👍/👎/regenerate/copy signal on any
  // assistant message. The signal is persisted to message_feedback and a
  // capability signal is recorded that updates production_signal_score on
  // the resolved (model, provider, task_key) row.
  router.post('/api/messages/:id/feedback', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const messageId = params['id']!;
    const raw = await readBody(req);
    let body: {
      signal?: string;
      comment?: string | null;
      modelId?: string;
      provider?: string;
      taskKey?: string;
      chatId?: string;
    };
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const validSignals = new Set(['thumbs_up', 'thumbs_down', 'regenerate', 'copy']);
    if (!body.signal || !validSignals.has(body.signal)) {
      json(res, 400, { error: 'signal must be one of thumbs_up|thumbs_down|regenerate|copy' });
      return;
    }
    if (!body.modelId || !body.provider || !body.taskKey) {
      json(res, 400, { error: 'modelId, provider, and taskKey are required (snapshot from the resolved decision)' });
      return;
    }
    try {
      const result = await recordChatFeedbackSignal(db, {
        signal: body.signal,
        messageId,
        modelId: body.modelId,
        provider: body.provider,
        taskKey: body.taskKey,
        tenantId: auth.tenantId ?? null,
        chatId: body.chatId ?? null,
        userId: auth.userId,
        comment: body.comment ?? null,
      });
      json(res, 201, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      json(res, 400, { error: msg });
    }
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

    const raw = await readBody(req, { maxBytes: LARGE_REQUEST_BODY_BYTES });
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

  // ── Internal MCP Gateway (Phase 1D) ────────────────────────
  // Exposes builtin tools whose allocation_class is in the operator-edited
  // tool_catalog `config.exposed_classes` (defaulting to web/social/search/
  // cse/http/enterprise/communication) over the MCP Streamable HTTP
  // protocol with bearer-token auth. Phase 4: exposure classes and the
  // enable toggle come from the DB so admin changes survive restart.
  const mcpGatewayToken = process.env['GENEWEAVE_MCP_GATEWAY_TOKEN'] ?? '';
  const gatewayEnabled = gatewayConfig?.enabled ?? true;
  const gatewayClasses = gatewayConfig?.exposedClasses ?? DEFAULT_EXPOSED_ALLOCATION_CLASSES;
  const gatewayEndpoint = gatewayConfig?.endpoint ?? '/api/mcp/gateway';
  const mcpGateway = createMCPGateway({
    token: gatewayEnabled && mcpGatewayToken ? mcpGatewayToken : undefined,
    exposedClasses: gatewayClasses,
    serverName: 'geneweave-gateway',
    serverVersion: '1.0.0',
    // Phase 3: every gateway invocation flows through the same policy +
    // audit + rate-limit pipeline as in-process chat tools, so external
    // MCP traffic is bound by operator-managed `tool_policies` and lands
    // in `tool_audit_events` with chatId='mcp-gateway' for filtering.
    policyResolver: new DbToolPolicyResolver(db),
    auditEmitter: new DbToolAuditEmitter(db),
    rateLimiter: new DbToolRateLimiter(db),
    // Phase 5: when the gateway is operator-enabled we wire a per-client
    // resolver so external callers can be individually attributed in the
    // audit log and scoped to a subset of allocation classes. Clients
    // that present a token whose hash is not in `mcp_gateway_clients`
    // are rejected with 401 — even if the legacy single-token env var
    // is also set. Both auth paths can coexist: the resolver first
    // attempts to match a registered client; if no client rows exist
    // (resolver returns null) the legacy single-token path is the
    // fallback for backward compatibility.
    ...(gatewayEnabled
      ? {
          clientResolver: async (hash: string) => {
            const row = await db.getMCPGatewayClientByTokenHash(hash);
            if (!row) return null;
            return row;
          },
          touchClient: (id: string) => db.touchMCPGatewayClient(id),
          gatewayRateLimiter: (clientId: string, windowStartIso: string, limit: number) =>
            db.checkAndIncrementGatewayRateLimit(clientId, windowStartIso, limit),
          requestLogger: async (entry) => {
            // Phase 8: persist every terminal outcome to mcp_gateway_request_log.
            // Best-effort: errors are swallowed by the gateway hook caller.
            const { randomUUID } = await import('node:crypto');
            await db.insertMCPGatewayRequestLog({
              id: randomUUID(),
              client_id: entry.clientId,
              client_name: entry.clientName,
              method: entry.method,
              tool_name: entry.toolName,
              outcome: entry.outcome,
              status_code: entry.statusCode,
              duration_ms: entry.durationMs,
              error_message: entry.errorMessage,
            });
          },
        }
      : {}),
  });

  // Diagnostic info endpoint — auth-required, no secret leakage. Operators
  // can use this to verify which tools the gateway is offering.
  router.get('/api/mcp/gateway/info', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Authentication required' }); return; }
    json(res, 200, {
      enabled: mcpGateway.enabled,
      operatorEnabled: gatewayEnabled,
      exposedClasses: [...gatewayClasses].sort(),
      exposedToolNames: mcpGateway.exposedToolNames,
      endpoint: gatewayEndpoint,
      authScheme: 'Bearer',
    });
  }, { auth: true });

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

    // ── MCP Gateway pass-through ──
    // The gateway has its own bearer-token auth and the MCP SDK transport
    // reads the body itself, so we bypass the router (which would consume
    // the stream and apply CSRF). The gateway returns 503 when no token is
    // configured, so it is loud-fail rather than silent.
    if (pathname === '/api/mcp/gateway' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
      try {
        await mcpGateway.handle(req, res);
      } catch (err) {
        console.error('[geneWeave][mcp-gateway] handler error:', err);
        if (!res.headersSent) {
          json(res, 500, { error: 'MCP gateway error' });
        }
      }
      return;
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
          } else if (msg === 'Too many concurrent request bodies') {
            json(res, 503, { error: 'Server is busy reading other requests. Please retry shortly.' });
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

  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = SERVER_MAX_HEADERS_COUNT;
  server.maxRequestsPerSocket = SERVER_MAX_REQUESTS_PER_SOCKET;

  return server;
}
