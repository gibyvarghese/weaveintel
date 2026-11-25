// SPDX-License-Identifier: MIT
/**
 * The guided-submit loop, the same for every application:
 * 1. Ask the open questions.
 * 2. Resolve lookups.
 * 3. Re-ask what's wrong or ambiguous.
 * 4. Show the answers in the person's words and get a yes.
 * 5. Submit.
 *
 * Each step that touches the outside world is a callback the caller supplies. Asking might go to an MCP client, a
 * chat card or a Teams card. Resolving lookups and submitting go to a connector operation, picked by role. The loop
 * owns none of them.
 */
import type { Answers, FormSpec, Question, Value } from './spec.js'
import { applicable, nextQuestions, normalise, summarise, validate, type Problem } from './answers.js'
import { fromElicitation, toElicitation, type ElicitationRequest, type ElicitationResult } from './elicitation.js'

export type Candidate = { id: string; label: string }

export type GuidedInput<T> = {
  form: FormSpec
  /** Answers already known (from the conversation or the person's profile). */
  answers?: Answers
  /** Ask the person. The request is MCP elicitation form mode; `problems` says why a question is asked again. */
  ask: (request: ElicitationRequest, ctx: { round: number; problems: Problem[] }) => Promise<ElicitationResult>
  /** Find records for a lookup answer given in words. */
  resolve: (q: Question, words: string) => Promise<Candidate[]>
  /** Show the answers in the person's words. True only on an explicit yes. */
  confirm: (summary: Array<{ question: string; label: string; answer: string }>) => Promise<boolean>
  submit: (values: Record<string, Value>, form: FormSpec) => Promise<T>
  personZone?: string
  now?: () => number
  /** Ask at most this many rounds before giving up (default 4). */
  maxRounds?: number
  /** Ask optional questions in the first round too (default true). */
  askOptional?: boolean
}

export type GuidedResult<T> =
  | { status: 'submitted'; result: T; values: Record<string, Value>; answers: Answers; warnings: string[] }
  | { status: 'declined' | 'cancelled' | 'not_confirmed'; answers: Answers }
  | { status: 'gave_up'; answers: Answers; problems: Problem[] }

export async function guidedSubmit<T>(input: GuidedInput<T>): Promise<GuidedResult<T>> {
  const answers: Answers = { ...(input.answers ?? {}) }
  // A lookup the person named that matched more than one record is asked again as a choice between the matches.
  const narrowed = new Map<string, Candidate[]>()
  let problems: Problem[] = []
  const max = input.maxRounds ?? 4
  for (let round = 1; ; round++) {
    // Resolve every lookup still in words.
    for (const q of input.form.questions) {
      const a = answers[q.name]
      if ((q.kind !== 'lookup' && q.kind !== 'person') || typeof a !== 'string' || a.trim() === '') continue
      const pick = narrowed.get(q.name)?.find((c) => c.id === a || c.label.toLowerCase() === a.trim().toLowerCase())
      if (pick !== undefined) { answers[q.name] = pick; narrowed.delete(q.name); continue }
      const found = await input.resolve(q, a)
      const exact = found.filter((c) => c.label.toLowerCase() === a.trim().toLowerCase())
      if (exact.length === 1 || found.length === 1) { answers[q.name] = exact[0] ?? found[0]!; narrowed.delete(q.name) }
      else { narrowed.set(q.name, found.slice(0, 10)); answers[q.name] = undefined }
    }
    problems = validate(input.form, answers, { personZone: input.personZone ?? 'UTC' }).filter((p) => !narrowed.has(p.question))
    for (const p of problems) answers[p.question] = undefined
    // Round one asks everything open (a form card shows it all). Later rounds ask only what is still required, plus
    // anything answered wrongly or matched ambiguously, even when optional.
    const open = nextQuestions(input.form, answers, { requiredOnly: round > 1 || input.askOptional === false })
    const live = applicable(input.form, answers).questions
    for (const n of [...problems.map((p) => p.question), ...narrowed.keys()]) {
      const q = live.find((x) => x.name === n)
      if (q !== undefined && !open.some((x) => x.name === n)) open.push(q)
    }
    if (open.length === 0) break
    if (round > max) return { status: 'gave_up', answers, problems }
    // Lookups that matched several records are offered as a choice between the matches.
    const asked = open.map((q) => {
      const c = narrowed.get(q.name)
      return c !== undefined && c.length > 0 ? { ...q, kind: 'choice' as const, choices: c.map((x) => ({ label: x.label, value: x.id })), help: `Several matched; pick one.${q.help ? ' ' + q.help : ''}` } : q
    })
    const reply = await input.ask(toElicitation(input.form, answers, { questions: asked }), { round, problems })
    const got = fromElicitation({ ...input.form, questions: asked }, reply)
    if (got.status !== 'answered') return { status: got.status, answers }
    for (const [k, v] of Object.entries(got.answers)) {
      const c = narrowed.get(k)
      answers[k] = c !== undefined ? (c.find((x) => x.id === v) ?? v) : v
      if (c !== undefined && typeof answers[k] === 'object') narrowed.delete(k)
    }
  }
  const out = normalise(input.form, answers, { personZone: input.personZone ?? 'UTC', ...(input.now ? { now: input.now } : {}) })
  if (out.problems.length > 0) return { status: 'gave_up', answers, problems: out.problems }
  if (!(await input.confirm(summarise(input.form, answers)))) return { status: 'not_confirmed', answers }
  const result = await input.submit(out.values, input.form)
  return { status: 'submitted', result, values: out.values, answers, warnings: out.warnings }
}
