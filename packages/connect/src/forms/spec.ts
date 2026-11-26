// SPDX-License-Identifier: MIT
/**
 * The application-neutral form model. Every application has its own way to say "these are the questions to create
 * this thing" (a ServiceNow catalogue item, Jira create metadata, SharePoint list columns, an intake form). A
 * connector pack maps that definition into a FormSpec (see `fromDefinition`). Everything after that, from deciding
 * what to ask and checking answers to converting time zones and asking through MCP elicitation, is the same for
 * every application.
 */

export const QUESTION_KINDS = ['text', 'long_text', 'number', 'boolean', 'date', 'date_time', 'choice', 'multi_choice', 'lookup', 'person', 'attachment'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

export type Choice = { label: string; value: string }

export type Question = {
  name: string
  label: string
  kind: QuestionKind
  required: boolean
  help?: string
  choices?: Choice[]
  /** For `lookup` and `person`: where the answer's record id comes from (a lookup source the pack can search). */
  lookup?: { source: string }
  /** A literal default. Computed defaults (expressions the application evaluates itself) are never carried. */
  default?: string
  /** Longest accepted text. */
  max?: number
}

export type Condition = { question: string; op: '=' | '!=' | 'empty' | 'not_empty'; value?: string }

/**
 * A show, hide or require rule. Its actions apply while every condition holds. With `reverse`, the opposite
 * applies while they don't (so "show when" also means "hidden otherwise").
 */
export type Rule = { when: Condition[]; show?: string[]; hide?: string[]; require?: string[]; reverse?: boolean; note?: string }

/** How the target application wants each kind written. */
export type AnswerFormats = {
  /** `local`: yyyy-MM-dd HH:mm:ss in the form's zone. `iso_offset`: 2026-11-26T08:30:00+13:00. `iso_utc`: …Z. */
  dateTime?: 'local' | 'iso_offset' | 'iso_utc'
  /** `string`: "true"/"false". `json`: true/false. */
  boolean?: 'string' | 'json'
  /** `array`: ["a","b"]. `comma`: "a,b". */
  multi?: 'array' | 'comma'
  /** `string`: "12". `json`: 12. */
  number?: 'string' | 'json'
}

export type FormSpec = {
  id: string
  title: string
  description?: string
  /** Which submit variant applies (for example a catalogue item's type); the caller routes on it. */
  variant?: string
  questions: Question[]
  rules?: Rule[]
  /**
   * The IANA zone the application stores date-time answers in: the submitting account's zone, else the
   * application's default. Without it, date-times are sent as given and `normalise` warns.
   */
  timeZone?: string
  formats?: AnswerFormats
}

/** A person's answer. Lookups are answered with the record they resolved to (`{ id, label }`). */
export type Answer = string | number | boolean | string[] | { id: string; label?: string }
export type Answers = Record<string, Answer | undefined>
/** What the application receives. */
export type Value = string | number | boolean | string[]
