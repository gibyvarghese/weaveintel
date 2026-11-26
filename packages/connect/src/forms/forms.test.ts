// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest'
import { applicable, fromDefinition, fromElicitation, guidedSubmit, nextQuestions, normalise, readDateTime, summarise, toElicitation, validate, writeDateTime, type FormMapping, type FormSpec } from './index.js'

// ServiceNow "Report Outage", the shape a developer instance answered on 2026-11-26 (trimmed).
const SN_DEF = {
  sys_id: '38c1', name: 'Report Outage', short_description: 'Report an outage of a service or an application.\n', item_type: 'record_producer',
  variables: [
    { name: 'cmdb_ci', label: 'What application is down/unavailable?', friendly_type: 'reference', mandatory: true, reference: 'cmdb_ci_service', read_only: false },
    { name: 'outage_start', label: 'At what time did you notice the outage began?', friendly_type: 'date_time', mandatory: false, default_value: 'javascript:gs.nowDateTime()' },
    { name: 'details', label: 'Details', friendly_type: 'container_start', children: [
      { name: 'failure_mode', label: 'Nature of outage', friendly_type: 'multiple_choice', mandatory: false,
        choices: [{ label: '-- None --', value: '' }, { label: 'Application will not launch/cannot start', value: 'launch' }, { label: 'Application gives error message', value: 'message' }] },
      { name: 'error_message', label: 'Please describe your error message below', friendly_type: 'wide_single_line_text', mandatory: false },
    ] },
    { name: 'computed', label: 'Computed', friendly_type: 'single_line_text', read_only: true },
  ],
  ui_policies: [
    { short_description: 'Show error message', reverse: true, conditions: [{ field: 'IO:390b', oper: '=', value: 'message' }], actions: [{ name: 'IO:38c6', visible: 'true', mandatory: 'true' }] },
    { short_description: 'Inert policy', reverse: true, conditions: [{ field: 'IO:390b', oper: '=', value: 'launch' }], actions: [] },
  ],
}
const SN_MAP: FormMapping = {
  id: 'sys_id', title: 'name', description: 'short_description', variant: 'item_type', questions: 'variables', flatten: 'children', kind: 'friendly_type',
  kinds: { reference: 'lookup', date_time: 'date_time', multiple_choice: 'choice', wide_single_line_text: 'text', single_line_text: 'text', container_start: 'skip' },
  fields: { name: 'name', label: 'label', required: 'mandatory', help: 'help_text', default: 'default_value|value', choices: 'choices', lookup: 'reference', readOnly: 'read_only' },
  ignoreDefaults: '^\\s*javascript:',
  rules: { at: 'ui_policies', when: 'conditions', question: 'field', op: 'oper', value: 'value', ops: { '=': '=', '!=': '!=' }, actions: 'actions', actionQuestion: 'name', show: 'visible', require: 'mandatory', reverse: 'reverse', note: 'short_description' },
}
const SN_IDS = { 'IO:390b': 'failure_mode', 'IO:38c6': 'error_message' }

// Jira Cloud create metadata for one issue type (GET /rest/api/3/issue/createmeta/{project}/issuetypes/{id}), documented shape.
const JIRA_DEF = { fields: [
  { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
  { fieldId: 'priority', name: 'Priority', required: false, schema: { type: 'priority' }, allowedValues: [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }], defaultValue: { id: '3', name: 'Medium' } },
  { fieldId: 'labels', name: 'Labels', required: false, schema: { type: 'array', items: 'string' } },
  { fieldId: 'components', name: 'Components', required: false, schema: { type: 'array', items: 'component' }, allowedValues: [{ id: '10', name: 'Mail' }, { id: '11', name: 'Web' }] },
  { fieldId: 'assignee', name: 'Assignee', required: false, schema: { type: 'user' } },
  { fieldId: 'duedate', name: 'Due date', required: false, schema: { type: 'date' } },
  { fieldId: 'customfield_1', name: 'Seen at', required: false, schema: { type: 'datetime' } },
] }
const JIRA_MAP: FormMapping = {
  questions: 'fields', kind: ['schema.type', 'schema.items'],
  kinds: { string: 'text', priority: 'choice', 'array:component': 'multi_choice', 'array:option': 'multi_choice', user: 'person', date: 'date', datetime: 'date_time', 'array:string': 'skip' },
  fields: { name: 'fieldId', label: 'name', required: 'required', choices: 'allowedValues', default: 'defaultValue' },
  choice: { label: 'name|value', value: 'id' }, lookupSources: { user: 'jira.users' },
}

