/**
 * AuthManager over @weaveintel/connect: every token request is connect's `requestToken`, sent through the door the
 * caller gives (deterministic: no DNS, no global fetch).
 */
import { describe, expect, it } from 'vitest';
import type { SendResult, WireRequest } from '@weaveintel/connect';
import { AuthManager } from '../auth/manager.js';
import type { AuthProfile } from '../auth/types.js';

const door = (...answers: { status: number; body: unknown }[]) => {
  const sent: WireRequest[] = [];
  const send = async (r: WireRequest): Promise<SendResult> => {
    sent.push(r);
    const a = answers.shift() ?? { status: 500, body: {} };
    return { ok: true, status: a.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(a.body) };
  };
  return { sent, send };
};
const form = (r: WireRequest) => Object.fromEntries(new URLSearchParams(r.body ?? ''));

const cc: AuthProfile = { id: 'cc', label: 'CC', method: 'oauth2_client_credentials', domain: 'acme', clientId: 'cid', clientSecret: 'csecret', tokenUrl: 'https://{{domain}}.service-now.com/oauth_token.do', scopes: ['useraccount'] };
const code: AuthProfile = { id: 'code', label: 'Code', method: 'oauth2_authorization_code', domain: 'x', clientId: 'cid', clientSecret: 'csecret', tokenUrl: 'https://auth.example.test/token', redirectUri: 'https://app.example.test/cb' };

describe('AuthManager on connect', () => {
  it('client credentials: one form request with the id, secret and scope; the token is reused until it nears expiry', async () => {
    const d = door({ status: 200, body: { access_token: 'at-1', expires_in: 3600 } });
    const mgr = new AuthManager([cc], undefined, { send: d.send });
    expect((await mgr.getHeaders('cc'))['Authorization']).toBe('Bearer at-1');
    expect((await mgr.getHeaders('cc'))['Authorization']).toBe('Bearer at-1');
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]!.url).toBe('https://acme.service-now.com/oauth_token.do');
    expect(form(d.sent[0]!)).toEqual({ grant_type: 'client_credentials', scope: 'useraccount', client_id: 'cid', client_secret: 'csecret' });
  });

  it('code exchange sends the PKCE verifier and keeps the refresh token; refresh keeps it when none is reissued', async () => {
    const d = door({ status: 200, body: { access_token: 'at-a', refresh_token: 'rt-1', expires_in: 1 } }, { status: 200, body: { access_token: 'at-b', expires_in: 3600 } });
    const refreshed: string[] = [];
    const mgr = new AuthManager([code], { onTokenRefreshed: (id) => refreshed.push(id) }, { send: d.send });
    const first = await mgr.exchangeCode('code', 'c0de', 'v'.repeat(43));
    expect(first.refreshToken).toBe('rt-1');
    expect(form(d.sent[0]!)).toMatchObject({ grant_type: 'authorization_code', code: 'c0de', code_verifier: 'v'.repeat(43), redirect_uri: 'https://app.example.test/cb' });
    // expires_in 1 s is inside the 60 s refresh buffer, so the next call refreshes.
    expect((await mgr.getHeaders('code'))['Authorization']).toBe('Bearer at-b');
    expect(form(d.sent[1]!)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
    expect(mgr.get('code')!.tokenState!.refreshToken).toBe('rt-1');
    expect(refreshed).toEqual(['code']);
  });

  it('a rotated refresh token replaces the old one', async () => {
    const d = door({ status: 200, body: { access_token: 'at-c', refresh_token: 'rt-2', expires_in: 3600 } });
    const mgr = new AuthManager([{ ...code, tokenState: { accessToken: 'old', refreshToken: 'rt-1' } }], undefined, { send: d.send });
    expect((await mgr.refreshToken('code')).refreshToken).toBe('rt-2');
  });

  it('a refused token request fails closed, reports the status, and never carries the vendor text', async () => {
    const d = door({ status: 401, body: { error: 'invalid_client', error_description: 'csecret is wrong' } });
    const errors: Error[] = [];
    const mgr = new AuthManager([{ ...code, tokenState: { accessToken: 'old', refreshToken: 'rt-1', expiresAt: Date.now() - 1 } }], { onTokenError: (_id, e) => errors.push(e) }, { send: d.send });
    await expect(mgr.getHeaders('code')).rejects.toThrow(/^Token request failed \(401\)/);
    expect(errors[0]!.message).not.toMatch(/csecret|wrong/);
  });

  it('static headers come from connect appliers and fail closed on a missing part', async () => {
    const mgr = new AuthManager([{ id: 'b', label: 'B', method: 'basic', domain: 'x', username: 'u' }]);
    await expect(mgr.getHeaders('b')).rejects.toThrow(/password has not been stored/);
  });
});
