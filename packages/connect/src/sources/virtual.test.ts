// Zero copy (FRAMEWORK 4.2): connector operations offered as a schemaWeave-shaped source. Every read is one runner
// call through the given door; only plain AND-ed literal rules are pushed; writes refuse.
import { describe, expect, it } from 'vitest'
import type { SendResult, WireRequest } from '../types.js'
import { SourceReadError, createRunnerSource, odataSourceTable, type RunnerSourceTable } from './virtual.js'
import type { ODataSource } from './odata.js'

const PEOPLE = [
  { UserName: 'russell', FirstName: 'Russell', City: "O'Neill", Secret: 'not declared' },
  { UserName: 'scott', FirstName: 'Scott', City: 'Boise' },
  { UserName: 'ronald', FirstName: 'Ronald', City: "O'Neill" },
]

/** A tiny OData service: honours $filter `City eq '…'` and $top, and records every request. */
function odataService() {
  const sent: WireRequest[] = []
  const send = async (r: WireRequest): Promise<SendResult> => {
    sent.push(r)
    const u = new URL(r.url)
    const filter = u.searchParams.get('$filter') ?? ''
    const city = /^City eq '((?:[^']|'')*)'$/.exec(filter)?.[1]?.replace(/''/g, "'")
    const top = Number(u.searchParams.get('$top') ?? '1000')
    const value = PEOPLE.filter((p) => city === undefined || p.City === city).slice(0, top)
    return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }
  }
  return { sent, send }
}

const people: ODataSource = {
  key: 'people', label: 'People', baseUrl: 'https://odata.example.test/svc', entitySet: 'People',
  select: [{ field: 'UserName', output: 'user_name' }, { field: 'FirstName', output: 'first_name' }, { field: 'City', output: 'city' }],
  filters: [{ field: 'City', op: 'eq', input: 'city', type: 'string' }],
}

const context = (send: (r: WireRequest) => Promise<SendResult>) => ({ settings: {}, credential: async (q: WireRequest) => ({ ok: true as const, request: { ...q, headers: { ...q.headers, authorization: 'Bearer t' } } }), send, label: 'The people directory' })

