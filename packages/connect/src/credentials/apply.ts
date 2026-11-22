/**
 * Appliers: put a credential onto one request. Static kinds attach a value; token kinds fetch (through the caller's
 * own `send`, so the token request passes the same outbound door) and attach; signing kinds sign the body.
 *
 * Nothing here ever puts a secret or a vendor's error text into a refusal: a refusal names the PART that is missing
 * or the step that failed, in plain words.
 */
import type { ConnectRefusal, Send, WireRequest } from '../types.js'
import { refusal } from '../types.js'
import { CREDENTIAL_KINDS, HMAC_PROFILES, isCredentialKind, settingOf, type CredentialKindKey, type HmacProfile } from './catalogue.js'
import { signHmac } from './hmac.js'
import type { TokenCache } from './token-cache.js'

/** A credential opened for one call: its kind, its secret parts and its setting parts. Held in memory only. */
export interface CredentialMaterial {
  readonly kind: CredentialKindKey
  readonly secrets: Readonly<Record<string, string>>
  readonly settings: Readonly<Record<string, string>>
}

/** What an applier may use besides the material. */
export interface ApplyContext {
  /** The one way out, for token requests. */
  readonly send: Send
  readonly cache: TokenCache
  /** Who this token is for, unique per workspace, credential, generation, subject and scope set. */
  readonly cacheKey: string
  readonly now?: (() => Date) | undefined
  /**
   * Called with new secret parts the issuer handed back (a rotated refresh token) BEFORE the access token is used.
   * If it throws, the token is not used (FRAMEWORK 2.2: "store the new refresh token before using the access token").
   */
  readonly onRotate?: ((parts: Readonly<Record<string, string>>) => Promise<void>) | undefined
}

/** The request with the credential on it, or why not. */
export type ApplyResult = { readonly ok: true; readonly request: WireRequest } | ConnectRefusal

const KIND_WORDS: Readonly<Record<CredentialKindKey, string>> = {
  none: 'no credential', api_key: 'the API key', bearer_token: 'the token', basic: 'the user name and password',
  oauth_client: 'the OAuth client', oauth_refresh: 'the OAuth sign-in', hmac_signing: 'the signing secret',
}

const withHeader = (r: WireRequest, name: string, value: string): WireRequest => ({ ...r, headers: { ...r.headers, [name.toLowerCase()]: value } })
const missing = (part: string): ConnectRefusal => refusal('NO_KEY', `The ${part.replace(/_/g, ' ')} has not been stored yet.`)
const badSetting = (part: string, why: string): ConnectRefusal => refusal('BAD_CREDENTIAL_SETTING', `The credential’s ${part.replace(/_/g, ' ')} ${why}`)

function needSecrets(m: CredentialMaterial): ConnectRefusal | undefined {
  for (const part of CREDENTIAL_KINDS[m.kind].secretParts as readonly string[]) {
    if (part === 'client_secret' && m.kind === 'oauth_refresh') continue // public clients (PKCE) have none
    if ((m.secrets[part] ?? '') === '') return missing(part)
  }
  for (const part of CREDENTIAL_KINDS[m.kind].settingParts as readonly { name: string; required?: boolean }[]) {
    if (part.required === true && settingOf(m.kind, m.settings, part.name) === '') return badSetting(part.name, 'is not set.')
  }
  return undefined
}

/**
 * Put a credential onto a request.
 * @param request The request as built (headers lower case).
 * @param material The opened credential.
 * @param context The way out for token requests, the cache, the clock.
 */
export async function applyCredential(request: WireRequest, material: CredentialMaterial, context: ApplyContext): Promise<ApplyResult> {
  if (!isCredentialKind(material.kind)) return refusal('UNKNOWN_CREDENTIAL_KIND', 'This kind of credential is not one the platform can use.')
  const lacking = needSecrets(material)
  if (lacking !== undefined) return lacking
  const s = (name: string): string => settingOf(material.kind, material.settings, name)
  const now = context.now ?? (() => new Date())
  switch (material.kind) {
    case 'none':
      return { ok: true, request }
    case 'api_key': {
      const key = material.secrets['api_key'] ?? ''
      const name = s('name')
      const value = `${s('prefix')}${key}`
      if (s('placement') === 'query') {
        const u = new URL(request.url)
        u.searchParams.append(name, value)
        return { ok: true, request: { ...request, url: u.toString() } }
      }
      if (s('placement') === 'cookie') {
        const prior = request.headers['cookie']
        return { ok: true, request: withHeader(request, 'cookie', `${prior === undefined || prior === '' ? '' : `${prior}; `}${name}=${encodeURIComponent(value)}`) }
      }
      return { ok: true, request: withHeader(request, name, value) }
    }
    case 'bearer_token':
      return { ok: true, request: withHeader(request, 'authorization', `${s('prefix')} ${material.secrets['token'] ?? ''}`.trimStart()) }
    case 'basic':
      return { ok: true, request: withHeader(request, 'authorization', `Basic ${Buffer.from(`${s('username')}:${material.secrets['password'] ?? ''}`, 'utf8').toString('base64')}`) }
    case 'hmac_signing': {
      const profile = s('canonical_profile')
      if (!(HMAC_PROFILES as readonly string[]).includes(profile)) return badSetting('canonical_profile', 'is not one of the signing recipes the platform knows.')
      const timestamp = String(Math.floor(now().getTime() / 1000))
      const sig = signHmac(profile as HmacProfile, material.secrets['secret'] ?? '', { body: request.body ?? '', timestamp })
      let out = withHeader(request, s('signature_header'), `${s('prefix')}${sig}`)
      if (profile === 'timestamp_body_sha256_hex') out = withHeader(out, s('timestamp_header'), timestamp)
      if (s('key_id') !== '' && s('key_id_header') !== '') out = withHeader(out, s('key_id_header'), s('key_id'))
      return { ok: true, request: out }
    }
    case 'oauth_client':
    case 'oauth_refresh': {
      const tokenUrl = s('token_url')
      let u: URL
      try { u = new URL(tokenUrl) } catch { return badSetting('token_url', 'is not a web address.') }
      if (u.protocol !== 'https:') return badSetting('token_url', 'must be a secure (https) address.')
      let failure: ConnectRefusal | undefined
      const token = await context.cache.get(context.cacheKey, async () => {
        const r = await fetchToken(material, s, context)
        if (!r.ok) { failure = r; throw new Error(r.code) }
        return r.token
      }, () => now().getTime()).catch(() => undefined)
      if (token === undefined) return failure ?? refusal('KEY_REJECTED', `${KIND_WORDS[material.kind]} was not accepted.`)
      return { ok: true, request: withHeader(request, 'authorization', `Bearer ${token}`) }
    }
  }
}

