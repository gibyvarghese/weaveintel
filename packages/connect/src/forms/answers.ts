// SPDX-License-Identifier: MIT
/**
 * What to ask, whether the answers are acceptable, and what to send. All pure: no network, no clock unless given.
 */
import type { Answer, Answers, Condition, FormSpec, Question, Value } from './spec.js'
import { isZone, readDateTime, writeDateTime } from './zones.js'

const lower = (s: string) => s.trim().toLowerCase()
const isBlank = (a: Answer | undefined) => a === undefined || a === '' || (Array.isArray(a) && a.length === 0)

/** The choice value an answer names: by value or label, case-insensitively. */
export function choiceValue(q: Question, a: string): string | undefined {
  const c = (q.choices ?? []).find((x) => x.value === a) ?? (q.choices ?? []).find((x) => lower(x.label) === lower(a) || lower(x.value) === lower(a))
  return c?.value
}

/** The comparable text of an answer: choice value, lookup id, or the text itself. */
function comparable(q: Question | undefined, a: Answer | undefined): string {
  if (a === undefined) return ''
  if (typeof a === 'object' && !Array.isArray(a)) return a.id
  if (Array.isArray(a)) return a.join(',')
  const s = String(a)
  return q?.choices ? (choiceValue(q, s) ?? s) : s
}

function holds(form: FormSpec, c: Condition, answers: Answers): boolean {
  const q = form.questions.find((x) => x.name === c.question)
  const v = comparable(q, answers[c.question])
  switch (c.op) {
    case 'empty': return v === ''
    case 'not_empty': return v !== ''
    case '=': return v === String(c.value ?? '') || (Array.isArray(answers[c.question]) && (answers[c.question] as string[]).includes(String(c.value)))
    case '!=': return v !== String(c.value ?? '')
  }
}

export type Applicable = { questions: Question[]; required: Set<string>; hidden: Set<string> }

/** Which questions apply given the answers so far, and which of them are required, after the form's rules. */
export function applicable(form: FormSpec, answers: Answers = {}): Applicable {
  const hidden = new Set<string>()
  const required = new Set(form.questions.filter((q) => q.required).map((q) => q.name))
  for (const r of form.rules ?? []) {
    const on = r.when.every((c) => holds(form, c, answers))
    if (on) {
      for (const n of r.hide ?? []) hidden.add(n)
      for (const n of r.show ?? []) hidden.delete(n)
      for (const n of r.require ?? []) required.add(n)
    } else if (r.reverse === true) {
      for (const n of r.show ?? []) hidden.add(n)
      for (const n of r.hide ?? []) hidden.delete(n)
      for (const n of r.require ?? []) required.delete(n)
    }
  }
  for (const n of hidden) required.delete(n)
  return { questions: form.questions.filter((q) => !hidden.has(q.name)), required, hidden }
}

/**
 * What to ask next: applicable questions without an answer, required ones first, each group in form order.
 * Optional questions are included unless `requiredOnly`.
 */
export function nextQuestions(form: FormSpec, answers: Answers = {}, opts: { requiredOnly?: boolean } = {}): Question[] {
  const { questions, required } = applicable(form, answers)
  const open = questions.filter((q) => isBlank(answers[q.name]) && q.kind !== 'attachment')
  const req = open.filter((q) => required.has(q.name))
  return opts.requiredOnly === true ? req : [...req, ...open.filter((q) => !required.has(q.name))]
}

export type Problem = { question: string; label: string; problem: 'required' | 'not_a_choice' | 'not_a_number' | 'not_a_date' | 'not_a_date_time' | 'not_resolved' | 'too_long' | 'not_yes_no'; detail?: string }

const DATE = /^\d{4}-\d{2}-\d{2}$/

function check(q: Question, a: Answer, personZone: string): Problem['problem'] | undefined {
  const one = (s: string): Problem['problem'] | undefined => {
    switch (q.kind) {
      case 'choice': case 'multi_choice': return choiceValue(q, s) === undefined ? 'not_a_choice' : undefined
      case 'number': return s.trim() === '' || Number.isNaN(Number(s)) ? 'not_a_number' : undefined
      case 'date': return DATE.test(s.trim()) && !Number.isNaN(Date.parse(s.trim())) ? undefined : 'not_a_date'
      case 'date_time': return readDateTime(s, personZone) === undefined ? 'not_a_date_time' : undefined
      case 'boolean': return /^(true|false|yes|no|y|n)$/i.test(s.trim()) ? undefined : 'not_yes_no'
      case 'lookup': case 'person': return 'not_resolved'
      default: return q.max !== undefined && s.length > q.max ? 'too_long' : undefined
    }
  }
  if (typeof a === 'object' && !Array.isArray(a)) return q.kind === 'lookup' || q.kind === 'person' ? undefined : 'not_a_choice'
  if (Array.isArray(a)) return a.map(one).find((p) => p !== undefined)
  if (q.kind === 'multi_choice' && typeof a === 'string') return a.split(',').map((x) => x.trim()).filter(Boolean).map(one).find((p) => p !== undefined)
  if (typeof a === 'boolean') return q.kind === 'boolean' ? undefined : one(String(a))
  return one(String(a))
}

