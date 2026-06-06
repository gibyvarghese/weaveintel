import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from '../db.js';
import {
  hashPassword,
  verifyPasswordDetailed,
  signJWT,
  generateCSRFToken,
  setAuthCookie,
  clearAuthCookie,
} from '../auth.js';
import { isValidPersona, personaPermissions } from '../rbac.js';
import { OAuthClient, type OAuthProviderName } from '@weaveintel/oauth';
import {
  readBody,
  json,
  html,
  checkAuthRateLimits,
  getFailureKey,
  getLoginBackoffMs,
  recordLoginFailure,
  clearLoginFailures,
  readClientIp,
  ensureAtLeastOneTenantAdmin,
  oauthClient,
  buildOAuthProviderFromRequest,
} from '../server-core.js';
import type { Router } from '../server-core.js';

interface AuthRouteOptions {
  jwtSecret: string;
  corsOrigin?: string;
  publicBaseUrl?: string;
  setOAuthState: (state: string, value: { userId: string | null; provider: OAuthProviderName; expiresAt: number }) => Promise<void>;
  consumeOAuthState: (state: string) => Promise<{ userId: string | null; provider: OAuthProviderName; expiresAt: number } | null>;
}

export function registerAuthRoutes(
  router: Router,
  db: DatabaseAdapter,
  options: AuthRouteOptions,
): void {
  const { jwtSecret, corsOrigin, publicBaseUrl, setOAuthState, consumeOAuthState } = options;
  void OAuthClient; // imported via server-core.oauthClient

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

    const userId = newUUIDv7();
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

    const sessionId = newUUIDv7();
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
      json(res, 429, { error: 'Too many login attempts. Please retry later.', correlationId: newUUIDv7() });
      return;
    }

    const user = await db.getUserByEmail(email);
    const verification = user
      ? await verifyPasswordDetailed(password, user.password_hash)
      : { ok: false, needsRehash: false };
    if (!user || !verification.ok) {
      recordLoginFailure(clientIp, email);
      json(res, 401, { error: 'Invalid credentials', correlationId: newUUIDv7() });
      return;
    }

    clearLoginFailures(clientIp, email);

    if (verification.needsRehash) {
      const upgradedHash = await hashPassword(password);
      await db.updateUser(user.id, { passwordHash: upgradedHash });
    }

    await ensureAtLeastOneTenantAdmin(db, user.id);
    const effectiveUser = (await db.getUserById(user.id)) ?? user;

    const sessionId = newUUIDv7();
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
      const state = newUUIDv7();
      const oauthProvider = buildOAuthProviderFromRequest(provider, req, publicBaseUrl);
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
      const oauthProvider = buildOAuthProviderFromRequest(provider, req, publicBaseUrl);
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
        resolvedUserId = newUUIDv7();
        const fallbackEmail = (oauthProfile.email && oauthProfile.email.includes('@'))
          ? oauthProfile.email
          : `${provider}-${oauthProfile.id}@oauth.local`;
        const fallbackName = oauthProfile.name || `${provider} user`;
        await db.createUser({
          id: resolvedUserId,
          email: fallbackEmail,
          name: fallbackName,
          passwordHash: await hashPassword(newUUIDv7()),
        });
      }

      await db.createOAuthLinkedAccount({
        id: newUUIDv7(),
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
        const sessionId = newUUIDv7();
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

}