// SharePoint list columns (Graph GET /sites/{site}/lists/{list}/columns), documented shape: one facet per column.
const SP_DEF = { value: [
  { name: 'Title', displayName: 'Title', required: true, text: { maxLength: 255 } },
  { name: 'Severity', displayName: 'Severity', required: false, choice: { choices: ['Low', 'High'] } },
  { name: 'Owner', displayName: 'Owner', required: false, personOrGroup: { allowMultipleSelection: false } },
  { name: 'Due', displayName: 'Due', required: false, dateTime: { format: 'dateTime' } },
  { name: 'Done', displayName: 'Done', required: false, boolean: {} },
  { name: 'Modified', displayName: 'Modified', readOnly: true, dateTime: {} },
] }
const SP_MAP: FormMapping = {
  questions: 'value', kindFacets: ['text', 'choice', 'personOrGroup', 'dateTime', 'boolean', 'number', 'lookup'],
  kinds: { text: 'text', choice: 'choice', personOrGroup: 'person', dateTime: 'date_time', boolean: 'boolean', number: 'number' },
  fields: { name: 'name', label: 'displayName', required: 'required', readOnly: 'readOnly', max: 'text.maxLength', choices: 'choice.choices' }, lookupSources: { personOrGroup: 'graph.people' },
}

describe('fromDefinition: three applications, one shape', () => {
  it('ServiceNow: nested questions, computed defaults dropped, rules mapped by id, inert rules dropped', () => {
    const { form, warnings } = fromDefinition(SN_DEF, SN_MAP, { ids: SN_IDS, timeZone: 'America/Los_Angeles', formats: { dateTime: 'local' } })
    expect(form.questions.map((q) => [q.name, q.kind])).toEqual([['cmdb_ci', 'lookup'], ['outage_start', 'date_time'], ['failure_mode', 'choice'], ['error_message', 'text']])
    expect(form.questions[0]!.lookup).toEqual({ source: 'cmdb_ci_service' })
    expect(form.questions[1]!.default).toBeUndefined()
    expect(form.questions[2]!.choices).toHaveLength(2)
    expect(form.variant).toBe('record_producer')
    expect(form.rules).toEqual([{ when: [{ question: 'failure_mode', op: '=', value: 'message' }], show: ['error_message'], require: ['error_message'], reverse: true, note: 'Show error message' }])
    expect(warnings.some((w) => w.includes('Inert policy'))).toBe(true)
  })
  it('Jira: types from schema.type + items, choices from allowedValues, users as people', () => {
    const { form } = fromDefinition(JIRA_DEF, JIRA_MAP)
    expect(form.questions.map((q) => [q.name, q.kind])).toEqual([['summary', 'text'], ['priority', 'choice'], ['components', 'multi_choice'], ['assignee', 'person'], ['duedate', 'date'], ['customfield_1', 'date_time']])
    expect(form.questions[1]).toMatchObject({ choices: [{ label: 'High', value: '2' }, { label: 'Medium', value: '3' }], default: '3' })
    expect(form.questions[3]!.lookup).toEqual({ source: 'jira.users' })
  })
  it('SharePoint: type from whichever facet is present, read-only columns skipped', () => {
    const { form } = fromDefinition(SP_DEF, SP_MAP)
    expect(form.questions.map((q) => [q.name, q.kind])).toEqual([['Title', 'text'], ['Severity', 'choice'], ['Owner', 'person'], ['Due', 'date_time'], ['Done', 'boolean']])
    expect(form.questions[0]!.max).toBe(255)
    expect(form.questions[1]!.choices).toEqual([{ label: 'Low', value: 'Low' }, { label: 'High', value: 'High' }])
  })
  it('an unmapped type is skipped with a warning, never guessed', () => {
    const { form, warnings } = fromDefinition({ fields: [{ fieldId: 'x', name: 'X', schema: { type: 'mystery' } }] }, JIRA_MAP)
    expect(form.questions).toEqual([])
    expect(warnings[0]).toContain('not mapped')
  })
})

