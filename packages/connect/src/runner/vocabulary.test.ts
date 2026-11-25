// SPDX-License-Identifier: MIT
// The partner vocabulary (connect 0.4.0): query clauses, whole-body and merged-body targets, multipart / binary / text
// bodies, file answers, wire encodings, 1-based offsets, rate-limit headers and the request size cap. Each is a closed
// word a connector pack uses through rows, so a partner never needs code for these shapes.
import { describe, expect, it } from 'vitest'
import type { Send, SendResult, WireRequest } from '../types.js'
import {
  BODY_FORMATS, ENCODINGS, QUERY_DIALECTS, buildRequest, checkClause, decodeValue, encodeValue, rateHeaders, runOperation,
  type OperationSpec, type RequestMapping, type RunInput,
} from './index.js'

const op = (over: Partial<OperationSpec> = {}): OperationSpec => ({ key: 't.op', method: 'GET', baseUrl: 'https://acme.example.test/api', pathTemplate: '/now/table/incident', bodyFormat: 'none', idempotency: 'none', ...over })
const built = (spec: OperationSpec, rows: RequestMapping[], input: Record<string, unknown> = {}): WireRequest => {
  const r = buildRequest(spec, rows, input, {})
  if (!r.ok) throw new Error(`${r.code}: ${r.sentence}`)
  return r.request
}
const query = (r: WireRequest, name: string): string | null => new URL(r.url).searchParams.get(name)

describe('the closed lists', () => {
  it('names the new words', () => {
    expect([...BODY_FORMATS]).toEqual(['json', 'form', 'none', 'multipart', 'binary', 'text'])
    expect([...ENCODINGS]).toEqual(['none', 'adf_document', 'comma_list', 'json_text'])
    expect([...QUERY_DIALECTS]).toEqual(['servicenow_encoded', 'jql', 'odata_filter'])
  })
})

describe('query clauses', () => {
  const sn = (field: string, operator: string): RequestMapping['clause'] => ({ dialect: 'servicenow_encoded', field, operator })
  it('writes a ServiceNow encoded query; an input cannot add a clause', () => {
    const rows: RequestMapping[] = [
      { from: 'fixed', source: 'true', target: 'query:sysparm_query', clause: sn('active', '=') },
      { from: 'input', source: 'caller', target: 'query:sysparm_query', clause: sn('caller_id', '=') },
      { from: 'fixed', source: '', target: 'query:sysparm_query', clause: sn('sys_created_on', 'order_by_desc') },
    ]
    const r = built(op(), rows, { caller: 'abc^ORactive=false' })
    // The caret is doubled, so the service reads it as part of the value, not as "OR".
    expect(query(r, 'sysparm_query')).toBe('active=true^caller_id=abc^^ORactive=false^ORDERBYDESCsys_created_on')
  })
  it('skips an empty optional clause and writes list operators', () => {
    const rows: RequestMapping[] = [
      { from: 'input', source: 'states', target: 'query:sysparm_query', clause: sn('state', 'IN') },
      { from: 'input', source: 'missing', target: 'query:sysparm_query', clause: sn('priority', '=') },
    ]
    expect(query(built(op(), rows, { states: ['1', '2'] }), 'sysparm_query')).toBe('stateIN1,2')
    const bad = buildRequest(op(), rows, { states: ['1,3'] }, {})
    expect(bad.ok).toBe(false)
  })
  it('quotes JQL values and puts ordering last, in the body of a POST', () => {
    const rows: RequestMapping[] = [
      { from: 'input', source: 'project', target: 'body:jql', clause: { dialect: 'jql', field: 'project', operator: '=' } },
      { from: 'input', source: 'text', target: 'body:jql', clause: { dialect: 'jql', field: 'summary', operator: '~' } },
      { from: 'fixed', source: '', target: 'body:jql', clause: { dialect: 'jql', field: 'updated', operator: 'order_by_desc' } },
    ]
    const r = built(op({ method: 'POST', pathTemplate: '/rest/api/3/search/jql', bodyFormat: 'json' }), rows, { project: 'OPS', text: 'say "hi" OR project = X' })
    expect(JSON.parse(r.body ?? '{}')).toEqual({ jql: 'project = "OPS" AND summary ~ "say \\"hi\\" OR project = X" ORDER BY updated DESC' })
  })
  it('writes OData filters with doubled quotes', () => {
    const rows: RequestMapping[] = [{ from: 'input', source: 'name', target: 'query:$filter', clause: { dialect: 'odata_filter', field: 'LastName', operator: 'eq' } }]
    expect(query(built(op(), rows, { name: "O'Brien" }), '$filter')).toBe("LastName eq 'O''Brien'")
  })
  it('refuses a field or operator outside the dialect', () => {
    expect(checkClause({ dialect: 'servicenow_encoded', field: 'state^OR1', operator: '=' })).toBeDefined()
    expect(checkClause({ dialect: 'jql', field: 'status', operator: 'was' })).toBeDefined()
    expect(checkClause({ dialect: 'jql', field: 'cf[10010]', operator: '=' })).toBeUndefined()
  })
  it('accepts ServiceNow full-text search as a clause and escapes its words', () => {
    expect(checkClause({ dialect: 'servicenow_encoded', field: '123TEXTQUERY321', operator: '=' })).toBeUndefined()
    expect(checkClause({ dialect: 'servicenow_encoded', field: '123other', operator: '=' })).toBeDefined()
    const rows: RequestMapping[] = [{ from: 'input', source: 'text', target: 'query:sysparm_query', clause: sn('123TEXTQUERY321', '=') }, { from: 'fixed', source: 'published', target: 'query:sysparm_query', clause: sn('workflow_state', '=') }]
    expect(query(built(op(), rows, { text: 'email^ORactive=false' }), 'sysparm_query')).toBe('123TEXTQUERY321=email^^ORactive=false^workflow_state=published')
  })
})

