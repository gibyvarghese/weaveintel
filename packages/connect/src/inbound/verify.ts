/**
 * Verifier presets for inbound deliveries (FRAMEWORK 4.5): a closed list, each a tested function. A host route
 * reads the raw body, hands it here with the endpoint's settings and secrets, and stores the delivery only when the
 * answer is ok. Refusal codes are for the host's refusal log; the sender is told nothing more than "no".
 *
 * Not built yet (FRAMEWORK lists them): `jwt_jwks`, `oidc_token`. They need key fetching through the host's door.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ReplayCache } from './replay-cache.js'
import { standardWebhooksKey } from '../credentials/hmac.js'

/** The presets. */
export const VERIFIER_PRESETS = ['hmac_sha256_header', 'hmac_sha256_timestamped', 'basic_shared', 'standard_webhooks_v1'] as const
/** One preset. */
export type VerifierPreset = (typeof VERIFIER_PRESETS)[number]

/** Why a delivery was refused. */
export type VerifyRefusalCode = 'UNKNOWN_VERIFIER' | 'NOT_CONFIGURED' | 'NO_SIGNATURE' | 'BAD_SIGNATURE' | 'STALE' | 'REPLAYED'

/** One delivery to check. */
export interface VerifyInput {
  readonly preset: VerifierPreset
  /** Plain settings: `header`, `prefix`, `encoding` (hex, base64), `timestamp_header`, `signature_format` (separate, t_v1_pairs), `tolerance_seconds`, `event_id_header`, `username`. */
  readonly settings: Readonly<Record<string, string>>
  /** The secret's generations to try, newest first (the previous one only during its rotation grace). */
  readonly secrets: readonly string[]
  /** Request headers, names lower case. */
  readonly headers: Readonly<Record<string, string>>
  /** The body exactly as received. */
  readonly body: string
  readonly now: () => Date
  readonly replay: ReplayCache
}

/** The answer. */
export type VerifyResult = { readonly ok: true; readonly eventId?: string | undefined } | { readonly ok: false; readonly code: VerifyRefusalCode }

const no = (code: VerifyRefusalCode): VerifyResult => ({ ok: false, code })

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

const digest = (secret: string, text: string, encoding: string): string => createHmac('sha256', secret).update(text, 'utf8').digest(encoding === 'base64' ? 'base64' : 'hex')

