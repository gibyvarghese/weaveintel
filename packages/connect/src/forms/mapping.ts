// SPDX-License-Identifier: MIT
/**
 * From an application's own form definition to a FormSpec, driven by a declarative mapping that the connector pack
 * ships as data. No application knowledge lives here: a ServiceNow catalogue item, Jira create metadata and
 * SharePoint list columns each become a FormSpec through their own mapping (see the example in
 * examples/packages/connect-forms.ts).
 */
import { QUESTION_KINDS, type AnswerFormats, type Choice, type Condition, type FormSpec, type Question, type QuestionKind, type Rule } from './spec.js'

/** A path into the definition: `a.b.c`. `x|y` takes the first present. `$key` is the key when questions are an object. */
type Path = string

export type FormMapping = {
  id?: Path
  title?: Path
  description?: Path
  /** Where the submit variant is (for example the catalogue item's type). */
  variant?: Path
  /** Where the questions are: an array, or an object keyed by question name (`$key`). */
  questions: Path
  /** Nested questions (containers, sections) under this key are flattened in order. */
  flatten?: string
  /** How to tell the native type: one or more paths joined with ":" (`schema.type` + `schema.items` → `array:option`). */
  kind?: Path | Path[]
  /** Or: the native type is whichever of these keys is present (SharePoint's column facets). */
  kindFacets?: string[]
  /** Native type → kind. `"*"` is the fallback. A type with no entry and no fallback is skipped with a warning. */
  kinds: Record<string, QuestionKind | 'skip'>
  fields: { name: Path; label: Path; required?: Path; help?: Path; default?: Path; choices?: Path; lookup?: Path; max?: Path; readOnly?: Path }
  /** Where a choice's label and value are (default `label`, `value`). Plain strings are their own label and value. */
  choice?: { label: Path; value: Path }
  /** A default matching this pattern is an expression the application computes; it is never carried. */
  ignoreDefaults?: string
  /** Lookup source by native type, for applications that name the lookup by type (Jira's `user`). */
  lookupSources?: Record<string, string>
  rules?: {
    at: Path; when: Path; question: Path; op: Path; value: Path
    /** Native operator → condition operator. Unknown operators drop the rule with a warning. */
    ops: Record<string, Condition['op']>
    actions: Path; actionQuestion: Path
    show?: Path; require?: Path; reverse?: Path; note?: Path
  }
}

const present = (v: unknown) => v !== undefined && v !== null && v !== ''

/** Read a path. `x|y` gives the first present value. */
export function at(obj: unknown, path: Path, key?: string): unknown {
  for (const alt of path.split('|')) {
    if (alt === '$key') { if (key !== undefined) return key; continue }
    let cur: unknown = obj
    for (const part of alt.split('.')) cur = cur !== null && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined
    if (present(cur)) return cur
  }
  return undefined
}

const truthy = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1'
const text = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined)

export type FromDefinitionOptions = {
  /** Native question ids → names, when the definition's rules name questions by id (`IO:<id>`). */
  ids?: Record<string, string>
  /** Extra rules read elsewhere (for example rule actions kept in their own table), already in FormSpec shape. */
  rules?: Rule[]
  timeZone?: string
  formats?: AnswerFormats
}