describe('bodies', () => {
  it('sends a bare value as the whole body (Jira add-watcher takes a JSON string)', () => {
    const r = built(op({ method: 'POST', bodyFormat: 'json' }), [{ from: 'input', source: 'account', target: 'body:$' }], { account: '5b10ac' })
    expect(r.body).toBe('"5b10ac"')
  })
  it('merges only the allowed keys of an object', () => {
    const rows: RequestMapping[] = [{ from: 'input', source: 'fields', target: 'body:fields.*', allowKeys: ['summary', 'customfield_*'] }]
    const spec = op({ method: 'PUT', bodyFormat: 'json' })
    expect(JSON.parse(built(spec, rows, { fields: { summary: 'S', customfield_10010: 3 } }).body ?? '')).toEqual({ fields: { summary: 'S', customfield_10010: 3 } })
    const r = buildRequest(spec, rows, { fields: { summary: 'S', reporter: 'x' } }, {})
    expect(r.ok).toBe(false)
    expect(buildRequest(spec, [{ from: 'input', source: 'fields', target: 'body:*' }], { fields: { a: 1 } }, {}).ok).toBe(false)
  })
  it('builds multipart parts with a file reference the door resolves', () => {
    const spec = op({ method: 'POST', bodyFormat: 'multipart' })
    const r = built(spec, [{ from: 'input', source: 'file', target: 'part:file' }, { from: 'fixed', source: 'no-check', target: 'header:X-Atlassian-Token' }], { file: { ref: 'att_1', filename: 'log.txt' } })
    expect(r.parts).toEqual([{ name: 'file', file: { ref: 'att_1', filename: 'log.txt' } }])
    expect(r.body).toBeUndefined()
    expect(r.headers['x-atlassian-token']).toBe('no-check')
  })
  it('sends one file as a binary body, and text as written', () => {
    const bin = built(op({ method: 'POST', bodyFormat: 'binary' }), [{ from: 'input', source: 'f', target: 'body:$' }], { f: { ref: 'att_2' } })
    expect(bin.file).toEqual({ ref: 'att_2' })
    const text = built(op({ method: 'POST', bodyFormat: 'text' }), [{ from: 'input', source: 'csv', target: 'body:$' }, { from: 'fixed', source: 'text/csv', target: 'header:content-type' }], { csv: 'a,b\n1,2' })
    expect(text.body).toBe('a,b\n1,2')
    expect(text.headers['content-type']).toBe('text/csv')
  })
  it('refuses a request longer than the service accepts, before sending', () => {
    const r = buildRequest(op({ method: 'POST', bodyFormat: 'json', maxRequestBytes: 20 }), [{ from: 'input', source: 'q', target: 'body:q' }], { q: 'x'.repeat(50) }, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('TOO_LARGE')
  })
})

describe('encodings', () => {
  it('turns plain text into an ADF document and back', () => {
    const adf = encodeValue('adf_document', 'First line\nsecond line\n\nNew paragraph') as Record<string, unknown>
    expect(adf['type']).toBe('doc')
    expect(adf['content']).toHaveLength(2)
    expect(decodeValue('adf_document', adf)).toBe('First line\nsecond line\n\nNew paragraph')
  })
  it('writes lists as commas and JSON inside text', () => {
    expect(encodeValue('comma_list', ['a', ' b ', ''])).toBe('a,b')
    expect(decodeValue('comma_list', 'a, b,,c')).toEqual(['a', 'b', 'c'])
    expect(decodeValue('json_text', encodeValue('json_text', { a: [1] }))).toEqual({ a: [1] })
  })
  it('writes an ADF description into the request body', () => {
    const r = built(op({ method: 'POST', bodyFormat: 'json' }), [{ from: 'input', source: 'text', target: 'body:fields.description', encoding: 'adf_document' }], { text: 'Hello' })
    expect(JSON.parse(r.body ?? '')).toEqual({ fields: { description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] } } })
  })
})

