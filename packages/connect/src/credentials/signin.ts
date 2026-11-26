/**
 * Sign-in for an `oauth_refresh` credential: a person (or an administrator) signs in once in their browser, and the
 * platform keeps the refresh token. These helpers build every step as data and send through the caller's door:
 *
 *   1. {@link discoverAuthorizationServer}: from a service's address (an MCP server, an A2A agent, a REST API) find
 *      where to sign in (RFC 9728 protected-resource metadata, then RFC 8414 / OpenID discovery).
 *   2. {@link registerClient}: when the service requires it, register this platform as a client first (RFC 7591
 *      dynamic client registration; a public client with no secret, PKCE only).
 *   3. {@link createPkcePair} and {@link buildAuthorizationUrl}: where to send the person (RFC 7636 PKCE, S256).
 *   4. `requestToken(material, { type: 'authorization_code', code, redirectUri, codeVerifier })` exchanges the code.
 *
 * Nothing here stores anything. The host keeps the verifier and state with the person's pending sign-in, and seals
 * the client id and refresh token it gets back.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { ConnectRefusal, Send } from '../types.js'
import { refusal } from '../types.js'
import type { CredentialMaterial } from './apply.js'
import { settingOf } from './catalogue.js'

/** A PKCE pair (RFC 7636): keep the verifier with the pending sign-in; send the challenge. */
export interface PkcePair {
  readonly verifier: string
  readonly challenge: string
  readonly method: 'S256'
}

/** Make a fresh PKCE pair. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), method: 'S256' }
}

/** A fresh, unguessable `state` value for one sign-in. */
export function createSignInState(): string {
  return randomBytes(24).toString('base64url')
}

const https = (raw: string): URL | undefined => {
  try { const u = new URL(raw); return u.protocol === 'https:' && u.username === '' && u.password === '' ? u : undefined } catch { return undefined }
}

/**
 * Where to send a person to sign in.
 * @param material An `oauth_refresh` credential with `authorize_url` and `client_id` set.
 * @param request The address the sign-in comes back to, the state, and the PKCE challenge (unless `pkce` is `none`).
 */
export function buildAuthorizationUrl(material: CredentialMaterial, request: { readonly redirectUri: string; readonly state: string; readonly codeChallenge?: string | undefined; readonly extra?: Readonly<Record<string, string>> | undefined }): { readonly ok: true; readonly url: string } | ConnectRefusal {
  if (material.kind !== 'oauth_refresh') return refusal('UNKNOWN_CREDENTIAL_KIND', 'Only an OAuth sign-in credential has a sign-in address.')
  const s = (n: string): string => settingOf(material.kind, material.settings, n)
  const u = https(s('authorize_url'))
  if (u === undefined) return refusal('BAD_CREDENTIAL_SETTING', 'The credential’s sign-in address is not a secure (https) address.')
  if (s('client_id') === '') return refusal('BAD_CREDENTIAL_SETTING', 'The credential’s client id is not set.')
  if (https(request.redirectUri) === undefined && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(request.redirectUri)) return refusal('BAD_INPUT', 'The address to come back to must be a secure (https) address.')
  if (request.state === '') return refusal('BAD_INPUT', 'A sign-in needs a state value.')
  const pkce = s('pkce') !== 'none'
  if (pkce && (request.codeChallenge === undefined || request.codeChallenge === '')) return refusal('BAD_INPUT', 'This sign-in needs a proof key (PKCE) challenge.')
  const q = u.searchParams
  q.set('response_type', 'code')
  q.set('client_id', s('client_id'))
  q.set('redirect_uri', request.redirectUri)
  q.set('state', request.state)
  if (s('scope') !== '') q.set('scope', s('scope'))
  if (s('resource') !== '') q.set('resource', s('resource'))
  if (pkce) { q.set('code_challenge', request.codeChallenge ?? ''); q.set('code_challenge_method', 'S256') }
  for (const [k, v] of Object.entries(request.extra ?? {})) if (!q.has(k)) q.set(k, v)
  return { ok: true, url: u.toString() }
}

/** What a sign-in service says about itself. */
export interface AuthorizationServer {
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly registrationEndpoint?: string | undefined
  readonly scopesSupported?: readonly string[] | undefined
  readonly pkceS256: boolean
}

async function getJson(send: Send, url: string): Promise<Record<string, unknown> | undefined> {
  const r = await send({ method: 'GET', url, headers: { accept: 'application/json' } })
  if (!r.ok || r.status < 200 || r.status >= 300) return undefined
  try { const v = JSON.parse(r.body) as unknown; return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined } catch { return undefined }
}

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')