describe('a zero-copy source on the operation runner', () => {
  it('describes the table and says it is read-only and which operators it can push', async () => {
    const src = createRunnerSource([odataSourceTable(people, { primaryKey: ['user_name'] })], context(odataService().send))
    expect(await src.describeSchema('people')).toEqual({
      name: 'people', primaryKey: ['user_name'],
      fields: [{ name: 'user_name', nativeType: 'Edm.String', nullable: false }, { name: 'first_name', nativeType: 'Edm.String', nullable: true }, { name: 'city', nativeType: 'Edm.String', nullable: true }],
    })
    expect(await src.capabilities('people')).toEqual({ filter: true, sort: false, pagination: false, operators: ['='], writes: false })
  })

  it('pushes a plain rule into $filter (quoted as data), keeps only declared columns, and signs the call', async () => {
    const svc = odataService()
    const src = createRunnerSource([odataSourceTable(people, { primaryKey: ['user_name'] })], context(svc.send))
    const where = { combinator: 'and', rules: [{ field: 'city', operator: '=', value: "O'Neill" }, { field: 'first_name', operator: 'contains', value: 'R' }] } as const
    const r = await src.query({ table: 'people', where })
    expect(r.rows).toEqual([{ user_name: 'russell', first_name: 'Russell', city: "O'Neill" }, { user_name: 'ronald', first_name: 'Ronald', city: "O'Neill" }])
    expect(r.residual).toEqual(where) // schemaWeave re-applies the whole condition, including the rule not pushed
    expect(new URL(svc.sent[0]!.url).searchParams.get('$filter')).toBe("City eq 'O''Neill'")
    expect(svc.sent[0]!.headers['authorization']).toBe('Bearer t')
    expect(svc.sent).toHaveLength(1)
  })

  it('never pushes an OR, a negation, or a rule whose value is another column', async () => {
    const svc = odataService()
    const src = createRunnerSource([odataSourceTable(people, { primaryKey: ['user_name'] })], context(svc.send))
    await src.query({ table: 'people', where: { combinator: 'or', rules: [{ field: 'city', operator: '=', value: 'Boise' }, { field: 'city', operator: '=', value: 'Ely' }] } })
    await src.query({ table: 'people', where: { combinator: 'and', not: true, rules: [{ field: 'city', operator: '=', value: 'Boise' }] } })
    await src.query({ table: 'people', where: { field: 'city', operator: '=', value: 'first_name', valueSource: 'field' } })
    for (const r of svc.sent) expect(new URL(r.url).searchParams.has('$filter')).toBe(false)
  })

  it('gets one row by its key through the list operation', async () => {
    const src = createRunnerSource([odataSourceTable(people, { primaryKey: ['city'] })], context(odataService().send))
    expect(await src.get('people', 'Boise')).toEqual({ user_name: 'scott', first_name: 'Scott', city: 'Boise' })
    expect(await src.get('people', 'Nowhere')).toBeUndefined()
  })

  it('uses a declared limit input and a single-record operation when a REST table has them', async () => {
    const sent: string[] = []
    const send = async (r: WireRequest): Promise<SendResult> => {
      sent.push(r.url)
      const u = new URL(r.url)
      const body = u.pathname === '/api/issues' ? { issues: [{ key: 'OPS-1', title: 'Down' }, { key: 'OPS-2', title: 'Slow' }] } : { key: u.pathname.split('/').pop(), title: 'One' }
      return { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    }
    const issues: RunnerSourceTable = {
      table: 'issue', primaryKey: ['key'],
      fields: [{ name: 'key', nativeType: 'string', nullable: false }, { name: 'title', nativeType: 'string', nullable: true }],
      list: {
        spec: { key: 'issue.list', method: 'GET', baseUrl: 'https://jira.example.test', pathTemplate: '/api/issues', bodyFormat: 'none', idempotency: 'inherently_idempotent', itemsPath: 'issues' },
        request: [{ from: 'input', source: 'max', target: 'query:maxResults' }, { from: 'input', source: 'project', target: 'query:project' }],
        response: [{ itemOf: 'items', source: 'key', target: 'key' }, { itemOf: 'items', source: 'title', target: 'title' }],
        outputs: [{ name: 'items' }],
      },
      filters: [{ field: 'project', operator: '=', input: 'project' }],
      limitInput: 'max',
      get: {
        idInput: 'id',
        operation: {
          spec: { key: 'issue.get', method: 'GET', baseUrl: 'https://jira.example.test', pathTemplate: '/api/issue/{id}', bodyFormat: 'none', idempotency: 'inherently_idempotent' },
          request: [{ from: 'input', source: 'id', target: 'path:id' }],
          response: [{ source: 'key', target: 'key' }, { source: 'title', target: 'title' }],
          outputs: [{ name: 'key' }, { name: 'title' }],
        },
      },
    }
    const src = createRunnerSource([issues], context(send))
    expect((await src.capabilities('issue')).pagination).toBe(true)
    const r = await src.query({ table: 'issue', limit: 1, where: { field: 'project', operator: '=', value: 'OPS' } })
    expect(r.rows).toEqual([{ key: 'OPS-1', title: 'Down' }])
    expect(new URL(sent[0]!).search).toBe('?maxResults=1&project=OPS')
    expect(await src.get('issue', 'OPS-9')).toEqual({ key: 'OPS-9', title: 'One' })
    expect(sent[1]).toBe('https://jira.example.test/api/issue/OPS-9')
  })

  it('refuses writes, unknown tables, and fails loudly when the application refuses', async () => {
    const denied = async (): Promise<SendResult> => ({ ok: true, status: 403, headers: {}, body: '{"error":"no"}' })
    const src = createRunnerSource([odataSourceTable(people, { primaryKey: ['user_name'] })], context(denied))
    await expect(src.create('people', {})).rejects.toBeInstanceOf(SourceReadError)
    await expect(src.update('people', 'x', {})).rejects.toThrow(/read in place/)
    await expect(src.query({ table: 'nope' })).rejects.toThrow(/no table called/)
    await expect(src.query({ table: 'people' })).rejects.toThrow(/not allowed/)
    expect(() => createRunnerSource([odataSourceTable(people, { primaryKey: [] }), odataSourceTable(people, { primaryKey: [] })], context(denied))).toThrow(/twice/)
  })
})
