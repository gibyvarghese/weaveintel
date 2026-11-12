// SPDX-License-Identifier: MIT
/**
 * The ports of file understanding. Each is a small interface so an engine can
 * be swapped by configuration: the in-house readers, a hosted model (the
 * default engines use the core `Model` interface, so Claude), a cloud service
 * (Azure Document Intelligence, Textract, Azure Speech), or a self-hosted
 * server (docling-serve, faster-whisper, TEI). Tests use the stand-ins.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type {
  ClassLabel,
  Classification,
  DocumentPage,
  FieldDefinition,
  NormalisedDocument,
  ParsedDocument,
  Provenance,
  TranscriptSegment,
} from './types.js';

/** Bytes plus the sniffed type. */
export interface FileBytes {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/** Turns a file's bytes into text, tables and attachments, with no model involved. */
export interface DocumentParser {
  readonly id: string;
  readonly version: string;
  /** Whether this parser reads the (sniffed) type. */
  accepts(mimeType: string): boolean;
  parse(file: FileBytes, ctx: ExecutionContext): Promise<ParsedDocument>;
}

/** Reads the text a person would SEE on a page image or a scanned PDF. Used for scans and to cross-check exact strings. */
export interface Ocr {
  readonly id: string;
  readonly version: string;
  /** PDF, PNG, JPEG ... (each engine says what it takes). */
  accepts(mimeType: string): boolean;
  read(file: FileBytes, ctx: ExecutionContext): Promise<{ readonly pages: readonly DocumentPage[]; readonly provenance: Provenance }>;
}

/** Reads an image (a screenshot, a photo of a receipt) and transcribes what is in it, verbatim. */
export interface VisionReader {
  readonly id: string;
  read(
    image: FileBytes,
    ctx: ExecutionContext,
    opts?: { readonly instruction?: string },
  ): Promise<{ readonly text: string; readonly provenance: Provenance }>;
}

/** Turns audio into a transcript with timed segments (and speakers, when the engine diarises). */
export interface SpeechToText {
  readonly id: string;
  transcribe(
    audio: FileBytes,
    ctx: ExecutionContext,
    opts?: { readonly language?: string; readonly diarize?: boolean },
  ): Promise<{ readonly text: string; readonly segments: readonly TranscriptSegment[]; readonly language?: string; readonly provenance: Provenance }>;
}

/** What a field extractor returns per field, BEFORE validation. */
export interface RawFieldValue {
  readonly field: string;
  readonly value: unknown;
  readonly quote: string | null;
  readonly page: number | null;
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly confidence: number;
}

/** Reads target fields out of a document. Must offer the model NO tools: the output is the schema, nothing else. */
export interface FieldExtractor {
  readonly id: string;
  extract(
    doc: NormalisedDocument,
    fields: readonly FieldDefinition[],
    ctx: ExecutionContext,
    opts?: {
      /** The original file, for engines that read it natively (a PDF or image part) alongside the text. */
      readonly original?: FileBytes;
    },
  ): Promise<{ readonly values: readonly RawFieldValue[]; readonly provenance: Provenance }>;
}

/** Picks a document type and intent from fixed lists passed in as data. */
export interface DocumentClassifier {
  readonly id: string;
  classify(
    doc: NormalisedDocument,
    labels: { readonly types: readonly ClassLabel[]; readonly intents?: readonly ClassLabel[] },
    ctx: ExecutionContext,
  ): Promise<Classification>;
}

/** Text embeddings with the model and size carried on every result. */
export interface Embedder {
  readonly id: string;
  embed(texts: readonly string[], ctx: ExecutionContext): Promise<{ readonly vectors: readonly (readonly number[])[]; readonly model: string; readonly dimensions: number }>;
}

/** Where finished results are kept, by cache key. The host scopes storage per tenant (the key already starts with the tenant). */
export interface ResultCache<T = unknown> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
}
