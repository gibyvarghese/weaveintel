// SPDX-License-Identifier: MIT
/**
 * JSON schemas built from field definitions passed in as DATA, and the
 * validation that runs on what comes back.
 *
 * The model's answer is never trusted as is: each value is normalised to its
 * type, checked against its enum, pattern and length, and its quote is looked
 * up in the document text (and in OCR text when available) as an EXACT string.
 * Every problem lowers the confidence and is listed, so a reviewer sees why.
 */

import type { JsonSchema } from '@weaveintel/core';
import { WeaveIntelError } from '@weaveintel/core';
import type { RawFieldValue } from './ports.js';
import type { DocumentPage, ExtractedValue, FieldDefinition, NormalisedDocument, Provenance, Region, ValueIssue, ValueValidator } from './types.js';

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function assertFieldDefinitions(fields: readonly FieldDefinition[]): void {
  const seen = new Set<string>();
  for (const f of fields) {
    if (!NAME.test(f.name)) {
      throw new WeaveIntelError({ code: 'INVALID_INPUT', message: `Field name "${f.name}" must be letters, digits and underscores, starting with a letter.` });
    }
    if (seen.has(f.name)) throw new WeaveIntelError({ code: 'INVALID_INPUT', message: `Field "${f.name}" is defined twice.` });
    seen.add(f.name);
    if (f.type === 'enum' && (!f.enum || f.enum.length === 0)) {
      throw new WeaveIntelError({ code: 'INVALID_INPUT', message: `Field "${f.name}" is an enum with no values.` });
    }
  }
}

type Schema = Record<string, unknown>;

function valueSchema(f: FieldDefinition): Schema {
  const desc = [f.label, f.description, f.examples?.length ? `Examples: ${f.examples.join('; ')}` : undefined].filter(Boolean).join('. ');
  switch (f.type) {
    case 'number':
      return { type: ['number', 'null'], description: desc };
    case 'integer':
      return { type: ['integer', 'null'], description: desc };
    case 'boolean':
      return { type: ['boolean', 'null'], description: desc };
    case 'date':
      return { type: ['string', 'null'], description: `${desc}${desc ? '. ' : ''}As an ISO 8601 date, YYYY-MM-DD.` };
    case 'enum':
      return { type: ['string', 'null'], enum: [...(f.enum ?? []), null], description: desc };
    default:
      return { type: ['string', 'null'], description: desc, maxLength: f.maxLength ?? 500 };
  }
}

/**
 * One object per field: `{ value, quote, page, confidence }`, all required
 * (strict structured output), `value` null when the file does not say.
 */
export function buildExtractionSchema(fields: readonly FieldDefinition[]): JsonSchema {
  assertFieldDefinitions(fields);
  const properties: Record<string, Schema> = {};
  for (const f of fields) {
    properties[f.name] = {
      type: 'object',
      additionalProperties: false,
      required: ['value', 'quote', 'page', 'confidence'],
      properties: {
        value: valueSchema(f),
        quote: { type: ['string', 'null'], description: 'The exact text copied from the file that gives the value, or null.' },
        page: { type: ['integer', 'null'], description: 'The page number the quote is on, or null.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure, from 0 to 1.' },
      },
    };
  }
  return { type: 'object', additionalProperties: false, required: fields.map((f) => f.name), properties } as JsonSchema;
}

/** Read a schema-shaped answer into raw values. A field the answer leaves out is a null value. */
export function rawValuesFromAnswer(answer: unknown, fields: readonly FieldDefinition[]): RawFieldValue[] {
  const obj = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
  return fields.map((f) => {
    const v = (obj[f.name] && typeof obj[f.name] === 'object' ? obj[f.name] : {}) as Record<string, unknown>;
    const page = typeof v['page'] === 'number' && Number.isInteger(v['page']) ? (v['page'] as number) : null;
    const conf = typeof v['confidence'] === 'number' ? Math.max(0, Math.min(1, v['confidence'] as number)) : 0;
    return { field: f.name, value: v['value'] ?? null, quote: typeof v['quote'] === 'string' ? (v['quote'] as string) : null, page, confidence: conf };
  });
}

// ─── Validation ──────────────────────────────────────────────

/** Collapse whitespace and unify quotes and dashes, for exact-string matching that tolerates layout. */
export function normaliseForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Looser match for OCR: case and all spacing ignored. */
const loose = (s: string): string => normaliseForMatch(s).toLowerCase().replace(/\s+/g, '');

const INSTRUCTION_LIKE = /\b(ignore|disregard|override)\b.{0,40}\b(instruction|rule|prompt)s?\b|\byou are now\b|\b(call|invoke)\b.{0,20}\btool\b|<\|im_start\|>/i;

function normaliseValue(f: FieldDefinition, raw: unknown): { value: string | number | boolean | null; issue?: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  switch (f.type) {
    case 'number':
    case 'integer': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, '').replace(/^[^\d+-.]+/, ''));
      if (!Number.isFinite(n)) return { value: null, issue: `"${String(raw).slice(0, 40)}" is not a number` };
      if (f.type === 'integer' && !Number.isInteger(n)) return { value: null, issue: `${n} is not a whole number` };
      return { value: n };
    }
    case 'boolean':
      if (typeof raw === 'boolean') return { value: raw };
      if (/^(true|yes|y|1)$/i.test(String(raw))) return { value: true };
      if (/^(false|no|n|0)$/i.test(String(raw))) return { value: false };
      return { value: null, issue: `"${String(raw).slice(0, 40)}" is not yes or no` };
    case 'date': {
      const s = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) return { value: null, issue: `"${s.slice(0, 40)}" is not a YYYY-MM-DD date` };
      return { value: s };
    }
    default:
      return { value: typeof raw === 'string' ? raw : String(raw) };
  }
}

