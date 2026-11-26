/**
 * The one OAuth 2.0 token request (RFC 6749 section 4): client credentials, refresh token, and the authorization-code
 * exchange (with the PKCE verifier, RFC 7636, when the sign-in used one).
 *
 * WHY ONE
 * Before this, three copies of this request existed (weaveIntel `tools-enterprise` `AuthManager`, this package's
 * applier, and a host mail plane). Each had its own idea of client authentication, error handling and refresh-token
 * rotation. Every caller now builds the request here and sends it through its OWN door (`send`), so the address rules
 * and the outbound log still apply to the sign-in service.
 *
 * WHAT IT NEVER DOES
 * It never puts a secret or the sign-in service's own error text into a refusal sentence. A rotated refresh token is
 * handed to `onRotate` BEFORE the new access token is returned (FRAMEWORK 2.2: store it before using the access
 * token); when that fails, nothing is returned.
 *
 * Not sign-in for the platform itself: `@weaveintel/identity` (oauth) signs people INTO the platform and is a
 * different job.
 */
import { createPrivateKey, randomUUID, sign as signWith } from 'node:crypto'
import type { ConnectRefusal, Send } from '../types.js'
import { refusal } from '../types.js'
import { settingOf, type CredentialKindKey } from './catalogue.js'
import type { CredentialMaterial } from './apply.js'

/** Which grant to ask for. */
export type TokenGrant =
  | { readonly type: 'client_credentials' }
  /** RFC 7523: a JWT signed with the credential's private key is the grant. */
  | { readonly type: 'jwt_bearer' }
  | { readonly type: 'refresh_token' }
  | {
      readonly type: 'authorization_code'
      readonly code: string
      readonly redirectUri: string
      /** The PKCE code verifier, when the authorization request carried a challenge. */
      readonly codeVerifier?: string | undefined
    }

/** What the sign-in service issued. */
export interface IssuedToken {
  readonly accessToken: string
  readonly expiresInSeconds?: number | undefined
  /** A refresh token the service issued (a first one from a code exchange, or a rotated one). The caller seals it. */
  readonly refreshToken?: string | undefined
  readonly tokenType?: string | undefined
  readonly idToken?: string | undefined
  readonly scope?: string | undefined
}

/** What a token request may use. */
export interface TokenRequestContext {
  /** The one way out. */
  readonly send: Send
  /**
   * Called with a rotated refresh token (refresh grant only) BEFORE the access token is returned. If it throws, or is
   * absent, the token is not used.
   */
  readonly onRotate?: ((parts: Readonly<Record<string, string>>) => Promise<void>) | undefined
  /** The clock (JWT assertions carry their issue time). */
  readonly now?: (() => Date) | undefined
}

/** The token, or why not. `status` is the sign-in service's answer code when it answered. */
export type TokenResult = { readonly ok: true; readonly token: IssuedToken } | (ConnectRefusal & { readonly status?: number | undefined })

const KIND_FOR_GRANT: Readonly<Record<TokenGrant['type'], CredentialKindKey>> = {
  client_credentials: 'oauth_client', refresh_token: 'oauth_refresh', authorization_code: 'oauth_refresh', jwt_bearer: 'jwt_bearer',
}

const b64url = (b: Buffer): string => b.toString('base64url')

/**
 * A short-lived JWT assertion (RFC 7523 section 3): issuer and subject, the audience, a five-minute life, a unique id.
 * @returns the assertion, or undefined when the key cannot be read for the algorithm.
 */