async function fetchToken(m: CredentialMaterial, s: (name: string) => string, context: ApplyContext): Promise<{ readonly ok: true; readonly token: { token: string; expiresInSeconds?: number } } | ConnectRefusal> {
  const form = new URLSearchParams()
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  if (m.kind === 'oauth_client') {
    form.set('grant_type', 'client_credentials')
    if (s('audience') !== '') form.set('audience', s('audience'))
  } else {
    form.set('grant_type', 'refresh_token')
    form.set('refresh_token', m.secrets['refresh_token'] ?? '')
  }
  if (s('scope') !== '') form.set('scope', s('scope'))
  const secret = m.secrets['client_secret'] ?? ''
  if (s('client_auth') === 'client_secret_post' || secret === '') {
    form.set('client_id', s('client_id'))
    if (secret !== '') form.set('client_secret', secret)
  } else {
    headers['authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(s('client_id'))}:${encodeURIComponent(secret)}`, 'utf8').toString('base64')}`
  }
  const r = await context.send({ method: 'POST', url: s('token_url'), headers, body: form.toString() })
  if (!r.ok) return refusal('KEY_SOURCE_UNAVAILABLE', 'The sign-in service could not be reached, so nothing was sent.')
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(r.body) as Record<string, unknown> } catch { body = {} }
  if (r.status < 200 || r.status >= 300) {
    if (m.kind === 'oauth_refresh' && body['error'] === 'invalid_grant') return refusal('NEEDS_RECONNECT', 'The sign-in has ended. An administrator needs to sign in again.')
    return refusal('KEY_REJECTED', `${KIND_WORDS[m.kind]} was not accepted by the sign-in service.`)
  }
  const token = typeof body['access_token'] === 'string' ? body['access_token'] : ''
  if (token === '') return refusal('KEY_REJECTED', 'The sign-in service answered without a token.')
  const rotated = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : ''
  if (m.kind === 'oauth_refresh' && rotated !== '' && rotated !== m.secrets['refresh_token']) {
    if (context.onRotate === undefined) return refusal('KEY_NOT_STORED', 'The sign-in service issued a new refresh token and there is nowhere to keep it, so it was not used.')
    try { await context.onRotate({ refresh_token: rotated }) } catch { return refusal('KEY_NOT_STORED', 'The new sign-in could not be stored, so it was not used.') }
  }
  const expires = typeof body['expires_in'] === 'number' ? body['expires_in'] : Number(body['expires_in'])
  return { ok: true, token: { token, ...(Number.isFinite(expires) ? { expiresInSeconds: expires } : {}) } }
}

const HIDDEN = '•••'
const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-api-key'])

/**
 * The request as it may be shown (a preview, a log): every secret value replaced wherever it appears (URL, header,
 * body, also URL-encoded), and authorization-like headers hidden whatever they hold.
 */
export function redactRequest(request: WireRequest, material: CredentialMaterial): WireRequest {
  const values = Object.values(material.secrets).filter((v) => v.length >= 4)
  const forms = (v: string): readonly string[] => [...new Set([new URLSearchParams({ v }).toString().slice(2), encodeURIComponent(v), v])]
  const scrubWith = (text: string, hidden: string): string => values.reduce((t, v) => forms(v).reduce((u, f) => u.split(f).join(hidden), t), text)
  const scrub = (text: string): string => scrubWith(text, HIDDEN)
  const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, SENSITIVE_HEADERS.has(k.toLowerCase()) ? HIDDEN : scrub(v)]))
  return { method: request.method, url: scrubWith(request.url, encodeURIComponent(HIDDEN)), headers, ...(request.body === undefined ? {} : { body: scrub(request.body) }) }
}
