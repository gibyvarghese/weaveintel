/**
 * @weaveintel/tools-enterprise — Auth Manager unit tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthManager } from '../auth/manager.js';
import type { AuthProfile, TokenState } from '../auth/types.js';

/* ---------- helpers ---------- */

function basicProfile(overrides?: Partial<AuthProfile>): AuthProfile {
  return {
    id: 'test-basic',
    label: 'Test Basic',
    method: 'basic',
    domain: 'example',
    username: 'alice',
    password: 'secret',
    ...overrides,
  };
}

function apiKeyProfile(overrides?: Partial<AuthProfile>): AuthProfile {
  return {
    id: 'test-apikey',
    label: 'Test API Key',
    method: 'api_key',
    domain: 'example',
    apiKey: 'my-api-key',
    ...overrides,
  };
}

function bearerProfile(overrides?: Partial<AuthProfile>): AuthProfile {
  return {
    id: 'test-bearer',
    label: 'Test Bearer',
    method: 'bearer',
    domain: 'example',
    apiKey: 'my-bearer-token',
    ...overrides,
  };
}

function oauthProfile(overrides?: Partial<AuthProfile>): AuthProfile {
  return {
    id: 'test-oauth',
    label: 'Test OAuth',
    method: 'oauth2_authorization_code',
    domain: 'mycompany',
    clientId: 'client-123',
    clientSecret: 'secret-456',
    authorizationUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    scopes: ['read', 'write'],
    redirectUri: 'http://localhost:3500/auth/callback',
    ...overrides,
  };
}

function clientCredentialsProfile(overrides?: Partial<AuthProfile>): AuthProfile {
  return {
    id: 'test-cc',
    label: 'Test Client Credentials',
    method: 'oauth2_client_credentials',
    domain: 'mycompany',
    clientId: 'cc-client',
    clientSecret: 'cc-secret',
    tokenUrl: 'https://{{domain}}.service-now.com/oauth_token.do',
    scopes: ['useraccount'],
    ...overrides,
  };
}

/* ---------- fetch mock ---------- */
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Profile CRUD ────────────────────────────────────────────

describe('AuthManager — profile management', () => {
  it('registers and retrieves a profile', () => {
    const mgr = new AuthManager();
    mgr.register(basicProfile());
    expect(mgr.get('test-basic')).toBeDefined();
    expect(mgr.get('test-basic')!.label).toBe('Test Basic');
  });

  it('initialises from constructor', () => {
    const mgr = new AuthManager([basicProfile(), apiKeyProfile()]);
    expect(mgr.list()).toHaveLength(2);
  });

  it('removes a profile', () => {
    const mgr = new AuthManager([basicProfile()]);
    mgr.remove('test-basic');
    expect(mgr.get('test-basic')).toBeUndefined();
    expect(mgr.list()).toHaveLength(0);
  });

  it('lists all profiles', () => {
    const mgr = new AuthManager([basicProfile(), apiKeyProfile(), bearerProfile()]);
    expect(mgr.list()).toHaveLength(3);
  });

  it('overwrites on re-register', () => {
    const mgr = new AuthManager([basicProfile()]);
    mgr.register(basicProfile({ label: 'Updated' }));
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get('test-basic')!.label).toBe('Updated');
  });
});

// ─── Header Generation ──────────────────────────────────────