const answers = (...rs: SendResult[]): { send: Send; sent: WireRequest[] } => {
  const sent: WireRequest[] = []
  let i = 0
  return { sent, send: async (r) => { sent.push(r); return rs[Math.min(i++, rs.length - 1)] as SendResult } }
}
const run = (spec: OperationSpec, send: Send, over: Partial<RunInput> = {}): ReturnType<typeof runOperation> => runOperation({
  spec, request: [], response: [], outputs: [], input: {}, settings: {}, credential: async (r) => ({ ok: true, request: r }), send, label: 'The test', ...over,
})
const ok = (body: unknown, headers: Record<string, string> = {}): SendResult => ({ ok: true, status: 200, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('answers', () => {
  it('pages SCIM lists from 1', async () => {
    const { send, sent } = answers(ok({ Resources: [{ id: 'a' }, { id: 'b' }], totalResults: 3 }), ok({ Resources: [{ id: 'c' }], totalResults: 3 }))
    const r = await run(op({ pathTemplate: '/scim/Users', itemsPath: 'Resources', paging: { style: 'offset_limit', offsetParam: 'startIndex', offsetBase: 1, pageSizeParam: 'count', pageSize: 2, totalPath: 'totalResults' } }), send, {
      response: [{ source: 'id', target: 'id', itemOf: 'users' }], outputs: [{ name: 'users' }],
    })
    expect(sent.map((s) => query(s, 'startIndex'))).toEqual(['1', '3'])
    expect(r.output['users']).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  })
  it('hands the wait and rate-limit headers to the host', async () => {
    const { send } = answers({ ok: true, status: 429, headers: { 'retry-after': '30', 'x-ratelimit-remaining': '0' }, body: '' })
    const r = await run(op(), send)
    expect(r.outcome).toBe('throttled')
    expect(r.retryAfterSeconds).toBe(30)
    expect(r.rateLimit).toEqual({ 'x-ratelimit-remaining': '0' })
    expect(rateHeaders({ 'retry-after': 'not a date' }).retryAfterSeconds).toBeUndefined()
  })
  it('maps a stored file answer to an output, never the bytes', async () => {
    const { send, sent } = answers({ ok: true, status: 200, headers: {}, body: '', file: { ref: 'att_9', contentType: 'application/pdf' } })
    const r = await run(op({ pathTemplate: '/attachment/1/file', responseFormat: 'file' }), send, { response: [{ source: '$file', target: 'file' }], outputs: [{ name: 'file' }] })
    expect(sent[0]?.expect).toBe('file')
    expect(r.output['file']).toEqual({ ref: 'att_9', contentType: 'application/pdf' })
  })
  it('reads ADF answers back as plain text', async () => {
    const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Server is down' }] }] }
    const { send } = answers(ok({ fields: { description: adf } }))
    const r = await run(op(), send, { response: [{ source: 'fields.description', target: 'description', encoding: 'adf_document' }], outputs: [{ name: 'description' }] })
    expect(r.output['description']).toBe('Server is down')
  })
})