/**
 * Find where to sign in for a service.
 * @param resourceUrl The service's own address (an MCP endpoint, an API base).
 * @param context The way out.
 * @returns the sign-in service, and the resource the token should name; or why not.
 */
export async function discoverAuthorizationServer(resourceUrl: string, context: { readonly send: Send }): Promise<{ readonly ok: true; readonly server: AuthorizationServer; readonly resource: string } | ConnectRefusal> {
  const r = https(resourceUrl)
  if (r === undefined) return refusal('NOT_HTTPS', 'Only secure (https) addresses can be reached.')
  // RFC 9728: the protected resource names its sign-in services; path-specific first, then the host's.
  const path = r.pathname === '/' ? '' : r.pathname.replace(/\/+$/, '')
  const prm = (await getJson(context.send, `${r.origin}/.well-known/oauth-protected-resource${path}`)) ?? (await getJson(context.send, `${r.origin}/.well-known/oauth-protected-resource`))
  const servers = prm !== undefined && Array.isArray(prm['authorization_servers']) ? (prm['authorization_servers'] as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const resource = prm !== undefined && str(prm, 'resource') !== '' ? str(prm, 'resource') : `${r.origin}${path}`
  const issuer = https(servers[0] ?? r.origin)
  if (issuer === undefined) return refusal('NOT_HTTPS', 'The sign-in service is not at a secure (https) address.')
  const ipath = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/+$/, '')
  const meta = (await getJson(context.send, `${issuer.origin}/.well-known/oauth-authorization-server${ipath}`))
    ?? (await getJson(context.send, `${issuer.origin}${ipath}/.well-known/openid-configuration`))
  if (meta === undefined) return refusal('NOT_FOUND', 'The service does not say where to sign in.')
  const auth = https(str(meta, 'authorization_endpoint'))
  const token = https(str(meta, 'token_endpoint'))
  if (auth === undefined || token === undefined) return refusal('NOT_HTTPS', 'The sign-in service’s addresses are not secure (https).')
  const reg = https(str(meta, 'registration_endpoint'))
  const methods = Array.isArray(meta['code_challenge_methods_supported']) ? (meta['code_challenge_methods_supported'] as unknown[]) : []
  const scopes = Array.isArray(meta['scopes_supported']) ? (meta['scopes_supported'] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined
  return {
    ok: true,
    resource,
    server: {
      issuer: str(meta, 'issuer') || issuer.toString(),
      authorizationEndpoint: auth.toString(),
      tokenEndpoint: token.toString(),
      ...(reg === undefined ? {} : { registrationEndpoint: reg.toString() }),
      ...(scopes === undefined ? {} : { scopesSupported: scopes }),
      pkceS256: methods.includes('S256'),
    },
  }
}

/**
 * Register this platform as a public client of a sign-in service (RFC 7591). Used once per connection when the service
 * requires dynamic registration (Atlassian Rovo MCP and A2A, MCP servers in general).
 * @param registrationEndpoint From {@link discoverAuthorizationServer}.
 * @param client The name people see on the consent screen, the addresses sign-ins come back to, the scopes.
 */
export async function registerClient(registrationEndpoint: string, client: { readonly clientName: string; readonly redirectUris: readonly string[]; readonly scope?: string | undefined }, context: { readonly send: Send }): Promise<{ readonly ok: true; readonly clientId: string; readonly clientSecret?: string | undefined } | ConnectRefusal> {
  const u = https(registrationEndpoint)
  if (u === undefined) return refusal('NOT_HTTPS', 'The registration address is not a secure (https) address.')
  if (client.redirectUris.length === 0) return refusal('BAD_INPUT', 'At least one address to come back to is needed.')
  const body = {
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(client.scope === undefined || client.scope === '' ? {} : { scope: client.scope }),
  }
  const r = await context.send({ method: 'POST', url: u.toString(), headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) return refusal('KEY_SOURCE_UNAVAILABLE', 'The sign-in service could not be reached.')
  if (r.status < 200 || r.status >= 300) return refusal('KEY_REJECTED', 'The sign-in service did not accept the registration.')
  let out: Record<string, unknown> = {}
  try { out = JSON.parse(r.body) as Record<string, unknown> } catch { out = {} }
  const clientId = str(out, 'client_id')
  if (clientId === '') return refusal('KEY_REJECTED', 'The sign-in service answered without a client id.')
  const secret = str(out, 'client_secret')
  return { ok: true, clientId, ...(secret === '' ? {} : { clientSecret: secret }) }
}