describe('AuthManager — getHeaders', () => {
  it('returns Basic auth header', async () => {
    const mgr = new AuthManager([basicProfile()]);
    const headers = await mgr.getHeaders('test-basic');
    const expected = Buffer.from('alice:secret').toString('base64');
    expect(headers['Authorization']).toBe(`Basic ${expected}`);
  });

  it('returns API Key header', async () => {
    const mgr = new AuthManager([apiKeyProfile()]);
    const headers = await mgr.getHeaders('test-apikey');
    expect(headers['X-API-Key']).toBe('my-api-key');
  });

  it('returns custom API key header name', async () => {
    const mgr = new AuthManager([apiKeyProfile({ apiKeyHeaderName: 'X-Custom-Key' })]);
    const headers = await mgr.getHeaders('test-apikey');
    expect(headers['X-Custom-Key']).toBe('my-api-key');
  });

  it('returns API key as query param pseudo-header', async () => {
    const mgr = new AuthManager([apiKeyProfile({ apiKeyPlacement: 'query' })]);
    const headers = await mgr.getHeaders('test-apikey');
    expect(headers['X-Auth-Query-Param']).toBe('api_key=my-api-key');
  });

  it('returns Bearer auth header', async () => {
    const mgr = new AuthManager([bearerProfile()]);
    const headers = await mgr.getHeaders('test-bearer');
    expect(headers['Authorization']).toBe('Bearer my-bearer-token');
  });

  it('includes extra headers', async () => {
    const mgr = new AuthManager([basicProfile({ extraHeaders: { 'X-Custom': 'val' } })]);
    const headers = await mgr.getHeaders('test-basic');
    expect(headers['X-Custom']).toBe('val');
    expect(headers['Authorization']).toBeDefined();
  });

  it('throws for unknown profile', async () => {
    const mgr = new AuthManager();
    await expect(mgr.getHeaders('nonexistent')).rejects.toThrow('not found');
  });

  it('returns Bearer for service_account with tokenState', async () => {
    const mgr = new AuthManager([{
      id: 'sa',
      label: 'SA',
      method: 'service_account',
      domain: 'x',
      tokenState: { accessToken: 'sa-token-123' },
    }]);
    const headers = await mgr.getHeaders('sa');
    expect(headers['Authorization']).toBe('Bearer sa-token-123');
  });
});

// ─── OAuth Authorization URL ─────────────────────────────────

describe('AuthManager — buildAuthorizationUrl', () => {
  it('builds authorization URL with required params', () => {
    const mgr = new AuthManager([oauthProfile()]);
    const url = mgr.buildAuthorizationUrl('test-oauth', 'state-123');
    expect(url).toContain('https://auth.example.com/authorize?');
    expect(url).toContain('response_type=code');
    expect(url).toContain('client_id=client-123');
    expect(url).toContain('redirect_uri=');
    expect(url).toContain('scope=read+write');
    expect(url).toContain('state=state-123');
  });

  it('throws for unknown profile', () => {
    const mgr = new AuthManager();
    expect(() => mgr.buildAuthorizationUrl('nope')).toThrow('not found');
  });

  it('throws when no authorizationUrl configured', () => {
    const mgr = new AuthManager([oauthProfile({ authorizationUrl: undefined })]);
    expect(() => mgr.buildAuthorizationUrl('test-oauth')).toThrow('No authorizationUrl');
  });

  it('resolves {{domain}} placeholder', () => {
    const mgr = new AuthManager([oauthProfile({
      authorizationUrl: 'https://{{domain}}.example.com/auth',
      domain: 'acme',
    })]);
    const url = mgr.buildAuthorizationUrl('test-oauth');
    expect(url).toContain('https://acme.example.com/auth?');
  });

  it('adds openid scope for OIDC method', () => {
    const mgr = new AuthManager([oauthProfile({ method: 'oidc', scopes: ['profile', 'email'] })]);
    const url = mgr.buildAuthorizationUrl('test-oauth');
    expect(url).toContain('openid');
  });
});

// ─── Token Exchange ──────────────────────────────────────────

describe('AuthManager — exchangeCode', () => {
  it('exchanges auth code for tokens', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'at-123',
        refresh_token: 'rt-456',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });

    const mgr = new AuthManager([oauthProfile()]);
    const state = await mgr.exchangeCode('test-oauth', 'auth-code-xyz');

    expect(state.accessToken).toBe('at-123');
    expect(state.refreshToken).toBe('rt-456');
    expect(state.expiresAt).toBeGreaterThan(Date.now());

    // Verify the stored token is now used for headers
    const headers = await mgr.getHeaders('test-oauth');
    expect(headers['Authorization']).toBe('Bearer at-123');
  });

  it('throws for unknown profile', async () => {
    const mgr = new AuthManager();
    await expect(mgr.exchangeCode('nope', 'code')).rejects.toThrow('not found');
  });
});