export function signJwtAssertion(privateKeyPem: string, claims: { readonly iss: string; readonly sub: string; readonly aud: string }, options: { readonly algorithm: 'RS256' | 'ES256'; readonly keyId?: string | undefined; readonly now: Date }): string | undefined {
  let key
  try { key = createPrivateKey(privateKeyPem) } catch { return undefined }
  const iat = Math.floor(options.now.getTime() / 1000)
  const header = { alg: options.algorithm, typ: 'JWT', ...(options.keyId === undefined || options.keyId === '' ? {} : { kid: options.keyId }) }
  const payload = { ...claims, iat, exp: iat + 300, jti: randomUUID() }
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`
  try {
    const sig = options.algorithm === 'RS256'
      ? signWith('sha256', Buffer.from(input), key)
      : signWith('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
    return `${input}.${b64url(sig)}`
  } catch { return undefined }
}

const bad = (part: string, why: string): ConnectRefusal => refusal('BAD_CREDENTIAL_SETTING', `The credential’s ${part.replace(/_/g, ' ')} ${why}`)

/**
 * Ask the credential's sign-in service for a token.
 * @param material The opened credential: `oauth_client` for client credentials, `oauth_refresh` for the refresh and
 *   authorization-code grants.
 * @param grant The grant.
 * @param context The way out and where a rotated refresh token goes.
 */
export async function requestToken(material: CredentialMaterial, grant: TokenGrant, context: TokenRequestContext): Promise<TokenResult> {
  if (material.kind !== KIND_FOR_GRANT[grant.type]) return refusal('UNKNOWN_CREDENTIAL_KIND', 'This kind of credential cannot ask for that kind of sign-in.')
  const s = (name: string): string => settingOf(material.kind, material.settings, name)
  let u: URL
  try { u = new URL(s('token_url')) } catch { return bad('token_url', 'is not a web address.') }
  if (u.protocol !== 'https:') return bad('token_url', 'must be a secure (https) address.')
  if (s('client_id') === '') return bad('client_id', 'is not set.')
  const secret = material.secrets['client_secret'] ?? ''
  if (material.kind === 'oauth_client' && secret === '') return refusal('NO_KEY', 'The client secret has not been stored yet.')

  const form = new URLSearchParams()
  form.set('grant_type', grant.type === 'jwt_bearer' ? 'urn:ietf:params:oauth:grant-type:jwt-bearer' : grant.type)
  if (s('resource') !== '' && material.kind === 'oauth_refresh') form.set('resource', s('resource'))
  if (grant.type === 'jwt_bearer') {
    const now = context.now ?? (() => new Date())
    const alg = s('algorithm') === 'ES256' ? 'ES256' : 'RS256'
    const assertion = signJwtAssertion(material.secrets['private_key'] ?? '', { iss: s('issuer') || s('client_id'), sub: s('subject') || s('client_id'), aud: s('audience') || u.toString() }, { algorithm: alg, keyId: s('key_id'), now: now() })
    if (assertion === undefined) return bad('private_key', `can’t sign with ${alg}.`)
    form.set('assertion', assertion)
  } else if (grant.type === 'client_credentials') {
    if (s('audience') !== '') form.set('audience', s('audience'))
  } else if (grant.type === 'refresh_token') {
    const refresh = material.secrets['refresh_token'] ?? ''
    if (refresh === '') return refusal('NO_KEY', 'The refresh token has not been stored yet.')
    form.set('refresh_token', refresh)
  } else {
    if (grant.code === '') return refusal('NO_KEY', 'No sign-in code was given.')
    form.set('code', grant.code)
    form.set('redirect_uri', grant.redirectUri)
    if (grant.codeVerifier !== undefined && grant.codeVerifier !== '') form.set('code_verifier', grant.codeVerifier)
  }
  if (grant.type !== 'authorization_code' && s('scope') !== '') form.set('scope', s('scope'))

  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  // A public (PKCE) client has no secret and sends only its id; `client_secret_post` sends both in the form;
  // the default sends both in a Basic header (RFC 6749 2.3.1, each part form-encoded first).
  if (s('client_auth') === 'client_secret_post' || secret === '') {
    form.set('client_id', s('client_id'))
    if (secret !== '') form.set('client_secret', secret)
  } else {
    headers['authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(s('client_id'))}:${encodeURIComponent(secret)}`, 'utf8').toString('base64')}`
  }

  const r = await context.send({ method: 'POST', url: u.toString(), headers, body: form.toString() })
  if (!r.ok) return refusal('KEY_SOURCE_UNAVAILABLE', 'The sign-in service could not be reached, so nothing was sent.')
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(r.body) as Record<string, unknown> } catch { body = {} }
  if (r.status < 200 || r.status >= 300) {
    if (grant.type === 'refresh_token' && body['error'] === 'invalid_grant') return { ...refusal('NEEDS_RECONNECT', 'The sign-in has ended. An administrator needs to sign in again.'), status: r.status }
    return { ...refusal('KEY_REJECTED', 'The credential was not accepted by the sign-in service.'), status: r.status }
  }
  const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : ''
  if (accessToken === '') return { ...refusal('KEY_REJECTED', 'The sign-in service answered without a token.'), status: r.status }
  const issuedRefresh = typeof body['refresh_token'] === 'string' && body['refresh_token'] !== '' ? body['refresh_token'] : undefined
  if (grant.type === 'refresh_token' && issuedRefresh !== undefined && issuedRefresh !== material.secrets['refresh_token']) {
    if (context.onRotate === undefined) return refusal('KEY_NOT_STORED', 'The sign-in service issued a new refresh token and there is nowhere to keep it, so it was not used.')
    try { await context.onRotate({ refresh_token: issuedRefresh }) } catch { return refusal('KEY_NOT_STORED', 'The new sign-in could not be stored, so it was not used.') }
  }
  const expires = typeof body['expires_in'] === 'number' ? body['expires_in'] : Number(body['expires_in'])
  const text = (k: string): string | undefined => (typeof body[k] === 'string' && body[k] !== '' ? (body[k] as string) : undefined)
  return {
    ok: true,
    token: {
      accessToken,
      ...(Number.isFinite(expires) && expires > 0 ? { expiresInSeconds: expires } : {}),
      ...(issuedRefresh === undefined ? {} : { refreshToken: issuedRefresh }),
      ...(text('token_type') === undefined ? {} : { tokenType: text('token_type') }),
      ...(text('id_token') === undefined ? {} : { idToken: text('id_token') }),
      ...(text('scope') === undefined ? {} : { scope: text('scope') }),
    },
  }
}