/** Check one delivery. */
export async function verifyDelivery(input: VerifyInput): Promise<VerifyResult> {
  if (!(VERIFIER_PRESETS as readonly string[]).includes(input.preset)) return no('UNKNOWN_VERIFIER')
  const secrets = input.secrets.filter((s) => s !== '')
  if (secrets.length === 0) return no('NOT_CONFIGURED')
  const set = (name: string, fallback = ''): string => { const v = input.settings[name]; return v === undefined || v === '' ? fallback : v }
  const header = (name: string): string => input.headers[name.toLowerCase()] ?? ''
  const tolerance = Math.max(1, Number(set('tolerance_seconds', '300')) || 300)
  let replayKey = ''
  let eventFromPreset = ''

  switch (input.preset) {
    case 'hmac_sha256_header': {
      const got = header(set('header', 'x-signature'))
      if (got === '') return no('NO_SIGNATURE')
      const prefix = set('prefix')
      if (prefix !== '' && !got.startsWith(prefix)) return no('BAD_SIGNATURE')
      const sig = got.slice(prefix.length)
      if (!secrets.some((s) => same(digest(s, input.body, set('encoding', 'hex')), sig))) return no('BAD_SIGNATURE')
      replayKey = `sig:${sig}`
      break
    }
    case 'hmac_sha256_timestamped': {
      const raw = header(set('header', 'x-signature'))
      if (raw === '') return no('NO_SIGNATURE')
      let ts = ''
      let candidates: string[] = []
      if (set('signature_format', 'separate') === 't_v1_pairs') {
        for (const pair of raw.split(',')) {
          const [k, ...rest] = pair.trim().split('=')
          const val = rest.join('=')
          if (k === 't') ts = val
          if (k === 'v1') candidates.push(val)
        }
      } else {
        ts = header(set('timestamp_header', 'x-signature-timestamp'))
        const prefix = set('prefix')
        candidates = [raw.startsWith(prefix) ? raw.slice(prefix.length) : '']
      }
      if (ts === '' || candidates.length === 0) return no('NO_SIGNATURE')
      const at = Number(ts)
      if (!Number.isFinite(at)) return no('BAD_SIGNATURE')
      if (Math.abs(input.now().getTime() / 1000 - at) > tolerance) return no('STALE')
      const signed = `${ts}.${input.body}`
      const match = candidates.find((c) => secrets.some((s) => same(digest(s, signed, set('encoding', 'hex')), c)))
      if (match === undefined) return no('BAD_SIGNATURE')
      replayKey = `sig:${match}`
      break
    }
    case 'standard_webhooks_v1': {
      // `webhook-signature` holds one or more `v1,<base64>` separated by spaces (several while a secret is replaced).
      const id = header('webhook-id')
      const ts = header('webhook-timestamp')
      const candidates = header('webhook-signature').split(' ').filter((x) => x.startsWith('v1,')).map((x) => x.slice(3))
      if (id === '' || ts === '' || candidates.length === 0) return no('NO_SIGNATURE')
      const at = Number(ts)
      if (!Number.isFinite(at)) return no('BAD_SIGNATURE')
      if (Math.abs(input.now().getTime() / 1000 - at) > tolerance) return no('STALE')
      const signed = `${id}.${ts}.${input.body}`
      const match = candidates.find((c) => secrets.some((s) => same(createHmac('sha256', standardWebhooksKey(s)).update(signed, 'utf8').digest('base64'), c)))
      if (match === undefined) return no('BAD_SIGNATURE')
      replayKey = `event:${id.slice(0, 200)}`
      eventFromPreset = id.slice(0, 200)
      break
    }
    case 'basic_shared': {
      const auth = header('authorization')
      if (!auth.toLowerCase().startsWith('basic ')) return no('NO_SIGNATURE')
      let decoded = ''
      try { decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8') } catch { return no('BAD_SIGNATURE') }
      const want = (s: string): string => `${set('username')}:${s}`
      if (!secrets.some((s) => same(want(s), decoded))) return no('BAD_SIGNATURE')
      replayKey = ''
      break
    }
  }

  const eventHeader = set('event_id_header')
  const eventId = eventHeader === '' ? eventFromPreset : header(eventHeader).slice(0, 200)
  const key = eventId !== '' ? `event:${eventId}` : replayKey
  if (key !== '' && (await input.replay.seenBefore(key, tolerance * 1000 * 2))) return no('REPLAYED')
  return eventId === '' ? { ok: true } : { ok: true, eventId }
}

/**
 * The answer to a vendor's validation handshake (echo the challenge at subscription time). Only a short, plain
 * challenge is echoed, as text, so the endpoint cannot be used to reflect content.
 * @param settings `challenge_param` (a query parameter) or `challenge_path` (a field of a JSON body).
 */
export function handshakeAnswer(settings: Readonly<Record<string, string>>, request: { readonly query: Readonly<Record<string, string>>; readonly body: string }): { readonly ok: true; readonly contentType: 'text/plain'; readonly body: string } | { readonly ok: false } {
  let challenge = ''
  if ((settings['challenge_param'] ?? '') !== '') challenge = request.query[settings['challenge_param'] as string] ?? ''
  else if ((settings['challenge_path'] ?? '') !== '') {
    try {
      const v = (JSON.parse(request.body) as Record<string, unknown>)[settings['challenge_path'] as string]
      challenge = typeof v === 'string' ? v : ''
    } catch { challenge = '' }
  }
  if (challenge === '' || challenge.length > 512 || !/^[A-Za-z0-9._~:+/=-]+$/.test(challenge)) return { ok: false }
  return { ok: true, contentType: 'text/plain', body: challenge }
}
