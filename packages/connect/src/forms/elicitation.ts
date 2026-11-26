// SPDX-License-Identifier: MIT
/**
 * Ask a form's open questions through MCP elicitation (form mode): a message plus a flat JSON Schema of primitives.
 * Any MCP client can render it, as can Geni chat, a Teams card or an email surface that reads the same schema.
 *
 * Follows the specification's rules:
 * - Form mode never asks for secrets (there is no secret kind here).
 * - The person can decline or cancel.
 * - Choices use titled `oneOf` (`const` + `title`).
 * - Several choices use an array of titled `anyOf`.
 * - A lookup is asked in words and resolved afterwards, because a schema can't hold a whole table.
 */
import type { Answers, FormSpec, Question } from './spec.js'
import { nextQuestions } from './answers.js'

export type PrimitiveSchema = Record<string, unknown>
export type ElicitationRequest = { message: string; requestedSchema: { type: 'object'; properties: Record<string, PrimitiveSchema>; required: string[] } }
export type ElicitationResult = { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }

function schemaFor(q: Question): PrimitiveSchema {
  const base: PrimitiveSchema = { title: q.label, ...(q.help ? { description: q.help } : {}) }
  const dflt = q.default !== undefined ? { default: q.default } : {}
  switch (q.kind) {
    case 'choice': return { ...base, type: 'string', oneOf: (q.choices ?? []).map((c) => ({ const: c.value, title: c.label })), ...dflt }
    case 'multi_choice': return { ...base, type: 'array', items: { anyOf: (q.choices ?? []).map((c) => ({ const: c.value, title: c.label })) } }
    case 'boolean': return { ...base, type: 'boolean', ...(q.default !== undefined ? { default: /^(true|yes)$/i.test(q.default) } : {}) }
    case 'number': return { ...base, type: 'number', ...(q.default !== undefined && !Number.isNaN(Number(q.default)) ? { default: Number(q.default) } : {}) }
    case 'date': return { ...base, type: 'string', format: 'date', ...dflt }
    case 'date_time': return { ...base, type: 'string', format: 'date-time', description: [q.help, 'Your local time, or with a time zone.'].filter(Boolean).join(' ') }
    case 'lookup': case 'person': return { ...base, type: 'string', description: [q.help, q.kind === 'person' ? 'A name or email; it will be looked up.' : 'A name; it will be looked up.'].filter(Boolean).join(' ') }
    default: return { ...base, type: 'string', ...(q.max !== undefined ? { maxLength: q.max } : {}), ...dflt }
  }
}

/**
 * The elicitation request for the questions still open (or the ones given). Attachments can't be asked in a form,
 * so they're listed in `notAskable` for the caller to collect another way.
 */
export function toElicitation(form: FormSpec, answers: Answers = {}, opts: { questions?: Question[]; message?: string } = {}): ElicitationRequest & { notAskable: string[] } {
  const qs = opts.questions ?? nextQuestions(form, answers)
  const askable = qs.filter((q) => q.kind !== 'attachment')
  const properties: Record<string, PrimitiveSchema> = {}
  for (const q of askable) properties[q.name] = schemaFor(q)
  return {
    message: opts.message ?? `${form.title}: ${askable.length === 1 ? 'one question' : `${askable.length} questions`}`,
    requestedSchema: { type: 'object', properties, required: askable.filter((q) => q.required).map((q) => q.name) },
    notAskable: qs.filter((q) => q.kind === 'attachment').map((q) => q.name),
  }
}

/** The answers in an elicitation result. Lookups come back as words, still to be resolved. Unknown keys are dropped. */
export function fromElicitation(form: FormSpec, result: ElicitationResult): { status: 'answered' | 'declined' | 'cancelled'; answers: Answers } {
  if (result.action !== 'accept') return { status: result.action === 'decline' ? 'declined' : 'cancelled', answers: {} }
  const answers: Answers = {}
  for (const q of form.questions) {
    const v = result.content?.[q.name]
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) answers[q.name] = v.map(String)
    else if (typeof v === 'boolean' || typeof v === 'number') answers[q.name] = v
    else answers[q.name] = String(v)
  }
  return { status: 'answered', answers }
}