/** Every problem with the answers to the questions that apply. Answers to hidden questions are ignored. */
export function validate(form: FormSpec, answers: Answers, ctx: { personZone?: string } = {}): Problem[] {
  const { questions, required } = applicable(form, answers)
  const out: Problem[] = []
  for (const q of questions) {
    const a = answers[q.name]
    if (isBlank(a)) { if (required.has(q.name)) out.push({ question: q.name, label: q.label, problem: 'required' }); continue }
    const p = check(q, a!, ctx.personZone ?? 'UTC')
    if (p !== undefined) out.push({ question: q.name, label: q.label, problem: p })
  }
  return out
}

export type Normalised = { values: Record<string, Value>; problems: Problem[]; warnings: string[] }

/**
 * Turn a person's answers into what the application accepts. Choice labels become values. Lookups become record
 * ids. Yes/no becomes the boolean style. Date-times read in the person's zone are written in the form's zone.
 * Hidden questions are dropped, so a hidden question's stale answer is never sent.
 */
export function normalise(form: FormSpec, answers: Answers, ctx: { personZone?: string; now?: () => number } = {}): Normalised {
  const personZone = ctx.personZone ?? 'UTC'
  const problems = validate(form, answers, { personZone })
  const warnings: string[] = []
  if (!isZone(personZone)) warnings.push(`"${personZone}" is not a known time zone; date-times read as UTC`)
  const formZone = form.timeZone !== undefined && isZone(form.timeZone) ? form.timeZone : undefined
  const fmt = form.formats ?? {}
  const values: Record<string, Value> = {}
  const bad = new Set(problems.map((p) => p.question))
  for (const q of applicable(form, answers).questions) {
    const a = answers[q.name]
    if (isBlank(a) || bad.has(q.name)) continue
    const texts = Array.isArray(a) ? a : typeof a === 'string' && q.kind === 'multi_choice' ? a.split(',').map((s) => s.trim()).filter(Boolean) : undefined
    switch (q.kind) {
      case 'choice': values[q.name] = choiceValue(q, String(a))!; break
      case 'multi_choice': {
        const vs = (texts ?? [String(a)]).map((s) => choiceValue(q, s)!)
        values[q.name] = fmt.multi === 'comma' ? vs.join(',') : vs
        break
      }
      case 'lookup': case 'person': values[q.name] = (a as { id: string }).id; break
      case 'boolean': {
        const yes = typeof a === 'boolean' ? a : /^(true|yes|y)$/i.test(String(a).trim())
        values[q.name] = fmt.boolean === 'json' ? yes : String(yes)
        break
      }
      case 'number': values[q.name] = fmt.number === 'json' ? Number(a) : String(Number(a)); break
      case 'date': values[q.name] = String(a).trim(); break
      case 'date_time': {
        const instant = readDateTime(String(a), isZone(personZone) ? personZone : 'UTC', ctx.now)!
        if (formZone === undefined) warnings.push(`"${q.label}": the form has no time zone; sent as ${fmt.dateTime === 'local' || fmt.dateTime === undefined ? 'UTC wall-clock time' : 'UTC'}`)
        values[q.name] = writeDateTime(instant, formZone ?? 'UTC', fmt.dateTime ?? 'local')
        break
      }
      default: values[q.name] = String(a)
    }
  }
  return { values, problems, warnings }
}

/** The answers in the person's words, for the confirmation before a write: labels, not ids. */
export function summarise(form: FormSpec, answers: Answers): Array<{ question: string; label: string; answer: string }> {
  return applicable(form, answers).questions.filter((q) => !isBlank(answers[q.name])).map((q) => {
    const a = answers[q.name]!
    const text = typeof a === 'object' && !Array.isArray(a) ? (a.label ?? a.id)
      : Array.isArray(a) ? a.map((s) => (q.choices ?? []).find((c) => c.value === choiceValue(q, s))?.label ?? s).join(', ')
      : q.choices ? ((q.choices.find((c) => c.value === choiceValue(q, String(a)))?.label) ?? String(a)) : String(a)
    return { question: q.name, label: q.label, answer: text }
  })
}