function regionFor(doc: NormalisedDocument, page: number | null, quote: string): Region | undefined {
  const q = normaliseForMatch(quote);
  if (!q) return undefined;
  const pages = page ? doc.pages.filter((p) => p.page === page) : doc.pages;
  for (const p of pages) {
    for (const s of p.spans ?? []) {
      const t = normaliseForMatch(s.text);
      if (s.region && t && (q.includes(t) || t.includes(q))) return s.region;
    }
  }
  return undefined;
}

function findQuote(pages: readonly DocumentPage[], page: number | null, quote: string): boolean {
  const q = normaliseForMatch(quote);
  if (!q) return false;
  const on = page ? pages.filter((p) => p.page === page) : [];
  if (on.some((p) => normaliseForMatch(p.text).includes(q))) return true;
  return pages.some((p) => normaliseForMatch(p.text).includes(q));
}

export interface ValidationOptions {
  /** OCR text per page, to cross-check exact strings. */
  readonly ocrPages?: readonly DocumentPage[];
  readonly validators?: readonly ValueValidator[];
}

/** Turn raw values into checked `ExtractedValue`s. */
export async function validateValues(
  raws: readonly RawFieldValue[],
  fields: readonly FieldDefinition[],
  doc: NormalisedDocument,
  provenance: Provenance,
  opts: ValidationOptions = {},
): Promise<ExtractedValue[]> {
  const out: ExtractedValue[] = [];
  const maxPage = doc.pages.reduce((m, p) => Math.max(m, p.page), 0);
  for (const f of fields) {
    const raw = raws.find((r) => r.field === f.name) ?? { field: f.name, value: null, quote: null, page: null, confidence: 0 };
    const issues: { issue: ValueIssue; detail: string }[] = [];
    let factor = 1;
    const add = (issue: ValueIssue, detail: string, k: number): void => {
      issues.push({ issue, detail });
      factor *= k;
    };
    const { value: normalised, issue: typeIssue } = normaliseValue(f, raw.value);
    let value = normalised;
    if (typeIssue) add('wrong_type', typeIssue, 0);
    if (value === null && f.required) add('missing_required', `${f.label ?? f.name} is required and was not found`, 0);
    if (typeof value === 'string') {
      if (f.type === 'enum' && !(f.enum ?? []).includes(value)) {
        add('not_in_enum', `"${value.slice(0, 40)}" is not one of the allowed values`, 0);
        value = null;
      }
      if (value !== null && f.pattern && !new RegExp(f.pattern).test(value)) add('pattern_mismatch', `does not match ${f.pattern}`, 0.3);
      if (value !== null && value.length > (f.maxLength ?? 500)) add('too_long', `longer than ${f.maxLength ?? 500} characters`, 0.3);
      if (value !== null && INSTRUCTION_LIKE.test(value)) add('instruction_like', 'the value reads like an instruction, not data', 0.1);
    }
    if (raw.page !== null && (raw.page < 1 || raw.page > maxPage)) add('page_out_of_range', `page ${raw.page} does not exist`, 0.5);

    let quoteVerified = false;
    let ocrVerified: boolean | undefined;
    if (value !== null) {
      if (!raw.quote) add('quote_not_in_source', 'no quote was given', 0.5);
      else {
        quoteVerified = findQuote(doc.pages, raw.page, raw.quote);
        if (!quoteVerified) add('quote_not_in_source', 'the quote is not in the file text', 0.3);
        // The value should be visible in its own quote (numbers compared by digits, enums and dates skipped).
        if (f.type === 'string' && !normaliseForMatch(raw.quote).toLowerCase().includes(normaliseForMatch(String(value)).toLowerCase())) {
          add('value_not_in_quote', 'the value is not in its quote', 0.7);
        }
        if ((f.type === 'number' || f.type === 'integer') && !raw.quote.replace(/\D/g, '').includes(String(value).replace(/\D/g, '').replace(/0+$/, ''))) {
          add('value_not_in_quote', 'the number is not in its quote', 0.7);
        }
        if (opts.ocrPages && opts.ocrPages.length > 0) {
          const target = loose(raw.quote);
          const pages = raw.page ? opts.ocrPages.filter((p) => p.page === raw.page) : opts.ocrPages;
          ocrVerified = (pages.length > 0 ? pages : opts.ocrPages).some((p) => loose(p.text).includes(target));
          if (!ocrVerified) add('ocr_disagrees', 'OCR of the page does not show this exact text', 0.6);
        }
      }
    }
    const region = value !== null && raw.quote ? (raw.region ?? regionFor(doc, raw.page, raw.quote)) : undefined;
    let ev: ExtractedValue = {
      field: f.name,
      value,
      quote: raw.quote,
      page: raw.page,
      ...(region ? { region } : {}),
      confidence: Number((raw.confidence * factor).toFixed(3)),
      reportedConfidence: raw.confidence,
      quoteVerified,
      ...(ocrVerified !== undefined ? { ocrVerified } : {}),
      issues,
      provenance,
    };
    for (const v of opts.validators ?? []) {
      const problems = await v(ev, f, doc);
      if (problems.length > 0) {
        ev = {
          ...ev,
          confidence: Number((ev.confidence * 0.5).toFixed(3)),
          issues: [...ev.issues, ...problems.map((p) => ({ issue: 'validator' as const, detail: p }))],
        };
      }
    }
    out.push(ev);
  }
  return out;
}