const sn = () => fromDefinition(SN_DEF, SN_MAP, { ids: SN_IDS, timeZone: 'America/Los_Angeles', formats: { dateTime: 'local' } }).form

describe('rules', () => {
  it('a reverse "show when" rule hides the question until its condition holds, then requires it', () => {
    const f = sn()
    expect(applicable(f, {}).hidden.has('error_message')).toBe(true)
    expect(applicable(f, { failure_mode: 'Application gives error message' }).required.has('error_message')).toBe(true)
    expect(nextQuestions(f, { failure_mode: 'launch' }).map((q) => q.name)).toEqual(['cmdb_ci', 'outage_start'])
  })
  it('a hidden question\'s stale answer is never sent', () => {
    const f = sn()
    const out = normalise(f, { cmdb_ci: { id: 'svc1', label: 'Email' }, failure_mode: 'launch', error_message: 'left over' }, { personZone: 'Pacific/Auckland' })
    expect(out.values).toEqual({ cmdb_ci: 'svc1', failure_mode: 'launch' })
  })
})

describe('validate and normalise', () => {
  it('reports required, wrong choice, unresolved lookup and bad date-time', () => {
    const f = sn()
    const p = validate(f, { failure_mode: 'Sometimes', outage_start: 'yesterday-ish' }).map((x) => [x.question, x.problem])
    expect(p).toEqual([['cmdb_ci', 'required'], ['outage_start', 'not_a_date_time'], ['failure_mode', 'not_a_choice']])
    expect(validate(f, { cmdb_ci: 'Email' })[0]!.problem).toBe('not_resolved')
  })
  it('converts a wall-clock time from the person\'s zone to the form\'s (the live 21-hour bug)', () => {
    const f = sn()
    // 08:09 on 26 Nov in Auckland is 19:09 UTC on 25 Nov, which is 11:09 on 25 Nov in Los Angeles.
    const out = normalise(f, { cmdb_ci: { id: 'svc1' }, outage_start: '2026-11-26 08:09:36' }, { personZone: 'Pacific/Auckland' })
    expect(out.values['outage_start']).toBe('2026-11-25 11:09:36')
    expect(out.warnings).toEqual([])
  })
  it('writes ISO with offset or UTC when the application wants it', () => {
    const t = readDateTime('2026-11-26T08:30', 'Pacific/Auckland')!
    expect(writeDateTime(t, 'Pacific/Auckland', 'iso_offset')).toBe('2026-11-26T08:30:00+13:00')
    expect(writeDateTime(t, 'UTC', 'iso_utc')).toBe('2026-11-25T19:30:00Z')
    expect(readDateTime('2026-11-25T19:30:00Z', 'Asia/Tokyo')).toBe(t)
    // Across a daylight-saving change: 1 Jul in Auckland is +12.
    expect(writeDateTime(readDateTime('2026-07-01 09:00', 'Pacific/Auckland')!, 'UTC', 'iso_utc')).toBe('2026-06-30T21:00:00Z')
  })
  it('warns when the form has no zone instead of silently shifting', () => {
    const f: FormSpec = { id: 'x', title: 'X', questions: [{ name: 'at', label: 'When', kind: 'date_time', required: true }] }
    const out = normalise(f, { at: '2026-11-26 08:00' }, { personZone: 'Pacific/Auckland' })
    expect(out.values['at']).toBe('2026-11-25 19:00:00')
    expect(out.warnings[0]).toContain('no time zone')
  })
  it('multi-choice, boolean and number in each application\'s style', () => {
    const jira = fromDefinition(JIRA_DEF, JIRA_MAP).form
    expect(normalise(jira, { summary: 'x', components: 'Mail, web', priority: 'high' }).values).toEqual({ summary: 'x', components: ['10', '11'], priority: '2' })
    const sp = { ...fromDefinition(SP_DEF, SP_MAP).form, formats: { boolean: 'json' as const } }
    expect(normalise(sp, { Title: 't', Done: 'yes', Severity: 'High' }).values).toEqual({ Title: 't', Done: true, Severity: 'High' })
  })
  it('summarises in the person\'s words, not ids', () => {
    expect(summarise(sn(), { cmdb_ci: { id: 'svc1', label: 'Email' }, failure_mode: 'launch' }).map((s) => s.answer)).toEqual(['Email', 'Application will not launch/cannot start'])
  })
})

