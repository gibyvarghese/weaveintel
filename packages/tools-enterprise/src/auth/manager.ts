/**
 * Universal Authentication Manager
 *
 * Handles token acquisition, refresh, and header injection for all
 * supported auth methods. Designed to be shared across all connectors
 * (enterprise + social) via a single profile store.
 */
import type { AuthProfile, TokenState, TokenResponse, AuthEvents } from './types.js';

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

  constructor(profiles?: AuthProfile[], events?: AuthEvents) {
    this.events = events ?? {};
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
      case 'basic': {
        const user = profile.username ?? '';
        const pass = profile.password ?? '';
        headers['Authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
        break;
      }

      case 'api_key': {
        const key = profile.apiKey ?? '';
        if (profile.apiKeyPlacement === 'query') {
          // caller must append to URL; we store in a custom pseudo-header
          headers['X-Auth-Query-Param'] = `${profile.apiKeyHeaderName ?? 'api_key'}=${key}`;
        } else {
          headers[profile.apiKeyHeaderName ?? 'X-API-Key'] = key;
        }
        break;
      }

      case 'bearer': {
        headers['Authorization'] = `Bearer ${profile.apiKey ?? profile.tokenState?.accessToken ?? ''}`;
        break;
      }

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
   */
  async exchangeCode(profileId: string, code: string): Promise<TokenState> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Auth profile "${profileId}" not found`);
    const tokenUrl = resolveUrl(profile.tokenUrl, profile.domain);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: profile.redirectUri ?? '',
      client_id: profile.clientId ?? '',
      client_secret: profile.clientSecret ?? '',
    });
    const tokenResp = await this.fetchToken(tokenUrl, body);
    const state = this.toTokenState(tokenResp);
    profile.tokenState = state;
    return state;
  }

  /**
   * Acquire a token using client-credentials grant.
   */
  async acquireClientCredentials(profileId: string): Promise<TokenState> {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Auth profile "${profileId}" not found`);
    const tokenUrl = resolveUrl(profile.tokenUrl, profile.domain);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: profile.clientId ?? '',
      client_secret: profile.clientSecret ?? '',
      scope: (profile.scopes ?? []).join(' '),
    });
    const tokenResp = await this.fetchToken(tokenUrl, body);
    const state = this.toTokenState(tokenResp);
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
    const tokenUrl = resolveUrl(profile.tokenUrl, profile.domain);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: profile.tokenState.refreshToken,
      client_id: profile.clientId ?? '',
      client_secret: profile.clientSecret ?? '',
    });
    const tokenResp = await this.fetchToken(tokenUrl, body);
    const state = this.toTokenState(tokenResp);
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

  private async fetchToken(url: string, body: URLSearchParams): Promise<TokenResponse> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Token request failed (${resp.status}): ${text}`);
    }
    return resp.json() as Promise<TokenResponse>;
  }

  private toTokenState(resp: TokenResponse): TokenState {
    return {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      tokenType: resp.token_type,
      idToken: resp.id_token,
      scope: resp.scope,
      expiresAt: resp.expires_in ? Date.now() + resp.expires_in * 1000 : undefined,
    };
  }
}
