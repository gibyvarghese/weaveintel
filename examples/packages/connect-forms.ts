/**
 * Example: asking a person an application's form, the same way for every application
 *
 * `@weaveintel/connect/forms` turns an application's own form definition into one neutral FormSpec. The examples
 * here are a ServiceNow record producer, Jira create metadata and SharePoint list columns. The mapping that does it
 * is data a connector pack ships, not code. From there everything is generic:
 * - what to ask next, after the form's own show/hide/require rules;
 * - asking through MCP elicitation (form mode), which any MCP client, chat card or Teams card can render;
 * - resolving lookups such as "Email" to a record id;
 * - checking answers;
 * - converting the person's local time into the zone the application stores it in;
 * - getting an explicit yes before submitting.
 *
 * Reach for it when an agent must fill in a form in another system for a person. In memory, no keys, no network:
 * the asker, lookup and submit are plain functions here. In a product they are an MCP client or chat surface and
 * connector operations.
 *
 * Run: npx tsx examples/packages/connect-forms.ts
 */
import assert from 'node:assert/strict'
import { fromDefinition, guidedSubmit, nextQuestions, normalise, toElicitation, type FormMapping } from '@weaveintel/connect/forms'

// ─── 1. Three applications, three definitions, one FormSpec ────────────────────────────────────────────────────
// A ServiceNow record producer, as its catalogue API answers (trimmed).
const serviceNowItem = {
  sys_id: 'p1', name: 'Report Outage', item_type: 'record_producer',
  variables: [
    { name: 'service', label: 'What application is down?', friendly_type: 'reference', mandatory: true, reference: 'cmdb_ci_service' },
    { name: 'started', label: 'When did it start?', friendly_type: 'date_time', default_value: 'javascript:gs.nowDateTime()' },
    { name: 'mode', label: 'Nature of outage', friendly_type: 'multiple_choice', choices: [{ label: 'Will not start', value: 'launch' }, { label: 'Shows an error', value: 'message' }] },
    { name: 'error', label: 'The error message', friendly_type: 'single_line_text' },
  ],
  ui_policies: [{ short_description: 'Ask for the error', reverse: true, conditions: [{ field: 'IO:m', oper: '=', value: 'message' }], actions: [{ name: 'IO:e', visible: 'true', mandatory: 'true' }] }],
}
// The pack's mapping for it: data, shipped with the ServiceNow pack.
const serviceNowMapping: FormMapping = {
  id: 'sys_id', title: 'name', variant: 'item_type', questions: 'variables', kind: 'friendly_type',
  kinds: { reference: 'lookup', date_time: 'date_time', multiple_choice: 'choice', single_line_text: 'text' },
  fields: { name: 'name', label: 'label', required: 'mandatory', default: 'default_value', choices: 'choices', lookup: 'reference' },
  ignoreDefaults: '^\\s*javascript:', // computed defaults are the application's to fill, never sent back
  rules: { at: 'ui_policies', when: 'conditions', question: 'field', op: 'oper', value: 'value', ops: { '=': '=' }, actions: 'actions', actionQuestion: 'name', show: 'visible', require: 'mandatory', reverse: 'reverse', note: 'short_description' },
}
// The submitting account's zone, read from the application (role person.zone), not the person's.
const { form } = fromDefinition(serviceNowItem, serviceNowMapping, { ids: { 'IO:m': 'mode', 'IO:e': 'error' }, timeZone: 'America/Los_Angeles', formats: { dateTime: 'local' } })
assert.deepEqual(form.questions.map((q) => `${q.name}:${q.kind}`), ['service:lookup', 'started:date_time', 'mode:choice', 'error:text'])
assert.equal(form.questions[1]!.default, undefined, 'the javascript: default is not carried')

// Jira create metadata and SharePoint list columns go through their own mappings into the same shape.
const jira = fromDefinition(
  { fields: [{ fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } }, { fieldId: 'priority', name: 'Priority', schema: { type: 'priority' }, allowedValues: [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }] }] },
  { questions: 'fields', kind: 'schema.type', kinds: { string: 'text', priority: 'choice' }, fields: { name: 'fieldId', label: 'name', required: 'required', choices: 'allowedValues' }, choice: { label: 'name', value: 'id' } },
).form
const sharePoint = fromDefinition(
  { value: [{ name: 'Title', displayName: 'Title', required: true, text: {} }, { name: 'Severity', displayName: 'Severity', choice: { choices: ['Low', 'High'] } }] },
  { questions: 'value', kindFacets: ['text', 'choice'], kinds: { text: 'text', choice: 'choice' }, fields: { name: 'name', label: 'displayName', required: 'required', choices: 'choice.choices' } },
).form
assert.deepEqual(jira.questions.map((q) => q.kind), ['text', 'choice'])
assert.deepEqual(sharePoint.questions[1]!.choices, [{ label: 'Low', value: 'Low' }, { label: 'High', value: 'High' }])
assert.deepEqual(normalise(jira, { summary: 'Mail down', priority: 'high' }).values, { summary: 'Mail down', priority: '2' })

// ─── 2. What to ask, and how ────────────────────────────────────────────────────────────────────────────────────
// The error question is hidden until "Shows an error" is chosen, then it is required.
assert.deepEqual(nextQuestions(form, {}).map((q) => q.name), ['service', 'started', 'mode'])
assert.deepEqual(nextQuestions(form, { mode: 'Shows an error' }).map((q) => q.name), ['service', 'error', 'started'])
// The ask is a standard MCP elicitation request (form mode): titled choices, a date-time format, required list.
const ask = toElicitation(form, {})
assert.deepEqual(ask.requestedSchema.required, ['service'])
assert.deepEqual(ask.requestedSchema.properties['mode'], { title: 'Nature of outage', type: 'string', oneOf: [{ const: 'launch', title: 'Will not start' }, { const: 'message', title: 'Shows an error' }] })

// ─── 3. The whole conversation ──────────────────────────────────────────────────────────────────────────────────
// A scripted person in Auckland. Round 1 answers what was asked; the rule then asks for the error text.
const replies: Array<Record<string, unknown>> = [{ service: 'email', started: '2026-11-26 08:09', mode: 'message' }, { error: 'error 0x800CCC0E' }]
const services = [{ id: 'svc-email', label: 'Email' }, { id: 'svc-shop', label: 'E-Commerce' }]
let confirmed: string[] = []
const result = await guidedSubmit({
  form,
  personZone: 'Pacific/Auckland',
  ask: async () => ({ action: 'accept', content: replies.shift() }),
  resolve: async (_q, words) => services.filter((s) => s.label.toLowerCase().includes(words.toLowerCase())),
  confirm: async (summary) => { confirmed = summary.map((s) => `${s.label}: ${s.answer}`); return true },
  submit: async (values) => ({ number: 'INC0001', values }),
})
assert.equal(result.status, 'submitted')
if (result.status !== 'submitted') throw new Error('unreachable')
// The person confirmed in their own words; the application gets ids, values and its own zone.
assert.deepEqual(confirmed, ['What application is down?: Email', 'When did it start?: 2026-11-26 08:09', 'Nature of outage: Shows an error', 'The error message: error 0x800CCC0E'])
// 08:09 on 26 Nov in Auckland is 11:09 on 25 Nov in Los Angeles; sending "08:09" would store a moment 21 hours off.
assert.deepEqual(result.values, { service: 'svc-email', started: '2026-11-25 11:09:00', mode: 'message', error: 'error 0x800CCC0E' })

console.log('connect/forms: three applications mapped to one form; asked, resolved, converted, confirmed and submitted.')
