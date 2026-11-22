// Standard Webhooks v1, both ways, against the specification's published example (secret, message id, timestamp,
// body and signature from the Standard Webhooks reference; recomputed here, never fetched).
import { describe, expect, it } from 'vitest'
import { applyCredential, createTokenCache, signHmac } from './credentials/index.js'
import { createMemoryReplayCache, verifyDelivery } from './inbound/index.js'

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
const ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
const TS = '1614265330'
const BODY = '{"test": 2432232314}'
const SIG = 'g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
const at = new Date(Number(TS) * 1000)

describe('Standard Webhooks v1', () => {
  it('signs the published example exactly', () => {
    expect(signHmac('standard_webhooks_v1', SECRET, { body: BODY, timestamp: TS, id: ID })).toBe(SIG)
  })
  it('puts the id, timestamp and v1 signature on a request that carries its message id', async () => {
    const r = await applyCredential({ method: 'POST', url: 'https://hooks.example.test/in', headers: { 'webhook-id': ID }, body: BODY },
      { kind: 'hmac_signing', secrets: { secret: SECRET }, settings: { canonical_profile: 'standard_webhooks_v1' } },
      { send: async () => { throw new Error('no network') }, cache: createTokenCache(), cacheKey: 'k', now: () => at })
    expect(r.ok && r.request.headers).toMatchObject({ 'webhook-id': ID, 'webhook-timestamp': TS, 'webhook-signature': `v1,${SIG}` })
  })
  it('refuses to sign a request with no message id (the id is part of what is signed)', async () => {
    const r = await applyCredential({ method: 'POST', url: 'https://hooks.example.test/in', headers: {}, body: BODY },
      { kind: 'hmac_signing', secrets: { secret: SECRET }, settings: { canonical_profile: 'standard_webhooks_v1' } },
      { send: async () => { throw new Error('no network') }, cache: createTokenCache(), cacheKey: 'k', now: () => at })
    expect(r).toMatchObject({ ok: false, code: 'BAD_CREDENTIAL_SETTING' })
  })
  it('verifies the example, accepts any of several signatures (rotation), and refuses stale, forged and repeated deliveries', async () => {
    const replay = createMemoryReplayCache()
    const headers = { 'webhook-id': ID, 'webhook-timestamp': TS, 'webhook-signature': `v1,bogus v1,${SIG}` }
    const base = { preset: 'standard_webhooks_v1' as const, settings: {}, secrets: [SECRET], headers, body: BODY, now: () => at, replay }
    expect(await verifyDelivery(base)).toEqual({ ok: true, eventId: ID })
    expect(await verifyDelivery(base)).toEqual({ ok: false, code: 'REPLAYED' })
    expect(await verifyDelivery({ ...base, replay: createMemoryReplayCache(), body: '{"test": 1}' })).toEqual({ ok: false, code: 'BAD_SIGNATURE' })
    expect(await verifyDelivery({ ...base, replay: createMemoryReplayCache(), now: () => new Date(at.getTime() + 3600_000) })).toEqual({ ok: false, code: 'STALE' })
    expect(await verifyDelivery({ ...base, replay: createMemoryReplayCache(), headers: { 'webhook-id': ID, 'webhook-timestamp': TS } })).toEqual({ ok: false, code: 'NO_SIGNATURE' })
    expect(await verifyDelivery({ ...base, replay: createMemoryReplayCache(), secrets: ['whsec_b3RoZXI=', SECRET] })).toEqual({ ok: true, eventId: ID })
  })
})
