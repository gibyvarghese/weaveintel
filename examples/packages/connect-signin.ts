/**
 * Example: Signing a connection in (@weaveintel/connect/credentials)
 *
 * ─── What this shows ────────────────────────────────────────────────────────
 * The credential kinds a connection can hold, and the sign-in steps a platform runs to fill one, all over YOUR door
 * (`send`), so nothing here needs a network. Three situations an enterprise connector meets:
 *
 *   1. A modern MCP or API server you know only by its address: DISCOVER its sign-in service (RFC 9728 protected
 *      resource metadata, then RFC 8414), REGISTER as a client on the fly (RFC 7591), then send the person to sign in
 *      with PKCE (RFC 7636) and exchange the code, with the `resource` the token is for (RFC 8707).
 *   2. A server-to-server integration user that signs its own token request with a private key (`jwt_bearer`,
 *      RFC 7523), as ServiceNow, Salesforce and Google service accounts do.
 *   3. A service that wants a client certificate (`mtls`): the runner hands the certificate and key to the door,
 *      which opens the TLS connection; `redactRequest` keeps them out of logs.
 *
 * ─── When to reach for it ───────────────────────────────────────────────────
 * When your platform stores connections: keep secrets in `secrets`, everything else in `settings`, let
 * `applyCredential` put the credential onto each request, and keep the token cache per connection.
 *
 * Run: npx tsx examples/packages/connect-signin.ts
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync, verify } from 'node:crypto'
import type { Send, SendResult, WireRequest } from '@weaveintel/connect'
import {
  applyCredential, buildAuthorizationUrl, CREDENTIAL_KINDS, createPkcePair, createSignInState, createTokenCache,
  discoverAuthorizationServer, registerClient, requestToken, type CredentialMaterial,
} from '@weaveintel/connect/credentials'

const json = (status: number, body: unknown): SendResult => ({ ok: true, status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

// A pretend outside world, answering by address. A real host's door is its hardened fetch.
const sent: WireRequest[] = []
const send: Send = async (r) => {
  sent.push(r)
  switch (r.url) {
    case 'https://mcp.example.test/.well-known/oauth-protected-resource/v2/mcp':
      return json(200, { resource: 'https://mcp.example.test/v2/mcp', authorization_servers: ['https://auth.example.test'] })
    case 'https://auth.example.test/.well-known/oauth-authorization-server':
      return json(200, { issuer: 'https://auth.example.test', authorization_endpoint: 'https://auth.example.test/authorize', token_endpoint: 'https://auth.example.test/token', registration_endpoint: 'https://auth.example.test/register', code_challenge_methods_supported: ['S256'] })
    case 'https://auth.example.test/register':
      return json(201, { client_id: 'dyn-client-1' })
    case 'https://auth.example.test/token':
      return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600 })
    case 'https://acme.example.test/oauth_token.do':
      return json(200, { access_token: 'access-jwt', expires_in: 1800 })
    default:
      return json(404, {})
  }
}

async function main(): Promise<void> {
  // The kinds a connection can hold, with what each needs. A form can be drawn from this list.
  const kinds = Object.keys(CREDENTIAL_KINDS)
  for (const k of ['oauth_refresh', 'jwt_bearer', 'mtls']) assert.ok(kinds.includes(k), k)

  // 1. Discover, register, sign in with PKCE, exchange the code.
  const found = await discoverAuthorizationServer('https://mcp.example.test/v2/mcp', { send })
  assert.ok(found.ok)
  assert.equal(found.server.pkceS256, true)
  const registered = await registerClient(found.server.registrationEndpoint ?? '', { clientName: 'My platform', redirectUris: ['https://platform.example.test/connect/callback'] }, { send })
  assert.ok(registered.ok)

  const connection: CredentialMaterial = {
    kind: 'oauth_refresh',
    secrets: {},
    settings: { client_id: registered.clientId, token_url: found.server.tokenEndpoint, authorize_url: found.server.authorizationEndpoint ?? '', resource: found.resource, scope: 'read' },
  }
  const pkce = createPkcePair()
  const state = createSignInState() // keep it with the pending sign-in; check it when the person comes back
  const signIn = buildAuthorizationUrl(connection, { redirectUri: 'https://platform.example.test/connect/callback', state, codeChallenge: pkce.challenge })
  assert.ok(signIn.ok)
  assert.equal(new URL(signIn.url).searchParams.get('code_challenge_method'), 'S256')
  console.log('1. send the person to:', signIn.url.split('?')[0])

  // …the person signs in and comes back with ?code=…&state=… — the platform exchanges the code:
  const token = await requestToken(connection, { type: 'authorization_code', code: 'code-from-callback', redirectUri: 'https://platform.example.test/connect/callback', codeVerifier: pkce.verifier }, { send })
  assert.ok(token.ok)
  assert.equal(token.token.refreshToken, 'refresh-1') // store it in the connection's secrets
  assert.equal(new URLSearchParams(sent.at(-1)?.body).get('resource'), 'https://mcp.example.test/v2/mcp')
  console.log('   code exchanged; the refresh token goes into the connection’s secrets')

  // 2. JWT bearer: the integration user signs its own token request.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const integration: CredentialMaterial = {
    kind: 'jwt_bearer',
    secrets: { private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    settings: { client_id: 'acme-client', token_url: 'https://acme.example.test/oauth_token.do', subject: 'integration.user', key_id: 'key-2026' },
  }
  const cache = createTokenCache()
  const signed = await applyCredential({ method: 'GET', url: 'https://acme.example.test/api/now/table/incident', headers: {} }, integration, { send, cache, cacheKey: 'tenant-1:servicenow:1' })
  assert.ok(signed.ok)
  assert.equal(signed.request.headers['authorization'], 'Bearer access-jwt')
  const assertion = new URLSearchParams(sent.at(-1)?.body).get('assertion') ?? ''
  const [h, p, s] = assertion.split('.')
  assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s ?? '', 'base64url')), 'the service can check the signature')
  console.log('2. JWT bearer: signed assertion accepted; token cached for the connection')

  // 3. Mutual TLS: the door gets the certificate and key; nothing else changes.
  const tls = await applyCredential({ method: 'GET', url: 'https://bank.example.test/accounts', headers: {} }, { kind: 'mtls', secrets: { client_key: '-----BEGIN PRIVATE KEY-----…' }, settings: { client_cert: '-----BEGIN CERTIFICATE-----…' } }, { send, cache, cacheKey: 'tenant-1:bank:1' })
  assert.ok(tls.ok)
  assert.equal(tls.request.tls?.cert, '-----BEGIN CERTIFICATE-----…')
  console.log('3. mTLS: the request carries its client certificate for the door')
}

main().catch((e: unknown) => { console.error(e); process.exit(1) })
