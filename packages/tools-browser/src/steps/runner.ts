// SPDX-License-Identifier: MIT
/**
 * Run UI steps written as data. A connector pack declares them for work no API can do, and this runner carries them
 * out the same way for every application. Fields are found by their visible label, buttons by their name and
 * options by their text. Those are the words a form definition already gives over the API, so a pack names no
 * selectors.
 *
 * The runner owns the safety rules:
 * - only allowlisted hosts;
 * - a step limit;
 * - no secret-shaped values typed;
 * - every step logged as evidence.
 *
 * The driver owns how it is done in a real browser.
 */

/** One step. Exactly one action key per step. */
export type UiStep =
  | { goto: string }
  | { fill: string; value: string }
  | { choose: string; label?: string } // choose an option by its text; `label` names the question, when given
  | { pick: string; value: string } // a typeahead or lookup: type, then choose the suggestion with exactly this text
  | { check: string; value: boolean }
  | { click: string }
  | { expect: string; output?: string; timeoutMs?: number } // a pattern that must appear; `output` keeps the match
  | { read: string; output: string } // the text of the region labelled so
  | { fillForm: true } // expand the answered questions (RunOptions.answers) into fill/choose/pick/check steps

/** An answered question, in the words the person sees: the label and the answer's display text. */
export type AnsweredQuestion = { label: string; kind: string; answer: string }

/** How a real browser does each step. `playwrightDriver` is the one this package ships. */
export interface StepDriver {
  goto(url: string): Promise<void>
  /** The current page's address, checked against the allowlist after every step. */
  url(): string
  fill(label: string, value: string): Promise<void>
  choose(option: string, question?: string): Promise<void>
  pick(label: string, value: string): Promise<void>
  check(label: string, value: boolean): Promise<void>
  click(name: string): Promise<void>
  /** Wait until the pattern appears in the page text; the first match, or undefined after the timeout. */
  waitForText(pattern: RegExp, timeoutMs: number): Promise<string | undefined>
  readRegion(label: string): Promise<string | undefined>
}

export type RunOptions = {
  /** Hosts the steps may visit; anything else stops the run. */
  allowHosts: string[]
  /** Placeholders `{name}` in step text are filled from here (values only, never selectors). */
  vars?: Record<string, string>
  answers?: AnsweredQuestion[]
  maxSteps?: number
  /** Called after each step, for evidence (screenshots, traces) kept by the caller. */
  onStep?: (entry: StepLog) => Promise<void> | void
}

export type StepLog = { index: number; action: string; target: string; ok: boolean; why?: string; seen?: string; url: string }
export type RunResult = { ok: boolean; log: StepLog[]; outputs: Record<string, string>; stoppedAt?: number }

// Values that look like credentials are never typed by a step: they belong to the sign-in path, not to the model.
const SECRET = /^(?:eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+|(?:sk|pk|ghp|gho|xox[abp])[-_][\w-]{16,}|-----BEGIN [A-Z ]+-----)/

/** Turn answered questions into steps by kind: lookups and people are picked, choices chosen, the rest typed. */
export function stepsForAnswers(answers: AnsweredQuestion[]): UiStep[] {
  return answers.map((a): UiStep => {
    switch (a.kind) {
      case 'lookup': case 'person': return { pick: a.label, value: a.answer }
      case 'choice': return { choose: a.answer, label: a.label }
      case 'boolean': return { check: a.label, value: /^(true|yes|y)$/i.test(a.answer.trim()) }
      default: return { fill: a.label, value: a.answer }
    }
  })
}

const fillVars = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(vars[k] ?? ''))

function hostAllowed(url: string, allow: string[]): boolean {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  return allow.some((h) => { const a = h.toLowerCase(); return host === a || (a.startsWith('*.') && host.endsWith(a.slice(1))) })
}

/** Run the steps in order. Stops at the first failure; never retries a write. */
export async function runSteps(driver: StepDriver, steps: UiStep[], opts: RunOptions): Promise<RunResult> {
  const vars = opts.vars ?? {}
  const expanded = steps.flatMap((s) => ('fillForm' in s ? stepsForAnswers(opts.answers ?? []) : [s]))
  const max = opts.maxSteps ?? 50
  const log: StepLog[] = []
  const outputs: Record<string, string> = {}
  if (expanded.length > max) return { ok: false, log: [{ index: 0, action: 'plan', target: `${expanded.length} steps`, ok: false, why: `more than ${max} steps`, url: driver.url() }], outputs, stoppedAt: 0 }
  for (const [index, step] of expanded.entries()) {
    const action = Object.keys(step).find((k) => k !== 'value' && k !== 'label' && k !== 'output' && k !== 'timeoutMs')!
    const target = String((step as Record<string, unknown>)[action])
    const entry: StepLog = { index, action, target, ok: false, url: driver.url() }
    try {
      if ('value' in step && typeof step.value === 'string' && SECRET.test(step.value.trim())) throw new Error('refused: the value looks like a credential')
      if ('goto' in step) {
        const url = fillVars(step.goto, vars)
        if (!hostAllowed(url, opts.allowHosts)) throw new Error(`refused: ${url} is not an allowed host`)
        await driver.goto(url)
      } else if ('fill' in step) await driver.fill(step.fill, step.value)
      else if ('choose' in step) await driver.choose(step.choose, step.label)
      else if ('pick' in step) await driver.pick(step.pick, step.value)
      else if ('check' in step) await driver.check(step.check, step.value)
      else if ('click' in step) await driver.click(step.click)
      else if ('expect' in step) {
        const seen = await driver.waitForText(new RegExp(step.expect), step.timeoutMs ?? 15000)
        if (seen === undefined) throw new Error('not seen')
        entry.seen = seen
        if (step.output) outputs[step.output] = seen
      } else if ('read' in step) {
        const text = await driver.readRegion(step.read)
        if (text === undefined) throw new Error('no region with that label')
        outputs[step.output] = text
      }
      // A click can navigate anywhere: the page must still be on an allowed host.
      if (!hostAllowed(driver.url(), opts.allowHosts)) throw new Error(`refused: the page moved to ${driver.url()}`)
      entry.ok = true
      entry.url = driver.url()
    } catch (e) {
      entry.why = e instanceof Error ? e.message : String(e)
      log.push(entry)
      await opts.onStep?.(entry)
      return { ok: false, log, outputs, stoppedAt: index }
    }
    log.push(entry)
    await opts.onStep?.(entry)
  }
  return { ok: true, log, outputs }
}
