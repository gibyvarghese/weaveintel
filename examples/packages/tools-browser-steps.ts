/**
 * Example: doing in a browser what no API can, from steps written as data
 *
 * Some work in a business application has no API, or the API isn't safe to use: a portal form, a layout designer,
 * a vendor admin page. `@weaveintel/tools-browser/steps` runs that work from steps a connector pack declares as
 * data. The runner finds things the way assistive technology does:
 * - fields by their visible label;
 * - buttons by their name;
 * - options by their text.
 *
 * So a pack names no selectors, and the labels are the ones the form definition already gives over the API.
 *
 * Every run is held to the same rules:
 * - only allowlisted hosts, checked after every click as well;
 * - a step limit;
 * - no credential-shaped value is ever typed;
 * - every step is logged for evidence.
 *
 * Reach for it when an agent must act in an application through its UI, after the API has been ruled out.
 *
 * In memory, no browser, no network: the driver below is a stand-in page. In a product, pass
 * `playwrightDriver(page)` for a page in a sandboxed browser that belongs to one tenant, one connection and one run.
 *
 * Run: npx tsx examples/packages/tools-browser-steps.ts
 */
import assert from 'node:assert/strict'
import { runSteps, stepsForAnswers, type StepDriver, type UiStep } from '@weaveintel/tools-browser/steps'

// ─── A stand-in page: a portal form with a lookup, radios, a text box and a Submit button ──────────────────────
const page = { url: 'about:blank', values: {} as Record<string, string>, done: '' }
const driver: StepDriver = {
  goto: async (u) => { page.url = u },
  url: () => page.url,
  fill: async (label, value) => { page.values[label] = value },
  pick: async (label, value) => { if (!['Email', 'E-Commerce'].includes(value)) throw new Error(`no suggestion "${value}"`); page.values[label] = value },
  choose: async (option, question) => { page.values[question ?? '?'] = option },
  check: async (label, value) => { page.values[label] = String(value) },
  click: async (name) => { if (name === 'Submit') page.done = `Thank you. Record INC0010044 created.` },
  waitForText: async (p) => p.exec(page.done)?.[0],
  readRegion: async () => undefined,
}

// ─── 1. The pack's UI operation: data, declared beside its API operations ──────────────────────────────────────
// "Submit a catalogue form through the portal" for a form whose API submit fails or does not exist.
const submitThroughPortal: UiStep[] = [
  { goto: 'https://acme.service-now.example/sp?id=sc_cat_item&sys_id={item}' },
  { fillForm: true }, // the person's answered questions, turned into steps by kind
  { click: 'Submit' },
  { expect: '(INC|REQ|RITM)\\d{7}', output: 'number' },
]

// ─── 2. The answers, in the person's words (labels and display text, as a form confirmation shows them) ──────
const answers = [
  { label: 'What application is down?', kind: 'lookup', answer: 'Email' },
  { label: 'Nature of outage', kind: 'choice', answer: 'Shows an error' },
  { label: 'The error message', kind: 'text', answer: 'error 0x800CCC0E' },
]
assert.deepEqual(stepsForAnswers(answers), [
  { pick: 'What application is down?', value: 'Email' },
  { choose: 'Shows an error', label: 'Nature of outage' },
  { fill: 'The error message', value: 'error 0x800CCC0E' },
])

const run = await runSteps(driver, submitThroughPortal, { allowHosts: ['acme.service-now.example'], vars: { item: 'p1' }, answers })
assert.equal(run.ok, true)
assert.equal(run.outputs['number'], 'INC0010044')
assert.deepEqual(page.values, { 'What application is down?': 'Email', 'Nature of outage': 'Shows an error', 'The error message': 'error 0x800CCC0E' })
assert.deepEqual(run.log.map((l) => `${l.action}:${l.ok}`), ['goto:true', 'pick:true', 'choose:true', 'fill:true', 'click:true', 'expect:true'])

// ─── 3. The rules hold whatever the steps say ──────────────────────────────────────────────────────────────────
const offHost = await runSteps(driver, [{ goto: 'https://somewhere-else.example/' }], { allowHosts: ['acme.service-now.example'] })
assert.equal(offHost.ok, false)
assert.match(offHost.log[0]!.why!, /not an allowed host/)

const secret = await runSteps(driver, [{ fill: 'Notes', value: '-----BEGIN PRIVATE KEY-----' }], { allowHosts: ['acme.service-now.example'] })
assert.equal(secret.ok, false, 'credential-shaped values are never typed')

const wrong = await runSteps(driver, [{ pick: 'What application is down?', value: 'Payroll' }, { click: 'Submit' }], { allowHosts: ['acme.service-now.example'] })
assert.equal(wrong.stoppedAt, 0, 'a failed step stops the run before anything is submitted')

console.log('tools-browser/steps: a portal form filled by label and submitted; hosts, secrets and failures held to the rules.')
