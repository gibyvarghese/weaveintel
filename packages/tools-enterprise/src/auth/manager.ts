/**
 * Universal Authentication Manager
 *
 * Holds named auth profiles (enterprise + social connectors) and turns one into request headers, acquiring and
 * refreshing OAuth tokens as needed.
 *
 * BUILT ON `@weaveintel/connect`. Every header is made by connect's credential appliers (`applyCredential`) and every
 * token request (client credentials, refresh, authorization-code exchange) is connect's one `requestToken`, sent
 * through this package's hardened fetch. This class adds only the profile store and the in-memory token state.
 *
 * @deprecated for new code. Use `@weaveintel/connect/credentials` directly: `applyCredential` with a
 * `createTokenCache()` for calls, and `requestToken` for code exchange. Those keep tokens out of profile objects,
 * refresh one at a time per key, and hand a rotated refresh token to the caller to seal before it is used.
 * AuthManager stays as a compatibility wrapper over them.
 */
import { applyCredential, createTokenCache, requestToken, type CredentialMaterial, type IssuedToken, type TokenGrant } from '@weaveintel/connect/credentials';
import type { Send, WireRequest } from '@weaveintel/connect';
import type { AuthProfile, TokenState, AuthEvents } from './types.js';
import { enterpriseFetch } from '../_fetch.js';

/** The one way out for token requests: this package's hardened fetch, answering as connect's door contract. */
const hardenedSend: Send = async (r: WireRequest) => {
  try {
    const resp = await enterpriseFetch(r.url, { method: r.method, headers: { ...r.headers }, ...(r.body === undefined ? {} : { body: r.body }) });
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { ok: true, status: resp.status, headers, body: await resp.text() };
  } catch (e) {
    return { ok: false, kind: 'unreachable', code: e instanceof Error ? e.name : 'error', sentence: 'The sign-in service could not be reached.' };
  }
};

/** Static appliers never fetch, so they get a cache that is never used. */
const NO_FETCH = { send: hardenedSend, cache: createTokenCache(), cacheKey: 'static' };
const PLACEHOLDER: WireRequest = { method: 'GET', url: 'https://auth.invalid/', headers: {} };

/* ---------- URL template helpers ---------- */

function resolveUrl(template: string | undefined, domain: string): string {
  if (!template) return '';
  return template.replaceAll('{{domain}}', domain);
}

/* ---------- Token expiry buffer (refresh 60 s early) ---------- */
const EXPIRY_BUFFER_MS = 60_000;

function isExpired(state?: TokenState): boolean {
  if (!state?.expiresAt) return false;
  return Date.now() > state.expiresAt - EXPIRY_BUFFER_MS;
}

/* ---------- Auth Manager ---------- */

export class AuthManager {
  private profiles = new Map<string, AuthProfile>();
  private events: AuthEvents;
  private send: Send;

  /**
   * @param options.send The way out for token requests (connect's door contract). Default: this package's hardened
   *   fetch. A host passes its own door so sign-in calls get its address rules and outbound log.
   */
  constructor(profiles?: AuthProfile[], events?: AuthEvents, options?: { readonly send?: Send }) {
    this.events = events ?? {};
    this.send = options?.send ?? hardenedSend;
    for (const p of profiles ?? []) this.register(p);
  }

  /** Register or update a profile */
  register(profile: AuthProfile): void {
    this.profiles.set(profile.id, { ...profile });
  }

  /** Remove a profile */
  remove(id: string): void {
    this.profiles.delete(id);
  }

  /** List all profiles */
  list(): AuthProfile[] {
    return [...this.profiles.values()];
  }

  /** Get a profile by ID */
  get(id: string): AuthProfile | undefined {
    return this.profiles.get(id);
  }

  /* ========== Header Injection ========== */

