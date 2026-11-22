// F-L2a: credential kinds and their appliers. Golden requests per kind, the single-flight token cache, the rotating
// refresh token stored before use, a published HMAC test vector, and a canary secret that never escapes.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Send, SendResult, WireRequest } from '../types.js'
import { CREDENTIAL_KINDS, applyCredential, createTokenCache, redactRequest, signHmac, type CredentialMaterial } from './index.js'

const CANARY = 'canary-SECRET-7f3a9c'
const base: WireRequest = { method: 'POST', url: 'https://api.example.test/v1/items?x=1', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }
const noSend: Send = async () => { throw new Error('no network expected') }
const ctx = (over: Partial<Parameters<typeof applyCredential>[2]> = {}) => ({ send: noSend, cache: createTokenCache(), cacheKey: 'ws1|cred1|g1', ...over })
const json = (status: number, body: unknown): SendResult => ({ ok: true, status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const m = (kind: CredentialMaterial['kind'], secrets: Record<string, string>, settings: Record<string, string> = {}): CredentialMaterial => ({ kind, secrets, settings })

describe('the catalogue', () => {
  it('is closed and names each kind’s secret and setting parts', () => {
    expect(Object.keys(CREDENTIAL_KINDS).sort()).toEqual(['api_key', 'basic', 'bearer_token', 'hmac_signing', 'none', 'oauth_client', 'oauth_refresh'])
    expect(CREDENTIAL_KINDS.oauth_client.secretParts).toEqual(['client_secret'])
    expect(CREDENTIAL_KINDS.oauth_client.settingParts.map((p) => p.name)).toEqual(['client_id', 'token_url', 'scope', 'audience', 'client_auth'])
    expect(CREDENTIAL_KINDS.basic.settingParts.map((p) => p.name)).toEqual(['username'])
  })
  it('refuses a kind it does not know', async () => {
    const r = await applyCredential(base, { kind: 'telepathy' as never, secrets: {}, settings: {} }, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('UNKNOWN_CREDENTIAL_KIND')
  })
})

describe('static appliers (golden requests)', () => {
  it('none leaves the request untouched', async () => {
    const r = await applyCredential(base, m('none', {}), ctx())
    expect(r).toEqual({ ok: true, request: base })
  })
  it('api_key in a header with a prefix', async () => {
    const r = await applyCredential(base, m('api_key', { api_key: 'k1' }, { placement: 'header', name: 'Authorization', prefix: 'GenieKey ' }), ctx())
    expect(r.ok && r.request.headers['authorization']).toBe('GenieKey k1')
  })
  it('api_key in the query, added beside what is there', async () => {
    const r = await applyCredential(base, m('api_key', { api_key: 'k 2' }, { placement: 'query', name: 'authKey' }), ctx())
    expect(r.ok && r.request.url).toBe('https://api.example.test/v1/items?x=1&authKey=k+2')
  })
  it('api_key defaults to the x-api-key header', async () => {
    const r = await applyCredential(base, m('api_key', { api_key: 'k3' }), ctx())
    expect(r.ok && r.request.headers['x-api-key']).toBe('k3')
  })
  it('bearer_token with the default and a custom prefix', async () => {
    const a = await applyCredential(base, m('bearer_token', { token: 't1' }), ctx())
    const b = await applyCredential(base, m('bearer_token', { token: 't1' }, { prefix: 'token' }), ctx())
    expect(a.ok && a.request.headers['authorization']).toBe('Bearer t1')
    expect(b.ok && b.request.headers['authorization']).toBe('token t1')
  })
  it('basic from the username setting and the password secret', async () => {
    const r = await applyCredential(base, m('basic', { password: 'p@ss' }, { username: 'svc' }), ctx())
    expect(r.ok && r.request.headers['authorization']).toBe(`Basic ${Buffer.from('svc:p@ss').toString('base64')}`)
  })
  it('refuses a missing secret part with a sentence that names the part, never a value', async () => {
    const r = await applyCredential(base, m('basic', { password: '' }, { username: 'svc' }), ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.code).toBe('NO_KEY'); expect(r.sentence).toContain('password') }
  })
})

describe('hmac_signing (closed recipes)', () => {
  it('body_sha256_hex matches GitHub’s published example', () => {
    // docs.github.com, "Validating webhook deliveries": secret "It's a Secret to Everybody", payload "Hello, World!".
    expect(signHmac('body_sha256_hex', "It's a Secret to Everybody", { body: 'Hello, World!', timestamp: '' })).toBe('757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17')
  })
  it('timestamp_body_sha256_hex signs "<timestamp>.<body>"', () => {
    const want = createHmac('sha256', 's3').update('1700000000.{"a":1}').digest('hex')
    expect(signHmac('timestamp_body_sha256_hex', 's3', { body: '{"a":1}', timestamp: '1700000000' })).toBe(want)
  })
  it('puts the signature and the timestamp in the configured headers', async () => {
    const r = await applyCredential(base, m('hmac_signing', { secret: 's3' }, { canonical_profile: 'timestamp_body_sha256_hex', signature_header: 'X-Sig', timestamp_header: 'X-Sig-Time', prefix: 'v1=' }), ctx({ now: () => new Date(1_700_000_000_000) }))
    expect(r.ok && r.request.headers['x-sig-time']).toBe('1700000000')
    expect(r.ok && r.request.headers['x-sig']).toBe(`v1=${createHmac('sha256', 's3').update('1700000000.{"a":1}').digest('hex')}`)
  })
  it('refuses a recipe that is not on the list', async () => {
    const r = await applyCredential(base, m('hmac_signing', { secret: 's' }, { canonical_profile: 'whatever' }), ctx())
    expect(!r.ok && r.code).toBe('BAD_CREDENTIAL_SETTING')
  })
})

describe('oauth_client (client credentials)', () => {
  const settings = { client_id: 'cid', token_url: 'https://auth.example.test/oauth/token', scope: 'read write', audience: 'api.example.test' }
  it('fetches a token through the caller’s send, then attaches it', async () => {
    const seen: WireRequest[] = []
    const send: Send = async (r) => { seen.push(r); return json(200, { access_token: 'at-1', expires_in: 3600, token_type: 'Bearer' }) }
    const r = await applyCredential(base, m('oauth_client', { client_secret: 'cs' }, settings), ctx({ send }))
    expect(r.ok && r.request.headers['authorization']).toBe('Bearer at-1')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(settings.token_url)
    expect(seen[0]!.headers['authorization']).toBe(`Basic ${Buffer.from('cid:cs').toString('base64')}`)
    expect(new URLSearchParams(seen[0]!.body).get('grant_type')).toBe('client_credentials')
    expect(new URLSearchParams(seen[0]!.body).get('scope')).toBe('read write')
    expect(new URLSearchParams(seen[0]!.body).get('audience')).toBe('api.example.test')
  })
  it('client_secret_post puts the client in the body instead', async () => {
    const seen: WireRequest[] = []
    const send: Send = async (r) => { seen.push(r); return json(200, { access_token: 'at-2', expires_in: 60 }) }
    await applyCredential(base, m('oauth_client', { client_secret: 'cs' }, { ...settings, client_auth: 'client_secret_post' }), ctx({ send }))
    const body = new URLSearchParams(seen[0]!.body)
    expect(seen[0]!.headers['authorization']).toBeUndefined()
    expect([body.get('client_id'), body.get('client_secret')]).toEqual(['cid', 'cs'])
  })
  it('makes ONE token request for 50 concurrent callers, and reuses it until 80% of its life', async () => {
    let calls = 0
    let now = 0
    const send: Send = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return json(200, { access_token: `at-${String(calls)}`, expires_in: 100 }) }
    const c = ctx({ send, now: () => new Date(now) })
    const results = await Promise.all(Array.from({ length: 50 }, () => applyCredential(base, m('oauth_client', { client_secret: 'cs' }, settings), c)))
    expect(calls).toBe(1)
    expect(new Set(results.map((r) => r.ok && r.request.headers['authorization']))).toEqual(new Set(['Bearer at-1']))
    now = 79_000
    await applyCredential(base, m('oauth_client', { client_secret: 'cs' }, settings), c)
    expect(calls).toBe(1)
    now = 81_000
    const later = await applyCredential(base, m('oauth_client', { client_secret: 'cs' }, settings), c)
    expect(calls).toBe(2)
    expect(later.ok && later.request.headers['authorization']).toBe('Bearer at-2')
  })
  it('a refused token request is a refusal with no vendor text and no secret', async () => {
    const send: Send = async () => json(401, { error: 'invalid_client', error_description: `bad secret ${CANARY}` })
    const r = await applyCredential(base, m('oauth_client', { client_secret: CANARY }, settings), ctx({ send }))
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain(CANARY)
    expect(JSON.stringify(r)).not.toContain('invalid_client')
    if (!r.ok) expect(r.code).toBe('KEY_REJECTED')
  })
  it('refuses a token address that is not https', async () => {
    const r = await applyCredential(base, m('oauth_client', { client_secret: 'cs' }, { ...settings, token_url: 'http://auth.example.test/token' }), ctx())
    expect(!r.ok && r.code).toBe('BAD_CREDENTIAL_SETTING')
  })
})

describe('oauth_refresh', () => {
  const settings = { client_id: 'cid', token_url: 'https://auth.example.test/oauth/token' }
  it('stores a rotated refresh token BEFORE the access token is used', async () => {
    const order: string[] = []
    const send: Send = async (r) => { order.push(`token:${new URLSearchParams(r.body).get('refresh_token') ?? ''}`); return json(200, { access_token: 'at-9', refresh_token: 'rt-2', expires_in: 3600 }) }
    const r = await applyCredential(base, m('oauth_refresh', { client_secret: 'cs', refresh_token: 'rt-1' }, settings), ctx({ send, onRotate: async (parts) => { order.push(`stored:${parts['refresh_token'] ?? ''}`) } }))
    order.push('used')
    expect(r.ok && r.request.headers['authorization']).toBe('Bearer at-9')
    expect(order).toEqual(['token:rt-1', 'stored:rt-2', 'used'])
  })
  it('does not use the token when the rotated refresh token could not be stored', async () => {
    const send: Send = async () => json(200, { access_token: 'at-9', refresh_token: 'rt-2', expires_in: 3600 })
    const r = await applyCredential(base, m('oauth_refresh', { client_secret: 'cs', refresh_token: 'rt-1' }, settings), ctx({ send, onRotate: async () => { throw new Error('db down') } }))
    expect(!r.ok && r.code).toBe('KEY_NOT_STORED')
  })
  it('invalid_grant means the connection needs signing in again', async () => {
    const send: Send = async () => json(400, { error: 'invalid_grant' })
    const r = await applyCredential(base, m('oauth_refresh', { client_secret: 'cs', refresh_token: 'rt-1' }, settings), ctx({ send }))
    expect(!r.ok && r.code).toBe('NEEDS_RECONNECT')
  })
})

describe('redaction for previews and logs', () => {
  it('replaces every secret value wherever it appears', async () => {
    const r = await applyCredential(base, m('api_key', { api_key: CANARY }, { placement: 'query', name: 'k' }), ctx())
    if (!r.ok) throw new Error('expected ok')
    const shown = redactRequest(r.request, m('api_key', { api_key: CANARY }))
    expect(JSON.stringify(shown)).not.toContain(CANARY)
    expect(shown.url).toContain('k=%E2%80%A2%E2%80%A2%E2%80%A2')
  })
  it('hides an authorization header whatever is in it', () => {
    const shown = redactRequest({ ...base, headers: { authorization: 'Bearer abc', 'x-other': 'fine' } }, m('none', {}))
    expect(shown.headers['authorization']).toBe('•••')
    expect(shown.headers['x-other']).toBe('fine')
  })
})
