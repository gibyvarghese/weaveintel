import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter } from './db.js';
import { canPersonaAccess, normalizePersona } from './rbac.js';
import { authenticateRequest, verifyCSRF, type AuthContext } from './auth.js';
import { OAuthClient, createOAuthProvider, type OAuthProviderName } from '@weaveintel/oauth';

export type Handler = (
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

export class Router {
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

export async function readBody(req: IncomingMessage, opts?: { maxBytes?: number }): Promise<string> {
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

export function json(res: ServerResponse, status: number, data: unknown): void {
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
export const LARGE_REQUEST_BODY_BYTES = envInt('GENEWEAVE_LARGE_REQUEST_BODY_BYTES', 50 * 1024 * 1024);
export const SERVER_REQUEST_TIMEOUT_MS = envInt('GENEWEAVE_SERVER_REQUEST_TIMEOUT_MS', 30_000);
export const SERVER_HEADERS_TIMEOUT_MS = envInt('GENEWEAVE_SERVER_HEADERS_TIMEOUT_MS', 10_000);
export const SERVER_KEEP_ALIVE_TIMEOUT_MS = envInt('GENEWEAVE_SERVER_KEEPALIVE_TIMEOUT_MS', 5_000);
export const SERVER_MAX_HEADERS_COUNT = envInt('GENEWEAVE_SERVER_MAX_HEADERS_COUNT', 100);
export const SERVER_MAX_REQUESTS_PER_SOCKET = envInt('GENEWEAVE_SERVER_MAX_REQUESTS_PER_SOCKET', 100);

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

function normalizeIpAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === '::1') return '127.0.0.1';
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

function loadTrustedProxySet(): Set<string> {
  const raw = process.env['TRUSTED_PROXY_IPS'] ?? '';
  const values = raw
    .split(',')
    .map((part) => normalizeIpAddress(part))
    .filter(Boolean);
  return new Set(values);
}

function isTrustedProxy(ip: string, trusted: Set<string>): boolean {
  if (!ip) return false;
  if (trusted.has(ip)) return true;
  // Local proxy hops are trusted in development for local reverse-proxy setups.
  if (process.env['NODE_ENV'] !== 'production') {
    return ip === '127.0.0.1';
  }
  return false;
}

export function readClientIp(req: IncomingMessage): string {
  const trustedProxies = loadTrustedProxySet();
  const remote = normalizeIpAddress(req.socket.remoteAddress ?? '');
  if (!isTrustedProxy(remote, trustedProxies)) {
    return remote || 'unknown';
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    const hops = forwardedFor
      .split(',')
      .map((part) => normalizeIpAddress(part))
      .filter(Boolean);
    // Walk from nearest -> furthest and choose first untrusted hop.
    for (let i = hops.length - 1; i >= 0; i -= 1) {
      if (!isTrustedProxy(hops[i]!, trustedProxies)) {
        return hops[i]!;
      }
    }
    return (hops[0] ?? remote) || 'unknown';
  }

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return normalizeIpAddress(realIp) || remote || 'unknown';
  }

  return remote || 'unknown';
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

export function checkAuthRateLimits(kind: 'login' | 'register', req: IncomingMessage, email?: string): { limited: boolean; retryAfterMs: number } {
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

export function getFailureKey(ip: string, email: string): string {
  return `${ip}|${email.toLowerCase()}`;
}

export function getLoginBackoffMs(ip: string, email: string): number {
  const now = Date.now();
  cleanupAuthRateState(now);
  const key = getFailureKey(ip, email);
  const current = loginFailureStates.get(key);
  if (!current) return 0;
  return Math.max(0, current.blockedUntil - now);
}

export function recordLoginFailure(ip: string, email: string): void {
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

export function clearLoginFailures(ip: string, email: string): void {
  loginFailureStates.delete(getFailureKey(ip, email));
}

export function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function permissionForAdminRoute(path: string): string {
  if (path === '/api/admin/upgrade' || path.startsWith('/api/admin/tenants')) {
    return 'admin:platform:write';
  }
  if (path.startsWith('/api/admin/rbac')) {
    return 'admin:platform:write';
  }
  return 'admin:tenant:write';
}

export function ensurePermission(
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

export async function ensureAtLeastOneTenantAdmin(db: DatabaseAdapter, preferredUserId?: string): Promise<void> {
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

/**
 * Default OAuth client (in-memory state store). Phase G: replaced at boot
 * by `setOAuthClient(...)` with a runtime-backed durable state store so
 * pending authorization-code exchanges survive a restart. ESM live
 * binding propagates the swap to all importers (e.g. `routes/auth.ts`).
 */
export let oauthClient = new OAuthClient();

/** Phase G — swap the module-level `oauthClient` in once the runtime is ready. */
export function setOAuthClient(client: OAuthClient): void {
  oauthClient = client;
}

export function normalizePublicOrigin(value: string): string {
  const parsed = new URL(value);
  return parsed.origin;
}

export function resolveRequestOrigin(req: IncomingMessage): string {
  const hostHeader = req.headers['host'];
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!host) throw new Error('Missing Host header');
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return normalizePublicOrigin(`${protocol}://${host}`);
}

export function resolveAllowedOAuthOrigins(publicBaseUrl: string): Set<string> {
  const configured = normalizePublicOrigin(publicBaseUrl);
  const extras = (process.env['OAUTH_ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => normalizePublicOrigin(raw));
  return new Set([configured, ...extras]);
}

export function buildOAuthProviderFromRequest(provider: OAuthProviderName, req: IncomingMessage, publicBaseUrl?: string) {
  const isProduction = process.env['NODE_ENV'] === 'production';
  if (isProduction && !publicBaseUrl) {
    throw new Error('publicBaseUrl must be configured in production for OAuth routes');
  }

  let baseUrl: string;
  if (publicBaseUrl) {
    baseUrl = normalizePublicOrigin(publicBaseUrl);
    if (isProduction) {
      const requestOrigin = resolveRequestOrigin(req);
      const allowed = resolveAllowedOAuthOrigins(publicBaseUrl);
      if (!allowed.has(requestOrigin)) {
        throw new Error(`OAuth request origin not allowed: ${requestOrigin}`);
      }
    }
  } else {
    baseUrl = resolveRequestOrigin(req);
  }

  const redirectUri = `${baseUrl}/api/oauth/callback`;
  const clientId = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_ID`];
  const clientSecret = process.env[`OAUTH_${provider.toUpperCase()}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) throw new Error(`${provider} credentials not configured`);
  return createOAuthProvider(provider, clientId, clientSecret, redirectUri);
}