  /**
   * Return the authorization headers for a given profile.
   * Automatically refreshes expired OAuth/OIDC tokens.
   */
  async getHeaders(profileId: string): Promise<Record<string, string>> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Auth profile "${profileId}" not found`);

    const headers: Record<string, string> = { ...(profile.extraHeaders ?? {}) };

    switch (profile.method) {
      case 'basic':
        headers['Authorization'] = (await this.applyStatic(profile, { kind: 'basic', secrets: { password: profile.password ?? '' }, settings: { username: profile.username ?? '' } })).headers['authorization']!;
        break;

      case 'api_key': {
        const name = profile.apiKeyHeaderName ?? (profile.apiKeyPlacement === 'query' ? 'api_key' : 'X-API-Key');
        const applied = await this.applyStatic(profile, { kind: 'api_key', secrets: { api_key: profile.apiKey ?? '' }, settings: { placement: profile.apiKeyPlacement ?? 'header', name } });
        if (profile.apiKeyPlacement === 'query') {
          // AuthManager returns headers only, so a query key travels as a pseudo-header the caller moves onto the URL.
          headers['X-Auth-Query-Param'] = new URL(applied.url).search.slice(1);
        } else {
          headers[name] = applied.headers[name.toLowerCase()]!;
        }
        break;
      }

      case 'bearer':
        headers['Authorization'] = (await this.applyStatic(profile, { kind: 'bearer_token', secrets: { token: profile.apiKey ?? profile.tokenState?.accessToken ?? '' }, settings: {} })).headers['authorization']!;
        break;

      case 'service_account': {
        // For service accounts the token is typically exchanged via JWT assertion
        // or pre-set. If we have a tokenState, use it.
        if (profile.tokenState) {
          headers['Authorization'] = `Bearer ${profile.tokenState.accessToken}`;
        }
        break;
      }

      case 'oauth2_authorization_code':
      case 'oauth2_client_credentials':
      case 'oidc': {
        await this.ensureValidToken(profile);
        if (profile.tokenState) {
          headers['Authorization'] = `Bearer ${profile.tokenState.accessToken}`;
        }
        break;
      }
    }

    return headers;
  }

  /* ========== OAuth / OIDC Token Management ========== */

  /**
   * Build the authorization URL for the authorization-code flow.
   * The caller must redirect the user to this URL and capture the code.
   */
  buildAuthorizationUrl(profileId: string, state?: string): string {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Auth profile "${profileId}" not found`);
    const authUrl = resolveUrl(profile.authorizationUrl, profile.domain);
    if (!authUrl) throw new Error(`No authorizationUrl configured for "${profileId}"`);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: profile.clientId ?? '',
      redirect_uri: profile.redirectUri ?? '',
      scope: (profile.scopes ?? []).join(' '),
    });
    if (state) params.set('state', state);
    if (profile.method === 'oidc') {
      params.set('response_type', 'code');
      if (!params.get('scope')?.includes('openid')) {
        params.set('scope', `openid ${params.get('scope') ?? ''}`);
      }
    }
    return `${authUrl}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens (authorization-code flow).
   * @param codeVerifier The PKCE verifier, when the authorization request carried a challenge.
   */
  async exchangeCode(profileId: string, code: string, codeVerifier?: string): Promise<TokenState> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Auth profile "${profileId}" not found`);
    const state = this.toTokenState(await this.token(profile, { type: 'authorization_code', code, redirectUri: profile.redirectUri ?? '', ...(codeVerifier === undefined ? {} : { codeVerifier }) }));
    profile.tokenState = state;
    return state;
  }

  /**
   * Acquire a token using client-credentials grant.
   */
  async acquireClientCredentials(profileId: string): Promise<TokenState> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Auth profile "${profileId}" not found`);
    const state = this.toTokenState(await this.token(profile, { type: 'client_credentials' }));
    profile.tokenState = state;
    return state;
  }

  /**
   * Refresh an expired token using the stored refresh_token.
   */
  async refreshToken(profileId: string): Promise<TokenState> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Auth profile "${profileId}" not found`);
    if (!profile.tokenState?.refreshToken) {
      throw new Error(`No refresh token available for "${profileId}"`);
    }
    const state = this.toTokenState(await this.token(profile, { type: 'refresh_token' }));
    // Preserve existing refresh token if the server didn't issue a new one
    if (!state.refreshToken && profile.tokenState.refreshToken) {
      state.refreshToken = profile.tokenState.refreshToken;
    }
    profile.tokenState = state;
    this.events.onTokenRefreshed?.(profileId, state);
    return state;
  }

  /**
   * Manually set the token state (e.g. after an external OAuth flow).
   */
  setTokenState(profileId: string, state: TokenState): void {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Auth profile "${profileId}" not found`);
    profile.tokenState = state;
  }

  /* ========== Internal helpers ========== */

  private async ensureValidToken(profile: AuthProfile): Promise<void> {
    // If no token at all and client-credentials, acquire one
    if (!profile.tokenState?.accessToken) {
      if (profile.method === 'oauth2_client_credentials') {
        await this.acquireClientCredentials(profile.id);
        return;
      }
      // For auth-code / OIDC, we can't auto-acquire; caller must do the flow
      return;
    }
    // If token expired, try refresh
    if (isExpired(profile.tokenState)) {
      try {
        if (profile.tokenState.refreshToken) {
          await this.refreshToken(profile.id);
          return;
        }
        if (profile.method === 'oauth2_client_credentials') {
          await this.acquireClientCredentials(profile.id);
          return;
        }
        throw new Error(`Token for "${profile.id}" is expired and cannot be refreshed automatically`);
      } catch (err) {
        const failure = err instanceof Error ? err : new Error(String(err));
        this.events.onTokenError?.(profile.id, failure);
        throw failure;
      }
    }
  }

  /** Put a static credential on a placeholder request with connect's applier; a refusal fails closed. */
  private async applyStatic(profile: AuthProfile, material: CredentialMaterial): Promise<WireRequest> {
    const r = await applyCredential(PLACEHOLDER, material, NO_FETCH);
    if (!r.ok) throw new Error(`Auth profile "${profile.id}": ${r.sentence}`);
    return r.request;
  }

  /** One token request through connect, for this profile. The sign-in service's own error text is never included. */
  private async token(profile: AuthProfile, grant: TokenGrant): Promise<IssuedToken> {
    const settings = { client_id: profile.clientId ?? '', token_url: resolveUrl(profile.tokenUrl, profile.domain), client_auth: 'client_secret_post' };
    const material: CredentialMaterial = grant.type === 'client_credentials'
      ? { kind: 'oauth_client', secrets: { client_secret: profile.clientSecret ?? '' }, settings: { ...settings, scope: (profile.scopes ?? []).join(' ') } }
      : { kind: 'oauth_refresh', secrets: { client_secret: profile.clientSecret ?? '', refresh_token: profile.tokenState?.refreshToken ?? '' }, settings };
    // A rotated refresh token is kept on the profile's token state (below), which is this class's store.
    const r = await requestToken(material, grant, { send: this.send, onRotate: async () => {} });
    if (!r.ok) throw new Error(`Token request failed (${r.status ?? r.code}): ${r.sentence}`);
    return r.token;
  }

  private toTokenState(t: IssuedToken): TokenState {
    return {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      tokenType: t.tokenType,
      idToken: t.idToken,
      scope: t.scope,
      expiresAt: t.expiresInSeconds !== undefined ? Date.now() + t.expiresInSeconds * 1000 : undefined,
    };
  }
}
