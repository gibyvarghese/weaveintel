// F-L2d: an OData source on the generic operation runner. The adapter turns a source description (entity set,
// selected fields, filters from tool inputs, a limit, a page size) into the runner's operation and mapping rows; the
// runner follows `@odata.nextLink` pages. Proven against a hand-made recording of the protocol's own shapes.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runOperation } from '../runner/index.js'
import { getAt } from '../runner/paths.js'
import { checkRecording, createReplaySend, type Recording } from '../replay/index.js'
import { odataFilter, odataOperation, odataLiteral, type ODataSource } from './index.js'

const recording = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'odata-people.recording.json'), 'utf8')) as Recording

const people: ODataSource = {
  key: 'people.list', label: 'List people', baseUrl: 'https://odata.example.test/svc', entitySet: 'People',
  select: [{ field: 'UserName', output: 'user_name' }, { field: 'FirstName', output: 'first_name' }, { field: 'City', output: 'city' }],
  filters: [{ field: 'City', op: 'eq', input: 'city', type: 'string' }, { field: 'Age', op: 'ge', input: 'min_age', type: 'number' }],
  top: 3, pageSize: 2, maxPages: 5,
}

const run = (input: Record<string, unknown>, source: ODataSource = people) => {
  const replay = createReplaySend(recording)
  const op = odataOperation(source)
  return { replay, result: runOperation({ ...op, input: odataFilter(source, input), settings: {}, credential: async (q) => ({ ok: true, request: q }), send: replay.send, label: source.label }) }
}

describe('an OData source on the operation runner', () => {
  it('the fixture is a recording the kit accepts', () => {
    expect(checkRecording(recording)).toEqual([])
  })

  it('a path may name a key with dots in it: ["@odata.nextLink"]', () => {
    expect(getAt({ '@odata.nextLink': 'x', a: { 'b.c': 1 } }, '["@odata.nextLink"]')).toBe('x')
    expect(getAt({ a: { 'b.c': 1 } }, 'a["b.c"]')).toBe(1)
  })

  it('sends $select, $filter (escaped) and $top, asks for a page size, and follows @odata.nextLink', async () => {
    const { replay, result } = run({ city: "O'Neill", min_age: 30 })
    const r = await result
    expect(r.outcome).toBe('ok')
    expect(r.output['items']).toEqual([
      { user_name: 'russellwhyte', first_name: 'Russell', city: "O'Neill" },
      { user_name: 'scottketchum', first_name: 'Scott', city: "O'Neill" },
      { user_name: 'ronaldmundy', first_name: 'Ronald', city: "O'Neill" },
    ])
    expect(r.pages).toBe(2)
    expect(replay.used()).toEqual(['people, first page', 'people, second page'])
  })

  it('leaves a filter out when its input is not given, and stops at a next link to another host', async () => {
    const { replay, result } = run({})
    const r = await result
    expect(replay.used()).toEqual(['people, a link to another host'])
    expect(r.truncated).toBe(true)
  })

  it('never lets an input change the query: literals are quoted and escaped, numbers must be numbers', () => {
    expect(odataLiteral("x' or 1 eq 1 or 'a", 'string')).toBe("'x'' or 1 eq 1 or ''a'")
    expect(() => odataLiteral('1 or true', 'number')).toThrow(/number/)
    expect(odataLiteral(true, 'boolean')).toBe('true')
    expect(odataLiteral('2026-11-23', 'date')).toBe('2026-11-23')
    expect(() => odataLiteral('2026-11-23) or (1 eq 1', 'date')).toThrow(/date/)
    expect(odataFilter(people, { city: "a'b" })['odata_filter']).toBe("City eq 'a''b'")
  })

  it('refuses a source whose names are not plain OData identifiers', () => {
    expect(() => odataOperation({ ...people, entitySet: 'People?$expand=Friends' })).toThrow(/entity set/)
    expect(() => odataOperation({ ...people, select: [{ field: 'UserName,Trips', output: 'x' }] })).toThrow(/field/)
  })
})