export function fromDefinition(def: unknown, m: FormMapping, opts: FromDefinitionOptions = {}): { form: FormSpec; warnings: string[] } {
  const warnings: string[] = []
  const rawQs = at(def, m.questions)
  let list: Array<[unknown, string | undefined]> = Array.isArray(rawQs) ? rawQs.map((q) => [q, undefined]) : rawQs !== null && typeof rawQs === 'object' ? Object.entries(rawQs).map(([k, q]) => [q, k]) : []
  if (m.flatten !== undefined) {
    const flat = (xs: Array<[unknown, string | undefined]>): Array<[unknown, string | undefined]> => xs.flatMap(([q, k]) => {
      const kids = (q as Record<string, unknown> | null)?.[m.flatten!]
      return [[q, k] as [unknown, string | undefined], ...(Array.isArray(kids) ? flat(kids.map((c) => [c, undefined])) : [])]
    })
    list = flat(list)
  }
  const questions: Question[] = []
  for (const [q, key] of list) {
    const native = m.kindFacets !== undefined
      ? m.kindFacets.find((f) => present((q as Record<string, unknown>)[f]))
      : (Array.isArray(m.kind) ? m.kind : [m.kind ?? 'type']).map((p) => text(at(q, p))).filter(Boolean).join(':')
    const name = text(at(q, m.fields.name, key))
    const kind = native !== undefined ? (m.kinds[native] ?? m.kinds[native.split(':')[0]!] ?? m.kinds['*']) : m.kinds['*']
    if (kind === 'skip' || name === undefined) continue
    if (kind === undefined || !(QUESTION_KINDS as readonly string[]).includes(kind)) { warnings.push(`"${name}": type "${native ?? '?'}" is not mapped; skipped`); continue }
    if (m.fields.readOnly !== undefined && truthy(at(q, m.fields.readOnly))) continue
    const question: Question = { name, label: text(at(q, m.fields.label)) ?? name, kind, required: m.fields.required !== undefined && truthy(at(q, m.fields.required)) }
    const help = m.fields.help !== undefined ? text(at(q, m.fields.help)) : undefined
    if (help) question.help = help
    const rawChoices = m.fields.choices !== undefined ? at(q, m.fields.choices) : undefined
    if (Array.isArray(rawChoices)) {
      const cm = m.choice ?? { label: 'label', value: 'value' }
      const choices: Choice[] = rawChoices.map((c) => (typeof c === 'string' ? { label: c, value: c } : { label: text(at(c, cm.label)) ?? '', value: text(at(c, cm.value)) ?? '' })).filter((c) => c.value !== '')
      if (choices.length > 0) question.choices = choices
    }
    if (kind === 'lookup' || kind === 'person') {
      const src = (m.fields.lookup !== undefined ? text(at(q, m.fields.lookup)) : undefined) ?? (native !== undefined ? m.lookupSources?.[native] ?? m.lookupSources?.[native.split(':')[0]!] : undefined)
      if (src) question.lookup = { source: src }
      else warnings.push(`"${name}": a lookup with no source; it can't be resolved`)
    }
    const d = m.fields.default !== undefined ? at(q, m.fields.default) : undefined
    const dt = text(typeof d === 'object' && d !== null ? (d as Record<string, unknown>)['value'] ?? (d as Record<string, unknown>)['id'] : d)
    if (dt !== undefined && dt !== '' && !(m.ignoreDefaults !== undefined && new RegExp(m.ignoreDefaults, 'i').test(dt))) question.default = dt
    const max = m.fields.max !== undefined ? Number(at(q, m.fields.max)) : NaN
    if (Number.isFinite(max) && max > 0) question.max = max
    questions.push(question)
  }

  const names = new Set(questions.map((q) => q.name))
  const qname = (v: unknown) => { const s = text(v) ?? ''; return opts.ids?.[s] ?? s }
  const rules: Rule[] = [...(opts.rules ?? [])]
  if (m.rules !== undefined) {
    const raw = at(def, m.rules.at)
    for (const r of Array.isArray(raw) ? raw : []) {
      const conds = at(r, m.rules.when)
      const when: Condition[] = []
      let ok = true
      for (const c of Array.isArray(conds) ? conds : []) {
        const op = m.rules.ops[text(at(c, m.rules.op)) ?? '']
        const question = qname(at(c, m.rules.question))
        if (op === undefined || !names.has(question)) { ok = false; break }
        when.push({ question, op, ...(present(at(c, m.rules.value)) ? { value: text(at(c, m.rules.value)) } : {}) })
      }
      const note = m.rules.note !== undefined ? text(at(r, m.rules.note)) : undefined
      if (!ok) { warnings.push(`rule "${note ?? '?'}": a condition can't be read; dropped`); continue }
      const acts = at(r, m.rules.actions)
      const show: string[] = [], hide: string[] = [], require: string[] = []
      for (const a of Array.isArray(acts) ? acts : []) {
        const n = qname(at(a, m.rules.actionQuestion))
        if (!names.has(n)) continue
        const vis = m.rules.show !== undefined ? text(at(a, m.rules.show)) : undefined
        if (vis === 'true') show.push(n)
        else if (vis === 'false') hide.push(n)
        if (m.rules.require !== undefined && text(at(a, m.rules.require)) === 'true') require.push(n)
      }
      // A rule with no actions does nothing; keep nothing rather than guess from its title.
      if (show.length + hide.length + require.length === 0) { warnings.push(`rule "${note ?? '?'}": no actions; it does nothing`); continue }
      rules.push({ when, ...(show.length ? { show } : {}), ...(hide.length ? { hide } : {}), ...(require.length ? { require } : {}), ...(m.rules.reverse !== undefined && truthy(at(r, m.rules.reverse)) ? { reverse: true } : {}), ...(note ? { note } : {}) })
    }
  }

  const form: FormSpec = {
    id: text(m.id !== undefined ? at(def, m.id) : undefined) ?? '',
    title: text(m.title !== undefined ? at(def, m.title) : undefined) ?? '',
    questions,
    ...(m.description !== undefined && text(at(def, m.description)) ? { description: text(at(def, m.description))!.trim() } : {}),
    ...(m.variant !== undefined && text(at(def, m.variant)) ? { variant: text(at(def, m.variant)) } : {}),
    ...(rules.length ? { rules } : {}),
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.formats ? { formats: opts.formats } : {}),
  }
  return { form, warnings }
}
