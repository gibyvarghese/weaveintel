// F-L4 (part 2): recording a sandbox exchange set and replaying it. The recorder sits in front of a live Send only when
// CONNECT_RECORD=1; it keeps an allowlist of headers (never authorisation or cookies), scrubs tokens, emails and
// account numbers, and refuses to write while anything still looks like a secret. A recording replayed through the
// runner, with the same fixed run reference and clock, gives the same result. No test here reaches a network: the
// "live" side is a function standing in for a sandbox.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runOperation, type RunInput } from '../runner/index.js'
import type { Send, WireRequest } from '../types.js'
import { REPLAY_RUN_REF, createRecordingSend, createReplaySend, findSecrets, recordingEnabled, replayIdempotencyKey, type Recording } from './index.js'

const dir = mkdtempSync(join(tmpdir(), 'connect-record-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ON = { CONNECT_RECORD: '1' } as const
const clock = (): Date => new Date('2026-11-23T00:00:00.000Z')

/** A sandbox stand-in that answers with a planted token, email and account number, and sets a cookie. */
function sandbox(): { readonly send: Send; readonly seen: WireRequest[] } {
  const seen: WireRequest[] = []
  const send: Send = async (r) => {
    seen.push(r)
    if (r.method === 'POST') return { ok: true, status: 201, headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abcdef0123456789', 'x-vendor-trace': 'zzz' }, body: '{"id":"it_1","owner":"ana.smith@acme.co.nz","account":"0123456789012","token":"Bearer abcDEF1234567890xyz"}' }
    const page = new URL(r.url).searchParams.get('cursor')
    return page === null
      ? { ok: true, status: 200, headers: { 'content-type': 'application/json', link: '<next>' }, body: '{"items":[{"id":1,"email":"bo.lee@acme.co.nz"},{"id":2}],"next":"c2"}' }
      : { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[{"id":3}],"next":null}' }
  }
  return { send, seen }
}

const list = (send: Send): RunInput => ({
  spec: { key: 'list', method: 'GET', baseUrl: 'https://sandbox.example.test/api', pathTemplate: '/items', bodyFormat: 'none', idempotency: 'inherently_idempotent', itemsPath: 'items', paging: { style: 'cursor', cursorParam: 'cursor', cursorPath: 'next', pageSizeParam: 'limit', pageSize: 2 } },
  request: [], response: [{ itemOf: 'items', source: 'id', target: 'id' }], outputs: [{ name: 'items' }], input: {}, settings: {},
  credential: async (q) => ({ ok: true, request: { ...q, headers: { ...q.headers, authorization: 'Bearer live-sandbox-key-0123456789abcdef' } } }), send, label: 'List items',
})
const create = (send: Send): RunInput => ({
  spec: { key: 'create', method: 'POST', baseUrl: 'https://sandbox.example.test/api', pathTemplate: '/items', bodyFormat: 'json', idempotency: 'vendor_header', idempotencyHeader: 'Idempotency-Key' },
  request: [{ from: 'input', source: 'name', target: 'body:name' }], response: [{ source: 'id', target: 'id' }], outputs: [{ name: 'id' }], input: { name: 'x' }, settings: {},
  credential: async (q) => ({ ok: true, request: { ...q, headers: { ...q.headers, cookie: 'session=abcdef0123456789' } } }), send, label: 'Create item',
  idempotencyKey: replayIdempotencyKey('create'),
})

describe('recording a sandbox exchange set (CONNECT_RECORD=1)', () => {
  it('is off unless CONNECT_RECORD=1: building a recorder without it is refused', () => {
    expect(recordingEnabled({})).toBe(false)
    expect(recordingEnabled(ON)).toBe(true)
    expect(() => createRecordingSend(sandbox().send, { pack: dir, name: 'off', ref: 'sandbox', env: {} })).toThrow(/CONNECT_RECORD=1/)
  })

  it('writes <pack>/test/<name>.recording.json, marked as a scrubbed sandbox recording, with only allowed headers', async () => {
    const live = sandbox()
    const rec = createRecordingSend(live.send, { pack: dir, name: 'items', ref: 'example sandbox, 2026-11-23', env: ON, now: clock })
    await runOperation(list(rec.send))
    await runOperation(create(rec.send))
    expect(live.seen).toHaveLength(3)
    const written = rec.save()
    expect(written).toEqual({ ok: true, file: join(dir, 'test', 'items.recording.json') })
    const text = readFileSync(join(dir, 'test', 'items.recording.json'), 'utf8')
    const file = JSON.parse(text) as Recording & { source: { recordedAt?: string } }
    expect(file.source).toEqual({ kind: 'sandbox', ref: 'example sandbox, 2026-11-23', scrubbed: true, recordedAt: '2026-11-23T00:00:00.000Z' })
    expect(file.exchanges.map((x) => x.name)).toEqual(['GET /api/items 1', 'GET /api/items 2', 'POST /api/items 3'])
    // Authorisation and cookies never reach the file, whatever the allowlist says; a header not on it is dropped.
    expect(text).not.toMatch(/authorization|cookie|set-cookie|x-vendor-trace/i)
    expect(text).not.toContain('live-sandbox-key')
    // The planted token, email and account number are replaced.
    for (const gone of ['abcDEF1234567890xyz', 'ana.smith@acme.co.nz', 'bo.lee@acme.co.nz', '0123456789012']) expect(text).not.toContain(gone)
    expect(text).toContain('<email>')
    expect(text).toContain('<number>')
    expect(text).toContain('<token>')
    expect(findSecrets(text)).toEqual([])
    // The repeat key is kept (it is on the allowlist) so the replayed request matches.
    expect(text).toContain(replayIdempotencyKey('create'))
  })

  it('refuses to write while anything still looks like a secret, and writes nothing', async () => {
    const leaky: Send = async () => ({ ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"note":"tenant ana@acme.co.nz"}' })
    // A scrubber that leaves everything as it was stands in for one that missed something.
    const rec = createRecordingSend(leaky, { pack: dir, name: 'leaky', ref: 'sandbox', env: ON, now: clock, scrub: (t) => t })
    await rec.send({ method: 'GET', url: 'https://sandbox.example.test/api/x', headers: {} })
    const out = rec.save()
    expect(out.ok).toBe(false)
    expect(out.ok ? '' : out.problems.join(' ')).toMatch(/email address/)
    expect(existsSync(join(dir, 'test', 'leaky.recording.json'))).toBe(false)
  })

  it('recording twice with the same run reference and clock writes the same file', async () => {
    const a = createRecordingSend(sandbox().send, { pack: dir, name: 'again-a', ref: 'sandbox', env: ON, now: clock })
    const b = createRecordingSend(sandbox().send, { pack: dir, name: 'again-b', ref: 'sandbox', env: ON, now: clock })
    for (const r of [a, b]) { await runOperation(create(r.send)); r.save() }
    expect(readFileSync(join(dir, 'test', 'again-a.recording.json'), 'utf8')).toBe(readFileSync(join(dir, 'test', 'again-b.recording.json'), 'utf8'))
    expect(REPLAY_RUN_REF).toBe('replay')
  })
})

describe('replaying what was recorded', () => {
  it('gives the same result as the recorded run', async () => {
    const rec = createRecordingSend(sandbox().send, { pack: dir, name: 'round', ref: 'sandbox', env: ON, now: clock })
    const liveList = await runOperation(list(rec.send))
    const liveCreate = await runOperation(create(rec.send))
    rec.save()
    const recording = JSON.parse(readFileSync(join(dir, 'test', 'round.recording.json'), 'utf8')) as Recording
    const replay = createReplaySend(recording)
    const again = { list: await runOperation(list(replay.send)), create: await runOperation(create(replay.send)) }
    // The scrubbed answer is what replays, so compare what the recording keeps: outcome, pages, the listed ids.
    expect(again.list).toMatchObject({ outcome: liveList.outcome, pages: liveList.pages, output: liveList.output })
    expect(again.create).toMatchObject({ outcome: liveCreate.outcome, status: liveCreate.status, output: { id: 'it_1' } })
    expect(replay.unused()).toEqual([])
  })

  it('an unmatched request fails, and unused() names what the test never asked for', async () => {
    const recording: Recording = {
      source: { kind: 'documentation', ref: 'hand-made', scrubbed: true },
      exchanges: [
        { name: 'one', request: { method: 'GET', url: 'https://a.example.test/one' }, response: { status: 200, body: '{}' } },
        { name: 'two', request: { method: 'GET', url: 'https://a.example.test/two' }, response: { status: 200, body: '{}' } },
      ],
    }
    const replay = createReplaySend(recording)
    await replay.send({ method: 'GET', url: 'https://a.example.test/one', headers: {} })
    await expect(replay.send({ method: 'GET', url: 'https://a.example.test/three', headers: {} })).rejects.toThrow(/not in the recording/)
    expect(replay.unused()).toEqual(['two'])
  })
})
