/**
 * @weaveintel/geneweave — Authentication module
 *
 * JWT (HMAC-SHA256 via node:crypto), scrypt password hashing, CSRF tokens,
 * cookie-based session management. Zero external dependencies.
 */

import { createHmac, scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseAdapter, SessionRow } from './db.js';

// ─── JWT ─────────────────────────────────────────────────────

// Hand-rolled JWT implementation using HMAC-SHA256 via node:crypto.
// Avoids external dependencies (no jsonwebtoken). The signJWT/verifyJWT
// pair produces/validates base64url-encoded tokens with iat/exp claims.

export interface JWTPayload {
  userId: string;
  email: string;
  sessionId: string;
  iat: number;
  exp: number;
}

function base64url(data: string | Buffer): string {
  return Buffer.from(data).toString('base64url');
}

export function signJWT(payload: Omit<JWTPayload, 'iat' | 'exp'>, secret: string, expiresInSeconds = 86400): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const full: JWTPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(full));
  const signature = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  return `${headerB64}.${payloadB64}.${signature}`;
}

export function verifyJWT(token: string, secret: string): JWTPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) return null;

  try {
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) as { alg?: string; typ?: string };
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
  } catch {
    return null;
  }

  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  if (signatureB64.length !== expectedSig.length) return null;
  if (!timingSafeEqual(Buffer.from(signatureB64), Buffer.from(expectedSig))) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()) as JWTPayload;
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Password hashing (scrypt) ───────────────────────────────

// Uses scrypt (memory-hard KDF) with random salt for password storage.
// hashPassword() returns "salt:hash"; verifyPassword() uses timingSafeEqual
// to prevent timing attacks during comparison.

export function hashPassword(password: string): string {
  const salt = randomBytes(32).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const hashBuffer = Buffer.from(hash, 'hex');
  const derivedKey = scryptSync(password, salt, 64);
  return timingSafeEqual(hashBuffer, derivedKey);
}

// ─── CSRF ────────────────────────────────────────────────────

export function generateCSRFToken(): string {
  return randomBytes(32).toString('hex');
}

// ─── Cookie helpers ──────────────────────────────────────────

export function setAuthCookie(res: ServerResponse, token: string, maxAge = 86400): void {
  const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gw_token=${token}; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}

export function clearAuthCookie(res: ServerResponse): void {
  const secure = process.env['NODE_ENV'] === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `gw_token=; HttpOnly${secure}; SameSite=Strict; Path=/; Max-Age=0`);
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? '';
  const cookies: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

// ─── Auth context ───────────────────────────────────────────

// authenticateRequest() is the auth middleware used by the Router.
// It reads the gw_token HttpOnly cookie, verifies the JWT signature,
// checks expiry, and validates the session ID against the database.
// Returns an AuthContext (userId, email, sessionId, csrfToken) or null.─

export interface AuthContext {
  userId: string;
  email: string;
  sessionId: string;
  csrfToken: string;
  persona: string;
  tenantId: string | null;
}

export interface AuthenticatedRequest extends IncomingMessage {
  auth?: AuthContext;
}

/**
 * Authenticate an incoming request by verifying the JWT cookie and
 * looking up the session in the database.
 * Returns the AuthContext on success, null on failure.
 */
export async function authenticateRequest(
  req: IncomingMessage,
  db: DatabaseAdapter,
  jwtSecret: string,
): Promise<AuthContext | null> {
  const cookies = parseCookies(req);
  const token = cookies['gw_token'];
  if (!token) return null;

  const payload = verifyJWT(token, jwtSecret);
  if (!payload) return null;

  const session = await db.getSession(payload.sessionId);
  if (!session) return null;
  if (session.user_id !== payload.userId) return null;
  const user = await db.getUserById(payload.userId);
  if (!user) return null;

  return {
    userId: payload.userId,
    email: payload.email,
    sessionId: payload.sessionId,
    csrfToken: session.csrf_token,
    persona: user.persona,
    tenantId: user.tenant_id,
  };
}

/**
 * CSRF check for mutating requests (POST, PUT, DELETE, PATCH).
 * Compares the X-CSRF-Token header against the session's stored token.
 */
export function verifyCSRF(req: IncomingMessage, auth: AuthContext): boolean {
  const headerToken = req.headers['x-csrf-token'];
  if (!headerToken || typeof headerToken !== 'string') return false;
  if (headerToken.length !== auth.csrfToken.length) return false;
  return timingSafeEqual(Buffer.from(headerToken), Buffer.from(auth.csrfToken));
}
