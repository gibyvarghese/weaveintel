// SPDX-License-Identifier: MIT
/**
 * The Playwright driver for UI steps. It finds everything the way assistive technology does:
 * - fields by their accessible label (`getByLabel`);
 * - buttons by role and name;
 * - options by their text.
 *
 * That works across applications without per-application selectors. Quirks found on real applications are handled
 * here once (live on a ServiceNow portal, 2026-11-26):
 * - **Typeahead controls** open from the control nearest the label, never "the first combobox on the page", because
 *   page headers have comboboxes too. Typing goes to whichever element takes focus.
 * - **Framework-bound inputs** get the events a person's typing causes; Playwright's `fill` already does this.
 */
import type { Page } from 'playwright-core'
import type { StepDriver } from './runner.js'

const exact = (s: string) => new RegExp(`^\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i')

export function playwrightDriver(page: Page): StepDriver {
  const field = (label: string) => page.getByLabel(label, { exact: false }).first()
  return {
    async goto(url) { await page.goto(url, { waitUntil: 'domcontentloaded' }) },
    url: () => page.url(),
    async fill(label, value) { await field(label).fill(value) },
    async choose(option, question) {
      const scope = question !== undefined ? page.getByRole('radiogroup', { name: question }).or(page.getByRole('group', { name: question })) : page
      const radio = scope.getByRole('radio', { name: exact(option) }).or(scope.getByLabel(exact(option)))
      if ((await radio.count()) > 0) { await radio.first().check(); return }
      // A select box: choose the option whose text matches.
      if (question !== undefined) { await field(question).selectOption({ label: option }); return }
      throw new Error(`no option "${option}"`)
    },
    async pick(label, value) {
      const input = field(label)
      const editable = () => page.evaluate(() => { const a = document.activeElement as HTMLElement | null; return a !== null && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable) })
      // Click the field itself first. Libraries that hide the real input behind an off-screen "focusser"
      // (select2, chosen) open from their own control instead: the nearest owner of this field, never another
      // combobox on the page.
      await input.click({ timeout: 2000 }).catch(() => undefined)
      if (!(await editable())) {
        const owner = input.locator('xpath=ancestor-or-self::*[@role="combobox" or @aria-haspopup or contains(@class,"select2-container")][1]')
        if ((await owner.count()) > 0) {
          const trigger = owner.first().locator('a, [role="button"]')
          await ((await trigger.count()) > 0 ? trigger.first() : owner.first()).click()
        }
      }
      if (!(await editable())) throw new Error(`"${label}" did not take typing`)
      await page.keyboard.type(value, { delay: 20 })
      const option = page.getByRole('option', { name: exact(value) }).or(page.locator('.select2-result-label', { hasText: exact(value) }))
      await option.first().waitFor({ state: 'visible', timeout: 8000 })
      await option.first().click()
    },
    async check(label, value) { await field(label).setChecked(value) },
    async click(name) { await page.getByRole('button', { name: exact(name) }).or(page.getByRole('link', { name: exact(name) })).first().click() },
    async waitForText(pattern, timeoutMs) {
      const end = Date.now() + timeoutMs
      while (Date.now() < end) {
        const m = pattern.exec(await page.locator('body').innerText().catch(() => ''))
        if (m !== null) return m[0]
        await page.waitForTimeout(250)
      }
      return undefined
    },
    async readRegion(label) {
      const r = page.getByRole('region', { name: label }).or(page.getByLabel(label))
      return (await r.count()) > 0 ? (await r.first().innerText()).trim() : undefined
    },
  }
}
