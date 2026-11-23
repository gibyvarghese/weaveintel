// SPDX-License-Identifier: MIT
// Sign-in and the two new credential kinds: JWT bearer (RFC 7523), mutual TLS, PKCE (RFC 7636), discovery (RFC 9728 and
// RFC 8414) and dynamic client registration (RFC 7591). All over a recorded door: nothing leaves the test.
import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Send, SendResult, WireRequest } from '../types.js'
import { applyCredential, buildAuthorizationUrl, createPkcePair, createTokenCache, discoverAuthorizationServer, registerClient, requestToken, type CredentialMaterial } from './index.js'

const req: WireRequest = { method: 'GET', url: 'https://acme.example.test/api/now/table/incident', headers: {} }
const json = (status: number, body: unknown): SendResult => ({ ok: true, status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const door = (route: (r: WireRequest) => SendResult): { send: Send; sent: WireRequest[] } => {
  const sent: WireRequest[] = []
  return { sent, send: async (r) => { sent.push(r); return route(r) } }
}

describe('jwt_bearer', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const material: CredentialMaterial = {
    kind: 'jwt_bearer',
    secrets: { private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), client_secret: 'cs' },
    settings: { client_id: 'cid', token_url: 'https://acme.example.test/oauth_token.do', subject: 'integration.user', key_id: 'k1' },
  }
  it('signs an assertion the service can check, and gets a token', async () => {
    const { send, sent } = door(() => json(200, { access_token: 'at-1', expires_in: 1800 }))
    const r = await requestToken(material, { type: 'jwt_bearer' }, { send, now: () => new Date('2026-11-24T00:00:00Z') })
    expect(r.ok).toBe(true)
    const form = new URLSearchParams(sent[0]?.body)
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(form.get('client_id')).toBe('cid')
    const [h, p, s] = (form.get('assertion') ?? '').split('.')
    expect(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s ?? '', 'base64url'))).toBe(true)
    const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as Record<string, unknown>
    expect(claims).toMatchObject({ iss: 'cid', sub: 'integration.user', aud: 'https://acme.example.test/oauth_token.do', iat: 1795478400, exp: 1795478700 })
    expect(JSON.parse(Buffer.from(h ?? '', 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'k1' })
  })
  it('puts the token on a request through the cache', async () => {
    const { send } = door(() => json(200, { access_token: 'at-2', expires_in: 1800 }))
    const r = await applyCredential(req, material, { send, cache: createTokenCache(), cacheKey: 'w:c:1' })
    expect(r.ok && r.request.headers['authorization']).toBe('Bearer at-2')
  })
  it('refuses a key it cannot sign with, without saying the key', async () => {
    const r = await requestToken({ ...material, secrets: { private_key: 'not a key' } }, { type: 'jwt_bearer' }, { send: door(() => json(200, {})).send })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.sentence).not.toContain('not a key')
  })
})

describe('mtls', () => {
  it('hands the certificate and key to the door, and never shows them', async () => {
    const r = await applyCredential(req, { kind: 'mtls', secrets: { client_key: 'KEY' }, settings: { client_cert: 'CERT' } }, { send: door(() => json(200, {})).send, cache: createTokenCache(), cacheKey: 'x' })
    expect(r.ok && r.request.tls).toEqual({ cert: 'CERT', key: 'KEY' })
  })
  it('needs the key', async () => {
    const r = await applyCredential(req, { kind: 'mtls', secrets: {}, settings: { client_cert: 'CERT' } }, { send: door(() => json(200, {})).send, cache: createTokenCache(), cacheKey: 'x' })
    expect(r.ok).toBe(false)
  })
})

describe('sign-in', () => {
  it('makes a PKCE pair whose challenge is the verifier’s hash', () => {
    const p = createPkcePair()
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'))
    expect(p.verifier.length).toBeGreaterThanOrEqual(43)
  })
  it('builds the sign-in address with PKCE and the resource', () => {
    const m: CredentialMaterial = { kind: 'oauth_refresh', secrets: {}, settings: { client_id: 'c1', token_url: 'https://auth.example.test/token', authorize_url: 'https://auth.example.test/authorize', scope: 'read write', resource: 'https://mcp.example.test/mcp' } }
    const r = buildAuthorizationUrl(m, { redirectUri: 'https://platform.example.test/connect/callback', state: 's1', codeChallenge: 'ch' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const q = new URL(r.url).searchParams
    expect(Object.fromEntries(q)).toEqual({ response_type: 'code', client_id: 'c1', redirect_uri: 'https://platform.example.test/connect/callback', state: 's1', scope: 'read write', resource: 'https://mcp.example.test/mcp', code_challenge: 'ch', code_challenge_method: 'S256' })
    expect(buildAuthorizationUrl(m, { redirectUri: 'https://platform.example.test/cb', state: 's1' }).ok).toBe(false)
  })
  it('sends the resource with the code exchange', async () => {
    const { send, sent } = door(() => json(200, { access_token: 'a', refresh_token: 'r' }))
    const m: CredentialMaterial = { kind: 'oauth_refresh', secrets: {}, settings: { client_id: 'c1', token_url: 'https://auth.example.test/token', resource: 'https://mcp.example.test/mcp' } }
    const r = await requestToken(m, { type: 'authorization_code', code: 'cd', redirectUri: 'https://platform.example.test/cb', codeVerifier: 'v' }, { send })
    expect(r.ok && r.token.refreshToken).toBe('r')
    expect(new URLSearchParams(sent[0]?.body).get('resource')).toBe('https://mcp.example.test/mcp')
  })
  it('discovers the sign-in service from the protected resource', async () => {
    const { send, sent } = door((r) => {
      if (r.url === 'https://mcp.example.test/.well-known/oauth-protected-resource/v2/mcp') return json(200, { resource: 'https://mcp.example.test/v2/mcp', authorization_servers: ['https://auth.example.test'] })
      if (r.url === 'https://auth.example.test/.well-known/oauth-authorization-server') return json(200, { issuer: 'https://auth.example.test', authorization_endpoint: 'https://auth.example.test/authorize', token_endpoint: 'https://auth.example.test/token', registration_endpoint: 'https://auth.example.test/register', code_challenge_methods_supported: ['S256'] })
      return json(404, {})
    })
    const r = await discoverAuthorizationServer('https://mcp.example.test/v2/mcp', { send })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.resource).toBe('https://mcp.example.test/v2/mcp')
    expect(r.server).toMatchObject({ tokenEndpoint: 'https://auth.example.test/token', registrationEndpoint: 'https://auth.example.test/register', pkceS256: true })
    expect(sent.every((s) => s.method === 'GET')).toBe(true)
  })
  it('refuses a sign-in service at an insecure address', async () => {
    const { send } = door((r) => (r.url.includes('protected-resource') ? json(200, { authorization_servers: ['http://auth.example.test'] }) : json(404, {})))
    expect((await discoverAuthorizationServer('https://mcp.example.test/mcp', { send })).ok).toBe(false)
  })
  it('registers as a public client', async () => {
    const { send, sent } = door(() => json(201, { client_id: 'dyn-1' }))
    const r = await registerClient('https://auth.example.test/register', { clientName: 'Platform', redirectUris: ['https://platform.example.test/cb'] }, { send })
    expect(r.ok && r.clientId).toBe('dyn-1')
    expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })
  })
})
