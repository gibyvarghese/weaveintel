// SPDX-License-Identifier: MIT
/**
 * Data shapes for file understanding. Everything here is plain data: safe to
 * store, compare and log (apart from file bytes and extracted text, which are
 * tenant content).
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { HiddenTextFinding, InjectionAssessment } from '@weaveintel/guardrails';

// ─── Provenance ──────────────────────────────────────────────

/** Which engine did a step, with which model and version, where. Recorded for every step and every value. */
export interface Provenance {
  readonly step: 'parse' | 'ocr' | 'vision' | 'transcribe' | 'classify' | 'extract' | 'embed' | 'map';
  /** Engine id, e.g. `docx-reader`, `pdfjs`, `model-extractor`, `docling-serve`, `stand-in`. */
  readonly engine: string;
  readonly version: string;
  /** Model id, when a model did the step. */
  readonly model?: string;
  /** Provider id, when a model did the step. */
  readonly provider?: string;
  /** Where the processing happened, when known (a cloud region, `in-process`). */
  readonly region?: string;
}

// ─── The input ───────────────────────────────────────────────

export interface FileInput {
  readonly bytes: Uint8Array;
  /** The type the uploader or source claimed. Never trusted on its own: the bytes are sniffed. */
  readonly declaredMimeType?: string;
  /** Shown to people; never sent to a model (names can carry instructions). */
  readonly filename?: string;
}

// ─── A normalised document ───────────────────────────────────

/** A box on a page, in fractions of the page size (0..1), origin top-left. */
export interface Region {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TextSpan {
  readonly text: string;
  readonly region?: Region;
  readonly confidence?: number;
}

export type PageSource = 'text_layer' | 'parsed' | 'ocr' | 'vision' | 'transcript';

export interface DocumentPage {
  /** 1-based. For a spreadsheet, one page per visible sheet; for audio, one page. */
  readonly page: number;
  readonly text: string;
  readonly source: PageSource;
  /** A sheet name, a part name ("body", "attachment 1"), when it helps a person. */
  readonly label?: string;
  readonly spans?: readonly TextSpan[];
}

export interface DocumentTable {
  readonly page?: number;
  readonly sheet?: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** The row number (1-based, in the sheet) of the header row, when found. */
  readonly headerRow?: number;
}

export interface DocumentAttachment {
  readonly filename?: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  /** 1 = attached directly to the parsed file. */
  readonly depth: number;
}

export interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly speaker?: string;
}

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'email' | 'image' | 'audio' | 'text' | 'csv' | 'html' | 'unknown';

/** What every parser, OCR engine and speech engine hands back, whatever the file was. */
export interface NormalisedDocument {
  readonly kind: DocumentKind;
  readonly mimeType: string;
  readonly pages: readonly DocumentPage[];
  readonly tables: readonly DocumentTable[];
  readonly attachments: readonly DocumentAttachment[];
  /** Title, author, subject, from, to, date ... as plain strings. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Hidden content found and removed from `pages` (hidden runs, white text, invisible characters, tag characters). */
  readonly hidden: readonly HiddenTextFinding[];
  /** Active content found: macros, PDF JavaScript, launch actions, embedded files. */
  readonly activeContent: readonly string[];
  readonly warnings: readonly string[];
  readonly segments?: readonly TranscriptSegment[];
  readonly provenance: readonly Provenance[];
}

/** The part of a document a parser produces; the service fills in the rest. */
export type ParsedDocument = Omit<NormalisedDocument, 'provenance' | 'hidden' | 'activeContent' | 'warnings' | 'tables' | 'attachments' | 'metadata'> &
  Partial<Pick<NormalisedDocument, 'hidden' | 'activeContent' | 'warnings' | 'tables' | 'attachments' | 'metadata'>>;

// ─── Fields to extract (passed in as data) ───────────────────

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'enum';

/** One target field. Usually generated from a dictionary; never code. */
export interface FieldDefinition {
  /** Machine name; becomes the JSON key. Letters, digits and underscores. */
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly type: FieldType;
  /** For `enum`: the only allowed values. */
  readonly enum?: readonly string[];
  /** A regular expression the value must match (validated in code after extraction). */
  readonly pattern?: string;
  readonly required?: boolean;
  readonly examples?: readonly string[];
  /** Other names the field goes by (for spreadsheet column mapping). */
  readonly aliases?: readonly string[];
  /** Longest accepted string value. Default 500. */
  readonly maxLength?: number;
}

export type ValueIssue =
  | 'missing_required'
  | 'wrong_type'
  | 'not_in_enum'
  | 'pattern_mismatch'
  | 'too_long'
  | 'quote_not_in_source'
  | 'value_not_in_quote'
  | 'ocr_disagrees'
  | 'page_out_of_range'
  | 'instruction_like'
  | 'validator';

/** One extracted value, with where it came from and how sure we are. */
export interface ExtractedValue {
  readonly field: string;
  /** Normalised to the field's type; `null` when not found. */
  readonly value: string | number | boolean | null;
  /** The exact text in the file the value was read from. */
  readonly quote: string | null;
  /** 1-based page the quote is on. */
  readonly page: number | null;
  readonly region?: Region;
  /** 0..1, after validation (the model's own number, lowered for each problem found). */
  readonly confidence: number;
  /** The model's own confidence before validation. */
  readonly reportedConfidence: number;
  /** True when the quote was found in the document's text. */
  readonly quoteVerified: boolean;
  /** True / false when an OCR text was available to cross-check exact strings; undefined otherwise. */
  readonly ocrVerified?: boolean;
  readonly issues: readonly { readonly issue: ValueIssue; readonly detail: string }[];
  readonly provenance: Provenance;
}

/** A validation hook: return problems for one value. Runs after the built-in checks. */
export type ValueValidator = (
  value: ExtractedValue,
  field: FieldDefinition,
  doc: NormalisedDocument,
) => readonly string[] | Promise<readonly string[]>;

// ─── Classification (types and intents passed in as data) ────

export interface ClassLabel {
  readonly id: string;
  readonly description: string;
}

export interface Classification {
  readonly documentType: string;
  readonly intent: string | null;
  readonly confidence: number;
  /** Why, in one sentence, from the model. Untrusted text: show it, never act on it. */
  readonly reason: string;
  readonly provenance: Provenance;
}

// ─── The result ──────────────────────────────────────────────

export interface UnderstandingResult {
  readonly cacheKey: string;
  readonly fromCache: boolean;
  readonly contentHash: string;
  readonly document: NormalisedDocument;
  readonly classification?: Classification;
  readonly values?: readonly ExtractedValue[];
  readonly injection?: InjectionAssessment;
  /** Every step's provenance, in order. */
  readonly provenance: readonly Provenance[];
}

export type { ExecutionContext, HiddenTextFinding, InjectionAssessment };