describe('MCP elicitation', () => {
  it('builds a form-mode request: titled enums, date-time format, lookups asked in words', () => {
    const req = toElicitation(sn(), {})
    expect(req.requestedSchema.required).toEqual(['cmdb_ci'])
    expect(Object.keys(req.requestedSchema.properties)).toEqual(['cmdb_ci', 'outage_start', 'failure_mode'])
    expect(req.requestedSchema.properties['failure_mode']).toMatchObject({ type: 'string', oneOf: [{ const: 'launch', title: 'Application will not launch/cannot start' }, { const: 'message', title: 'Application gives error message' }] })
    expect(req.requestedSchema.properties['outage_start']).toMatchObject({ type: 'string', format: 'date-time' })
    expect(req.requestedSchema.properties['cmdb_ci']).toMatchObject({ type: 'string' })
  })
  it('reads accept, decline and cancel', () => {
    expect(fromElicitation(sn(), { action: 'accept', content: { cmdb_ci: 'Email', junk: 'x' } })).toEqual({ status: 'answered', answers: { cmdb_ci: 'Email' } })
    expect(fromElicitation(sn(), { action: 'decline' }).status).toBe('declined')
  })
})

describe('guidedSubmit', () => {
  const services = [{ id: 's1', label: 'Email' }, { id: 's2', label: 'Email Archive' }, { id: 's3', label: 'E-Commerce' }]
  const resolve = async (_q: unknown, w: string) => services.filter((s) => s.label.toLowerCase().includes(w.toLowerCase()))

  it('asks, resolves the lookup, follows the rule, confirms and submits', async () => {
    const asked: string[][] = []
    const replies = [{ cmdb_ci: 'email', failure_mode: 'message', outage_start: '2026-11-26 08:09' }, { error_message: '0x800CCC0E' }]
    let submitted: unknown
    const r = await guidedSubmit({
      form: sn(), personZone: 'Pacific/Auckland', resolve,
      ask: async (req) => { asked.push(Object.keys(req.requestedSchema.properties)); return { action: 'accept', content: replies.shift() } },
      confirm: async (s) => s.length === 4,
      submit: async (v) => { submitted = v; return 'INC0010009' },
    })
    expect(r.status).toBe('submitted')
    expect(asked).toEqual([['cmdb_ci', 'outage_start', 'failure_mode'], ['error_message']])
    expect(submitted).toEqual({ cmdb_ci: 's1', outage_start: '2026-11-25 11:09:00', failure_mode: 'message', error_message: '0x800CCC0E' })
  })
  it('an ambiguous lookup is asked again as a choice between the matches', async () => {
    const seen: unknown[] = []
    const replies = [{ cmdb_ci: 'Mail' }, { cmdb_ci: 's2' }]
    const r = await guidedSubmit({
      form: sn(), resolve, askOptional: false,
      ask: async (req) => { seen.push(req.requestedSchema.properties['cmdb_ci']); return { action: 'accept', content: replies.shift() } },
      confirm: async () => true, submit: async (v) => v,
    })
    expect(r.status).toBe('submitted')
    expect((seen[1] as { oneOf: unknown[] }).oneOf).toEqual([{ const: 's1', title: 'Email' }, { const: 's2', title: 'Email Archive' }])
    expect(r.status === 'submitted' && r.values['cmdb_ci']).toBe('s2')
  })
  it('never submits without a yes, and stops when the person declines', async () => {
    let calls = 0
    const base = { form: sn(), resolve, askOptional: false, submit: async () => { calls++; return 1 } }
    expect((await guidedSubmit({ ...base, ask: async () => ({ action: 'accept', content: { cmdb_ci: 'E-Commerce' } }), confirm: async () => false })).status).toBe('not_confirmed')
    expect((await guidedSubmit({ ...base, ask: async () => ({ action: 'decline' }), confirm: async () => true })).status).toBe('declined')
    expect(calls).toBe(0)
  })
  it('gives up after the round limit instead of asking forever', async () => {
    const r = await guidedSubmit({ form: sn(), resolve, maxRounds: 2, ask: async () => ({ action: 'accept', content: {} }), confirm: async () => true, submit: async () => 1 })
    expect(r.status).toBe('gave_up')
  })
})
