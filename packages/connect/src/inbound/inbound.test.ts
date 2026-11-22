// F-L2c: verifier presets for inbound deliveries. Each preset with a known vector; a replayed delivery refused; a
// stale timestamp refused; both credential generations accepted during the rotation grace.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { VERIFIER_PRESETS, createMemoryReplayCache, handshakeAnswer, verifyDelivery, type VerifyInput } from './index.js'

const GH_SECRET = "It's a Secret to Everybody"
const GH_BODY = 'Hello, World!'
const GH_SIG = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
const now = () => new Date(1_700_000_100_000)
const v = (over: Partial<VerifyInput>): VerifyInput => ({ preset: 'hmac_sha256_header', settings: {}, secrets: [GH_SECRET], headers: {}, body: GH_BODY, now, replay: createMemoryReplayCache(), ...over })

describe('the presets', () => {
  it('are a closed list', () => {
    expect(VERIFIER_PRESETS).toEqual(['hmac_sha256_header', 'hmac_sha256_timestamped', 'basic_shared', 'standard_webhooks_v1'])
  })
  it('refuses a preset that is not on the list', async () => {
    expect(await verifyDelivery(v({ preset: 'jwt_magic' as never }))).toEqual({ ok: false, code: 'UNKNOWN_VERIFIER' })
  })
})

describe('hmac_sha256_header', () => {
  const s = { header: 'X-Hub-Signature-256', prefix: 'sha256=' }
  it('accepts GitHub’s published example', async () => {
    const r = await verifyDelivery(v({ settings: s, headers: { 'x-hub-signature-256': GH_SIG } }))
    expect(r.ok).toBe(true)
  })
  it('refuses a body changed by one character', async () => {
    expect(await verifyDelivery(v({ settings: s, headers: { 'x-hub-signature-256': GH_SIG }, body: 'Hello, World?' }))).toEqual({ ok: false, code: 'BAD_SIGNATURE' })
  })
  it('refuses a missing signature', async () => {
    expect(await verifyDelivery(v({ settings: s, headers: {} }))).toEqual({ ok: false, code: 'NO_SIGNATURE' })
  })
  it('accepts the previous generation during the grace (both secrets offered)', async () => {
    expect((await verifyDelivery(v({ settings: s, secrets: ['new-secret', GH_SECRET], headers: { 'x-hub-signature-256': GH_SIG } }))).ok).toBe(true)
  })
  it('refuses when no secret is configured', async () => {
    expect(await verifyDelivery(v({ settings: s, secrets: [], headers: { 'x-hub-signature-256': GH_SIG } }))).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
  })
  it('refuses the same delivery twice (replay)', async () => {
    const replay = createMemoryReplayCache()
    const once = await verifyDelivery(v({ settings: s, headers: { 'x-hub-signature-256': GH_SIG }, replay }))
    const twice = await verifyDelivery(v({ settings: s, headers: { 'x-hub-signature-256': GH_SIG }, replay }))
    expect([once.ok, twice]).toEqual([true, { ok: false, code: 'REPLAYED' }])
  })
  it('uses the vendor’s event id for the replay check when one is named, and returns it', async () => {
    const replay = createMemoryReplayCache()
    const r = await verifyDelivery(v({ settings: { ...s, event_id_header: 'X-GitHub-Delivery' }, headers: { 'x-hub-signature-256': GH_SIG, 'x-github-delivery': 'd-1' }, replay }))
    expect(r).toEqual({ ok: true, eventId: 'd-1' })
  })
  it('base64 encoding', async () => {
    const sig = createHmac('sha256', 'k').update('{"x":1}').digest('base64')
    expect((await verifyDelivery(v({ settings: { header: 'x-sig', encoding: 'base64' }, secrets: ['k'], body: '{"x":1}', headers: { 'x-sig': sig } }))).ok).toBe(true)
  })
})

describe('hmac_sha256_timestamped', () => {
  const ts = '1700000000'
  const sig = (secret: string, t = ts, body = '{"id":"evt_1"}') => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  it('separate timestamp header', async () => {
    const r = await verifyDelivery(v({ preset: 'hmac_sha256_timestamped', settings: { header: 'x-signature', timestamp_header: 'x-signature-timestamp' }, secrets: ['whsec'], body: '{"id":"evt_1"}', headers: { 'x-signature': sig('whsec'), 'x-signature-timestamp': ts } }))
    expect(r.ok).toBe(true)
  })
  it('one header with t= and v1= pairs, any of several v1 values', async () => {
    const r = await verifyDelivery(v({ preset: 'hmac_sha256_timestamped', settings: { header: 'x-sig', signature_format: 't_v1_pairs' }, secrets: ['whsec'], body: '{"id":"evt_1"}', headers: { 'x-sig': `t=${ts},v1=deadbeef,v1=${sig('whsec')}` } }))
    expect(r.ok).toBe(true)
  })
  it('refuses a timestamp outside the tolerance (default 300 s)', async () => {
    const old = '1699999000'
    const r = await verifyDelivery(v({ preset: 'hmac_sha256_timestamped', settings: { header: 'x-signature', timestamp_header: 'x-ts' }, secrets: ['whsec'], body: '{"id":"evt_1"}', headers: { 'x-signature': sig('whsec', old), 'x-ts': old } }))
    expect(r).toEqual({ ok: false, code: 'STALE' })
  })
  it('refuses a signature over a different timestamp', async () => {
    const r = await verifyDelivery(v({ preset: 'hmac_sha256_timestamped', settings: { header: 'x-signature', timestamp_header: 'x-ts' }, secrets: ['whsec'], body: '{"id":"evt_1"}', headers: { 'x-signature': sig('whsec', '1700000001'), 'x-ts': ts } }))
    expect(r).toEqual({ ok: false, code: 'BAD_SIGNATURE' })
  })
})

describe('basic_shared (weak, for vendors that offer nothing else)', () => {
  it('accepts the configured user and password, refuses anything else', async () => {
    const good = `Basic ${Buffer.from('hook:pw-1').toString('base64')}`
    const bad = `Basic ${Buffer.from('hook:pw-2').toString('base64')}`
    expect((await verifyDelivery(v({ preset: 'basic_shared', settings: { username: 'hook' }, secrets: ['pw-1'], headers: { authorization: good } }))).ok).toBe(true)
    expect(await verifyDelivery(v({ preset: 'basic_shared', settings: { username: 'hook' }, secrets: ['pw-1'], headers: { authorization: bad } }))).toEqual({ ok: false, code: 'BAD_SIGNATURE' })
  })
})

describe('validation handshake', () => {
  it('echoes a challenge from the query or from the body, and nothing else', () => {
    expect(handshakeAnswer({ challenge_param: 'validationToken' }, { query: { validationToken: 'abc' }, body: '' })).toEqual({ ok: true, contentType: 'text/plain', body: 'abc' })
    expect(handshakeAnswer({ challenge_path: 'challenge' }, { query: {}, body: '{"challenge":"xyz"}' })).toEqual({ ok: true, contentType: 'text/plain', body: 'xyz' })
    expect(handshakeAnswer({ challenge_param: 'validationToken' }, { query: {}, body: '' })).toEqual({ ok: false })
    expect(handshakeAnswer({ challenge_param: 'v' }, { query: { v: '<script>'.repeat(100) }, body: '' })).toEqual({ ok: false })
  })
})
