// The one OAuth token request: every grant, client authentication, rotation, and refusals that never carry a secret.
import { describe, expect, it } from 'vitest'
import type { SendResult, WireRequest } from '../types.js'
import { requestToken } from './token.js'
import type { CredentialMaterial } from './apply.js'

const answer = (status: number, body: unknown): SendResult => ({ ok: true, status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const recorder = (r: SendResult) => {
  const sent: WireRequest[] = []
  return { sent, send: async (q: WireRequest) => { sent.push(q); return r } }
}
const form = (q: WireRequest) => Object.fromEntries(new URLSearchParams(q.body ?? ''))

const client: CredentialMaterial = { kind: 'oauth_client', secrets: { client_secret: 's3cret-value' }, settings: { client_id: 'cid', token_url: 'https://id.example.test/token', scope: 'read write' } }
const refresh: CredentialMaterial = { kind: 'oauth_refresh', secrets: { client_secret: 's3cret-value', refresh_token: 'rt-old-1' }, settings: { client_id: 'cid', token_url: 'https://id.example.test/token' } }

describe('requestToken', () => {
  it('client credentials: Basic client auth by default, scope in the form, token and expiry back', async () => {
    const d = recorder(answer(200, { access_token: 'at-1', expires_in: 3600, token_type: 'Bearer' }))
    const r = await requestToken(client, { type: 'client_credentials' }, { send: d.send })
    expect(r).toEqual({ ok: true, token: { accessToken: 'at-1', expiresInSeconds: 3600, tokenType: 'Bearer' } })
    expect(d.sent[0]!.headers['authorization']).toBe(`Basic ${Buffer.from('cid:s3cret-value').toString('base64')}`)
    expect(form(d.sent[0]!)).toEqual({ grant_type: 'client_credentials', scope: 'read write' })
  })

  it('client_secret_post puts the id and secret in the form instead', async () => {
    const d = recorder(answer(200, { access_token: 'at-1' }))
    await requestToken({ ...client, settings: { ...client.settings, client_auth: 'client_secret_post' } }, { type: 'client_credentials' }, { send: d.send })
    expect(d.sent[0]!.headers['authorization']).toBeUndefined()
    expect(form(d.sent[0]!)).toMatchObject({ client_id: 'cid', client_secret: 's3cret-value' })
  })

  it('authorization code with PKCE: code, redirect and verifier sent; the first refresh token handed back to seal', async () => {
    const pkce: CredentialMaterial = { kind: 'oauth_refresh', secrets: {}, settings: { client_id: 'public-app', token_url: 'https://id.example.test/token' } }
    const d = recorder(answer(200, { access_token: 'at-2', refresh_token: 'rt-first', id_token: 'idt', scope: 'openid' }))
    const r = await requestToken(pkce, { type: 'authorization_code', code: 'c0de', redirectUri: 'https://app.example.test/cb', codeVerifier: 'v'.repeat(43) }, { send: d.send })
    expect(r.ok && r.token).toEqual({ accessToken: 'at-2', refreshToken: 'rt-first', idToken: 'idt', scope: 'openid' })
    expect(form(d.sent[0]!)).toEqual({ grant_type: 'authorization_code', code: 'c0de', redirect_uri: 'https://app.example.test/cb', code_verifier: 'v'.repeat(43), client_id: 'public-app' })
  })

  it('a rotated refresh token is stored before the access token is returned, and a failed store withholds it', async () => {
    const stored: string[] = []
    const ok = await requestToken(refresh, { type: 'refresh_token' }, { send: recorder(answer(200, { access_token: 'at-3', refresh_token: 'rt-new-2' })).send, onRotate: async (p) => { stored.push(p['refresh_token']!) } })
    expect(ok.ok).toBe(true)
    expect(stored).toEqual(['rt-new-2'])
    const failed = await requestToken(refresh, { type: 'refresh_token' }, { send: recorder(answer(200, { access_token: 'at-3', refresh_token: 'rt-new-2' })).send, onRotate: async () => { throw new Error('disk full') } })
    expect(failed).toMatchObject({ ok: false, code: 'KEY_NOT_STORED' })
    const nowhere = await requestToken(refresh, { type: 'refresh_token' }, { send: recorder(answer(200, { access_token: 'at-3', refresh_token: 'rt-new-2' })).send })
    expect(nowhere).toMatchObject({ ok: false, code: 'KEY_NOT_STORED' })
  })

  it('invalid_grant on refresh means reconnect; other refusals carry the status, never the secret or the vendor text', async () => {
    const ended = await requestToken(refresh, { type: 'refresh_token' }, { send: recorder(answer(400, { error: 'invalid_grant', error_description: 'rt-old-1 revoked' })).send })
    expect(ended).toMatchObject({ ok: false, code: 'NEEDS_RECONNECT', status: 400 })
    const rejected = await requestToken(client, { type: 'client_credentials' }, { send: recorder(answer(401, { error: 'invalid_client', error_description: 's3cret-value is wrong' })).send })
    expect(rejected).toMatchObject({ ok: false, code: 'KEY_REJECTED', status: 401 })
    expect(JSON.stringify([ended, rejected])).not.toMatch(/s3cret|rt-old|revoked|wrong/)
  })

  it('refuses before sending: http token address, wrong kind for the grant, missing parts', async () => {
    const d = recorder(answer(200, { access_token: 'x' }))
    expect(await requestToken({ ...client, settings: { ...client.settings, token_url: 'http://id.example.test/token' } }, { type: 'client_credentials' }, { send: d.send })).toMatchObject({ code: 'BAD_CREDENTIAL_SETTING' })
    expect(await requestToken(client, { type: 'refresh_token' }, { send: d.send })).toMatchObject({ code: 'UNKNOWN_CREDENTIAL_KIND' })
    expect(await requestToken({ ...refresh, secrets: { client_secret: 'x' } }, { type: 'refresh_token' }, { send: d.send })).toMatchObject({ code: 'NO_KEY' })
    expect(await requestToken({ ...client, secrets: {} }, { type: 'client_credentials' }, { send: d.send })).toMatchObject({ code: 'NO_KEY' })
    expect(d.sent).toHaveLength(0)
  })

  it('an unreachable sign-in service is a refusal, not a throw', async () => {
    const r = await requestToken(client, { type: 'client_credentials' }, { send: async () => ({ ok: false, kind: 'unreachable', code: 'DNS', sentence: 'x' }) })
    expect(r).toMatchObject({ ok: false, code: 'KEY_SOURCE_UNAVAILABLE' })
  })
})
