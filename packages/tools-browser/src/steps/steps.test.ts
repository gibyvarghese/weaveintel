// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { playwrightDriver, runSteps, stepsForAnswers, type StepDriver } from './index.js'

/** An in-memory page: labelled fields, options, buttons and a result text. */
function fakePage(start = 'https://app.example.test/form') {
  const state = { url: start, fields: {} as Record<string, string | boolean>, chosen: [] as string[], clicked: [] as string[], text: '' }
  const driver: StepDriver = {
    goto: async (u) => { state.url = u },
    url: () => state.url,
    fill: async (l, v) => { if (l === 'Missing') throw new Error('no field'); state.fields[l] = v },
    choose: async (o) => { state.chosen.push(o) },
    pick: async (l, v) => { state.fields[l] = `picked:${v}` },
    check: async (l, v) => { state.fields[l] = v },
    click: async (n) => { state.clicked.push(n); if (n === 'Submit') state.text = 'Thank you. Record INC0010042 created.'; if (n === 'Leave') state.url = 'https://evil.example.com/' },
    waitForText: async (p) => p.exec(state.text)?.[0],
    readRegion: async (l) => (l === 'Status' ? 'New' : undefined),
  }
  return { state, driver }
}

describe('runSteps', () => {
  it('fills a form from answered questions, submits and keeps the record number', async () => {
    const { state, driver } = fakePage()
    const r = await runSteps(driver, [
      { goto: 'https://app.example.test/item/{id}' }, { fillForm: true }, { click: 'Submit' },
      { expect: 'INC\\d{7}', output: 'number' }, { read: 'Status', output: 'status' },
    ], {
      allowHosts: ['app.example.test'], vars: { id: 'p1' },
      answers: [
        { label: 'What application is down?', kind: 'lookup', answer: 'Email' },
        { label: 'Nature of outage', kind: 'choice', answer: 'Shows an error' },
        { label: 'Urgent', kind: 'boolean', answer: 'yes' },
        { label: 'Details', kind: 'text', answer: 'error 0x800CCC0E' },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.outputs).toEqual({ number: 'INC0010042', status: 'New' })
    expect(state.url).toBe('https://app.example.test/item/p1')
    expect(state.fields).toEqual({ 'What application is down?': 'picked:Email', Urgent: true, Details: 'error 0x800CCC0E' })
    expect(state.chosen).toEqual(['Shows an error'])
    expect(r.log.map((l) => l.action)).toEqual(['goto', 'pick', 'choose', 'check', 'fill', 'click', 'expect', 'read'])
  })
  it('refuses a host outside the allowlist, before and after navigation', async () => {
    const a = await runSteps(fakePage().driver, [{ goto: 'https://other.example.com/' }], { allowHosts: ['app.example.test'] })
    expect(a.ok).toBe(false)
    expect(a.log[0]!.why).toContain('not an allowed host')
    const b = await runSteps(fakePage().driver, [{ click: 'Leave' }, { fill: 'x', value: 'y' }], { allowHosts: ['*.example.test'] })
    expect(b.stoppedAt).toBe(0)
    expect(b.log[0]!.why).toContain('moved to')
  })
  it('never types a credential-shaped value', async () => {
    const { state, driver } = fakePage()
    const r = await runSteps(driver, [{ fill: 'Note', value: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc' }], { allowHosts: ['app.example.test'] })
    expect(r.ok).toBe(false)
    expect(state.fields).toEqual({})
  })
  it('stops at the first failure and never runs later steps', async () => {
    const { state, driver } = fakePage()
    const r = await runSteps(driver, [{ fill: 'Missing', value: 'x' }, { click: 'Submit' }], { allowHosts: ['app.example.test'] })
    expect(r).toMatchObject({ ok: false, stoppedAt: 0 })
    expect(state.clicked).toEqual([])
  })
  it('refuses a plan longer than the step limit', async () => {
    const r = await runSteps(fakePage().driver, Array.from({ length: 6 }, () => ({ click: 'x' })), { allowHosts: ['app.example.test'], maxSteps: 5 })
    expect(r.ok).toBe(false)
    expect(r.log[0]!.why).toContain('more than 5')
  })
  it('maps question kinds to steps', () => {
    expect(stepsForAnswers([{ label: 'Owner', kind: 'person', answer: 'Abel Tuter' }, { label: 'When', kind: 'date_time', answer: '2026-11-26 08:30' }]))
      .toEqual([{ pick: 'Owner', value: 'Abel Tuter' }, { fill: 'When', value: '2026-11-26 08:30' }])
  })
})

// A real browser against a local page shaped like a portal form: a labelled typeahead (with a decoy combobox in the
// header), radios, a text box and a Submit button that shows a record number.
const PAGE = `<!doctype html><html><body>
<header><input role="combobox" aria-label="Search the site" id="decoy"></header>
<form onsubmit="event.preventDefault(); document.getElementById('done').textContent = 'Thank you. Record INC0010043 created for ' + document.getElementById('svc').value + ' / ' + document.querySelector('input[name=mode]:checked').value + ' / ' + document.getElementById('err').value">
  <label for="svc">What application is down?</label>
  <div role="combobox" aria-haspopup="listbox"><input id="svc" autocomplete="off"
    oninput="const l=document.getElementById('list'); l.innerHTML=''; ['Email','Email Archive','E-Commerce'].filter(x=>x.toLowerCase().includes(this.value.toLowerCase())).forEach(x=>{const o=document.createElement('li'); o.setAttribute('role','option'); o.textContent=x; o.onclick=()=>{document.getElementById('svc').value=x; l.innerHTML=''}; l.appendChild(o)})"></div>
  <ul role="listbox" id="list"></ul>
  <fieldset role="radiogroup" aria-label="Nature of outage">
    <label><input type="radio" name="mode" value="launch">Will not start</label>
    <label><input type="radio" name="mode" value="message">Shows an error</label>
  </fieldset>
  <label for="err">The error message</label><input id="err">
  <button type="submit">Submit</button>
</form><p id="done"></p></body></html>`

const haveBrowser = (() => { try { return existsSync(chromium.executablePath()) } catch { return false } })()

describe.skipIf(!haveBrowser)('playwrightDriver against a real page', () => {
  it('fills by label, picks from a typeahead past a decoy combobox, chooses a radio and submits', async () => {
    const server = createServer((_q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)).listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const r = await runSteps(playwrightDriver(page), [
        { goto: `${base}/form` }, { fillForm: true }, { click: 'Submit' }, { expect: 'INC\\d{7} created for .*', output: 'result' },
      ], {
        allowHosts: ['127.0.0.1'],
        answers: [
          { label: 'What application is down?', kind: 'lookup', answer: 'Email' },
          { label: 'Nature of outage', kind: 'choice', answer: 'Shows an error' },
          { label: 'The error message', kind: 'text', answer: 'error 0x800CCC0E' },
        ],
      })
      expect(r.log.filter((l) => !l.ok)).toEqual([])
      expect(r.outputs['result']).toBe('INC0010043 created for Email / message / error 0x800CCC0E')
      expect(await page.locator('#decoy').inputValue()).toBe('')
    } finally {
      await browser.close()
      server.close()
    }
  }, 30000)
})
