import { describe, expect, it } from 'vitest';
import {
  isAllowedNativeRedirect,
  encodeNativeOAuthState,
  parseNativeOAuthState,
  buildNativeOAuthRedirect,
  buildNativeOAuthError,
} from './oauth-native.js';
import { listConfiguredOAuthProviders } from './server-core.js';

describe('oauth-native redirect allowlist', () => {
  it('accepts app schemes', () => {
    expect(isAllowedNativeRedirect('geneweave://oauth')).toBe(true);
    expect(isAllowedNativeRedirect('exp://127.0.0.1:8081/--/oauth')).toBe(true);
  });

  it('rejects open-redirect targets', () => {
    expect(isAllowedNativeRedirect('https://evil.example/oauth')).toBe(false);
    expect(isAllowedNativeRedirect('http://localhost/oauth')).toBe(false);
    expect(isAllowedNativeRedirect('//evil.example')).toBe(false);
    expect(isAllowedNativeRedirect('not a uri')).toBe(false);
  });
});

describe('oauth-native state round-trip', () => {
  it('encodes and recovers the redirect uri', () => {
    const redirect = 'exp://192.168.1.5:8081/--/oauth';
    const state = encodeNativeOAuthState(redirect, 'nonce-123');
    expect(state.startsWith('native:')).toBe(true);
    const parsed = parseNativeOAuthState(state);
    expect(parsed.native).toBe(true);
    expect(parsed.redirectUri).toBe(redirect);
  });

  it('treats a plain nonce as non-native', () => {
    const parsed = parseNativeOAuthState('0192f8e3-1234-7abc-9def-0123456789ab');
    expect(parsed.native).toBe(false);
    expect(parsed.redirectUri).toBeUndefined();
  });
});

describe('oauth-native redirect building', () => {
  it('appends the session as query params', () => {
    const url = buildNativeOAuthRedirect('geneweave://oauth', {
      token: 'tok',
      csrfToken: 'csrf',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('token')).toBe('tok');
    expect(parsed.searchParams.get('csrfToken')).toBe('csrf');
    expect(parsed.searchParams.get('expiresAt')).toBe('2030-01-01T00:00:00.000Z');
  });

  it('preserves an existing query string', () => {
    const url = buildNativeOAuthRedirect('exp://host/--/oauth?foo=1', {
      token: 't',
      csrfToken: 'c',
      expiresAt: 'x',
    });
    expect(url).toContain('foo=1');
    expect(url).toContain('&token=t');
  });

  it('builds an error redirect', () => {
    const url = buildNativeOAuthError('geneweave://oauth', 'access_denied');
    expect(new URL(url).searchParams.get('error')).toBe('access_denied');
  });
});

describe('listConfiguredOAuthProviders', () => {
  it('returns only providers with both id and secret, in canonical order', () => {
    const env = {
      OAUTH_GITHUB_CLIENT_ID: 'gh',
      OAUTH_GITHUB_CLIENT_SECRET: 'gh-secret',
      OAUTH_GOOGLE_CLIENT_ID: 'g',
      OAUTH_GOOGLE_CLIENT_SECRET: 'g-secret',
      OAUTH_APPLE_CLIENT_ID: 'a', // secret missing -> excluded
    } as unknown as NodeJS.ProcessEnv;
    expect(listConfiguredOAuthProviders(env)).toEqual(['google', 'github']);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(listConfiguredOAuthProviders({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});
