// F-L4: record-and-replay. The kit replays a recorded exchange set; the scrubber removes a planted token, email and
// account number; a request that is not in the recording fails the test.
import { describe, expect, it } from 'vitest'
import { runOperation } from '../runner/index.js'
import { checkRecording, createReplaySend, findSecrets, scrub, type Recording } from './index.js'

const recording: Recording = {
  source: { kind: 'documentation', ref: 'example vendor docs, "List items" (hand-made)', scrubbed: true },
  exchanges: [
    { name: 'first page', request: { method: 'GET', url: 'https://a.example.test/api/items?limit=2' }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[{"id":1},{"id":2}],"next":"c2"}' } },
    { name: 'second page', request: { method: 'GET', url: 'https://a.example.test/api/items?limit=2&cursor=c2' }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[{"id":3}],"next":null}' } },
    { name: 'create', request: { method: 'POST', url: 'https://a.example.test/api/items', headers: { 'idempotency-key': 'geni-1' }, json: { name: 'x' } }, response: { status: 201, body: '{"id":9}' } },
    { name: 'throttled', request: { method: 'GET', url: 'https://a.example.test/api/slow' }, response: { status: 429, headers: { 'retry-after': '30' }, body: '{}' } },
    { name: 'timeout', request: { method: 'POST', url: 'https://a.example.test/api/charge' }, failure: { kind: 'timeout', code: 'TIMEOUT' } },
  ],
}

describe('replay', () => {
  it('replays a recorded exchange set through the runner, page by page', async () => {
    const replay = createReplaySend(recording)
    const r = await runOperation({
      spec: { key: 'list', method: 'GET', baseUrl: 'https://a.example.test/api', pathTemplate: '/items', bodyFormat: 'none', idempotency: 'inherently_idempotent', itemsPath: 'items', paging: { style: 'cursor', cursorParam: 'cursor', cursorPath: 'next', pageSizeParam: 'limit', pageSize: 2 } },
      request: [], response: [{ itemOf: 'items', source: 'id', target: 'id' }], outputs: [{ name: 'items' }], input: {}, settings: {},
      credential: async (q) => ({ ok: true, request: q }), send: replay.send, label: 'List items',
    })
    expect(r.output['items']).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(replay.used()).toEqual(['first page', 'second page'])
  })
  it('matches headers and a JSON body when the recording names them', async () => {
    const replay = createReplaySend(recording)
    const r = await replay.send({ method: 'POST', url: 'https://a.example.test/api/items', headers: { 'idempotency-key': 'geni-1', 'content-type': 'application/json' }, body: '{"name":"x"}' })
    expect(r.ok && r.status).toBe(201)
    await expect(replay.send({ method: 'POST', url: 'https://a.example.test/api/items', headers: { 'idempotency-key': 'geni-2' }, body: '{"name":"x"}' })).rejects.toThrow(/not in the recording/)
  })
  it('replays failures (a timeout) as the door would report them', async () => {
    const r = await createReplaySend(recording).send({ method: 'POST', url: 'https://a.example.test/api/charge', headers: {} })
    expect(r).toMatchObject({ ok: false, kind: 'timeout', code: 'TIMEOUT' })
  })
  it('fails loudly on a request that is not in the recording', async () => {
    await expect(createReplaySend(recording).send({ method: 'GET', url: 'https://a.example.test/api/other', headers: {} })).rejects.toThrow(/not in the recording/)
  })
  it('query order does not matter', async () => {
    const r = await createReplaySend(recording).send({ method: 'GET', url: 'https://a.example.test/api/items?cursor=c2&limit=2', headers: {} })
    expect(r.ok).toBe(true)
  })
})

describe('scrubbing', () => {
  const planted = 'Authorization: Bearer abcDEF1234567890xyz; owner ana.smith@acme.example; account 0123456789012; key sk-live_ABCDEFGHIJKLMNOP1234; jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'
  it('removes tokens, emails, account numbers, keys and JWTs', () => {
    const out = scrub(planted)
    for (const gone of ['abcDEF1234567890xyz', 'ana.smith@acme.example', '0123456789012', 'sk-live_ABCDEFGHIJKLMNOP1234', 'eyJhbGciOiJIUzI1NiJ9']) expect(out).not.toContain(gone)
    expect(out).toContain('<token>')
    expect(out).toContain('<email>')
    expect(out).toContain('<number>')
    expect(findSecrets(out)).toEqual([])
  })
  it('a recording with a live-looking secret or personal data is refused by the check', () => {
    const bad: Recording = { ...recording, exchanges: [{ name: 'x', request: { method: 'GET', url: 'https://a.example.test/?email=ana.smith@acme.example' }, response: { status: 200, body: 'ok' } }] }
    expect(checkRecording(bad).length).toBeGreaterThan(0)
    expect(checkRecording(recording)).toEqual([])
  })
  it('a hand-made recording must say where it came from', () => {
    expect(checkRecording({ ...recording, source: { kind: 'documentation', ref: '', scrubbed: true } })).toContain('A recording must say where it came from (source.ref).')
  })
})

describe('files in recordings', () => {
  it('matches multipart parts and a binary body, and answers a stored file by reference', async () => {
    const { createReplaySend } = await import('./replay.js')
    const r = createReplaySend({ source: { kind: 'documentation', ref: 'test', scrubbed: true }, exchanges: [
      { name: 'upload', request: { method: 'POST', url: 'https://x.example.test/att', parts: [{ name: 'file', fileRef: 'f1' }] }, response: { status: 200, body: '[{"id":"9"}]' } },
      { name: 'download', request: { method: 'GET', url: 'https://x.example.test/att/9' }, response: { status: 200, body: '', file: { ref: 'stored-9', contentType: 'text/plain' } } },
    ] })
    const up = await r.send({ method: 'POST', url: 'https://x.example.test/att', headers: {}, parts: [{ name: 'file', file: { ref: 'f1' } }] })
    expect(up.ok && up.status).toBe(200)
    const down = await r.send({ method: 'GET', url: 'https://x.example.test/att/9', headers: {}, expect: 'file' })
    expect(down.ok && down.file).toEqual({ ref: 'stored-9', contentType: 'text/plain' })
    await expect(r.send({ method: 'POST', url: 'https://x.example.test/att', headers: {}, parts: [{ name: 'file', file: { ref: 'other' } }] })).rejects.toThrow()
  })
})