// ─── Client Credentials ─────────────────────────────────────

describe('AuthManager — acquireClientCredentials', () => {
  it('acquires token with client credentials', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'cc-token-789',
        expires_in: 7200,
        token_type: 'Bearer',
      }),
    });

    const mgr = new AuthManager([clientCredentialsProfile()]);
    const state = await mgr.acquireClientCredentials('test-cc');

    expect(state.accessToken).toBe('cc-token-789');
    expect(state.expiresAt).toBeGreaterThan(Date.now());

    // Verify it called the correct URL with domain resolved
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://mycompany.service-now.com/oauth_token.do');
  });
});

// ─── Token Refresh ───────────────────────────────────────────

describe('AuthManager — refreshToken', () => {
  it('refreshes expired tokens', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new-at-999',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });

    const mgr = new AuthManager([oauthProfile({
      tokenState: {
        accessToken: 'old-at',
        refreshToken: 'rt-existing',
        expiresAt: Date.now() - 1000, // expired
      },
    })]);
    const state = await mgr.refreshToken('test-oauth');

    expect(state.accessToken).toBe('new-at-999');
    // Should preserve existing refresh token if server didn't return one
    expect(state.refreshToken).toBe('rt-existing');
  });

  it('fires onTokenRefreshed event', async () => {
    const onRefreshed = vi.fn();
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'refreshed-at',
        expires_in: 3600,
      }),
    });

    const mgr = new AuthManager(
      [oauthProfile({ tokenState: { accessToken: 'old', refreshToken: 'rt' } })],
      { onTokenRefreshed: onRefreshed },
    );
    await mgr.refreshToken('test-oauth');

    expect(onRefreshed).toHaveBeenCalledOnce();
    expect(onRefreshed.mock.calls[0]![0]).toBe('test-oauth');
  });

  it('throws when no refresh token available', async () => {
    const mgr = new AuthManager([oauthProfile({
      tokenState: { accessToken: 'at', expiresAt: Date.now() - 1000 },
    })]);
    await expect(mgr.refreshToken('test-oauth')).rejects.toThrow('No refresh token');
  });
});

// ─── setTokenState ───────────────────────────────────────────

describe('AuthManager — setTokenState', () => {
  it('manually sets token state', async () => {
    const mgr = new AuthManager([oauthProfile()]);
    const ts: TokenState = { accessToken: 'manual-token', refreshToken: 'manual-rt', expiresAt: Date.now() + 60_000 };
    mgr.setTokenState('test-oauth', ts);

    const headers = await mgr.getHeaders('test-oauth');
    expect(headers['Authorization']).toBe('Bearer manual-token');
  });

  it('throws for unknown profile', () => {
    const mgr = new AuthManager();
    expect(() => mgr.setTokenState('nope', { accessToken: 'x' })).toThrow('not found');
  });
});

// ─── Auto-refresh on getHeaders ──────────────────────────────

describe('AuthManager — auto-refresh on getHeaders', () => {
  it('refreshes expired OAuth token automatically', async () => {
    // First call: refresh token exchange
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'auto-refreshed',
        expires_in: 3600,
      }),
    });

    const mgr = new AuthManager([oauthProfile({
      tokenState: {
        accessToken: 'expired-at',
        refreshToken: 'rt-auto',
        expiresAt: Date.now() - 10_000, // well expired
      },
    })]);

    const headers = await mgr.getHeaders('test-oauth');
    expect(headers['Authorization']).toBe('Bearer auto-refreshed');
  });

  it('auto-acquires for client_credentials when no token', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'cc-auto',
        expires_in: 3600,
      }),
    });

    const mgr = new AuthManager([clientCredentialsProfile()]);
    const headers = await mgr.getHeaders('test-cc');
    expect(headers['Authorization']).toBe('Bearer cc-auto');
  });
});
