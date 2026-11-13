// SPDX-License-Identifier: MIT
/**
 * Output checks per task. A local engine's output is checked like text a person typed: shape, length and, where a
 * task has choices, membership. A failed check is a `schema_violation` and the walker moves on.
 */

import { SHORT_SUMMARY_MAX_WORDS } from './constants.js';
import type { EngineInput } from './engine.js';

export type ValidationResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly problem: string };

export interface ValidationContext {
  readonly input: EngineInput;
  readonly maxOutputChars: number;
}

/** A host-supplied check for a task this package does not know. */
export type OutputValidator = (output: unknown, ctx: ValidationContext) => ValidationResult;

/**
 * Check (and normalise) one output. Known tasks:
 * - `text.language` → `{ language }`, a BCP 47 tag;
 * - `text.summary.short` → `{ text }`, at most {@link SHORT_SUMMARY_MAX_WORDS} words;
 * - `field.suggest` → `{ field, value, confidence? }`, the field asked for and a value from the choices;
 * - `record.classify` → `{ label }` from the choices;
 * - `pii.detect` → `{ spans: [{ start, end, kind }] }` inside the input text;
 * - `text.translate`, `speech.text` → `{ text }`.
 * Every text is capped at `maxOutputChars`. An unknown task needs a validator from the host.
 */
export function validateTaskOutput(
  task: string,
  output: unknown,
  ctx: ValidationContext,
  custom?: Readonly<Record<string, OutputValidator>>,
): ValidationResult {
  const own =
    custom && Object.prototype.hasOwnProperty.call(custom, task) ? custom[task] : undefined;
  if (own) return own(output, ctx);
  const builtIn = Object.prototype.hasOwnProperty.call(BUILT_IN, task) ? BUILT_IN[task] : undefined;
  if (!builtIn) return fail(`No output check is known for the task ${task}.`);
  return builtIn(output, ctx);
}

const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function fail(problem: string): ValidationResult {
  return { ok: false, problem };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function cappedText(v: unknown, ctx: ValidationContext, what: string): string | ValidationResult {
  if (typeof v !== 'string') return fail(`${what} is not text.`);
  const text = v.trim();
  if (text === '') return fail(`${what} is empty.`);
  if (text.length > ctx.maxOutputChars)
    return fail(`${what} is longer than ${String(ctx.maxOutputChars)} characters.`);
  return text;
}

function textTask(output: unknown, ctx: ValidationContext): ValidationResult {
  const o = asRecord(output);
  if (!o) return fail('The output is not an object.');
  const text = cappedText(o['text'], ctx, 'The text');
  return typeof text === 'string' ? { ok: true, output: { text } } : text;
}

function confidenceOk(v: unknown): boolean {
  return v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
}

const BUILT_IN: Readonly<Record<string, OutputValidator>> = {
  'text.language': (output) => {
    const o = asRecord(output);
    const language = o?.['language'];
    if (typeof language !== 'string' || !LANGUAGE_TAG.test(language))
      return fail('The language is not a language tag.');
    return { ok: true, output: { language } };
  },
  'text.summary.short': (output, ctx) => {
    const r = textTask(output, ctx);
    if (!r.ok) return r;
    const text = (r.output as { text: string }).text;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words > SHORT_SUMMARY_MAX_WORDS)
      return fail(`The summary is longer than ${String(SHORT_SUMMARY_MAX_WORDS)} words.`);
    return r;
  },
  'field.suggest': (output, ctx) => {
    const o = asRecord(output);
    if (!o) return fail('The output is not an object.');
    const { field, choices } = ctx.input;
    if (typeof field !== 'string' || o['field'] !== field)
      return fail('The suggestion is for another field.');
    const value = o['value'];
    if (typeof value !== 'string') return fail('The suggested value is not text.');
    if (choices && !choices.includes(value))
      return fail("The suggested value is not one of the field's choices.");
    if (value.length > ctx.maxOutputChars) return fail('The suggested value is too long.');
    if (!confidenceOk(o['confidence'])) return fail('The confidence is not between 0 and 1.');
    const out: { field: string; value: string; confidence?: number } = { field, value };
    if (typeof o['confidence'] === 'number') out.confidence = o['confidence'];
    return { ok: true, output: out };
  },
  'record.classify': (output, ctx) => {
    const o = asRecord(output);
    const label = o?.['label'];
    const choices = ctx.input.choices;
    if (!choices || choices.length === 0) return fail('No labels were given to classify into.');
    if (typeof label !== 'string' || !choices.includes(label))
      return fail('The label is not one of the given labels.');
    return { ok: true, output: { label } };
  },
  'pii.detect': (output, ctx) => {
    const o = asRecord(output);
    const spans = o?.['spans'];
    if (!Array.isArray(spans)) return fail('The spans are not a list.');
    const length = ctx.input.text?.length ?? 0;
    const out: { start: number; end: number; kind: string }[] = [];
    for (const span of spans) {
      const s = asRecord(span);
      const start = s?.['start'];
      const end = s?.['end'];
      const kind = s?.['kind'];
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        typeof kind !== 'string' ||
        kind === ''
      ) {
        return fail('A span is not {start, end, kind}.');
      }
      if (
        (start as number) < 0 ||
        (end as number) <= (start as number) ||
        (end as number) > length
      ) {
        return fail('A span lies outside the input.');
      }
      out.push({ start: start as number, end: end as number, kind });
    }
    return { ok: true, output: { spans: out } };
  },
  'text.translate': textTask,
  'speech.text': textTask,
};
