// SPDX-License-Identifier: MIT
/**
 * The FileUnderstanding service: one call from bytes to a checked result.
 *
 *   bytes ─ size limit ─ content hash ─ sniff ─ cache? ─ parse / OCR / vision / speech
 *     ─ strip hidden text (+ text layer vs OCR) ─ attachments (depth-capped)
 *     ─ injection signal ─ classify (types as data) ─ extract (fields as data, no tools)
 *     ─ validate (quote in source, OCR exact strings, hooks) ─ provenance ─ cache
 *
 * Nothing here ACTS on a file: it returns suggestions with evidence. The host
 * decides, with a person, what to write.
 */

import type { ExecutionContext } from '@weaveintel/core';
import { WeaveIntelError } from '@weaveintel/core';
import { compareTextLayers, stripHiddenText, type HiddenTextFinding, type InjectionSignal } from '@weaveintel/guardrails';
import type { DocumentClassifier, DocumentParser, FieldExtractor, FileBytes, Ocr, ResultCache, SpeechToText, VisionReader } from './ports.js';
import type {
  ClassLabel,
  DocumentPage,
  FieldDefinition,
  FileInput,
  NormalisedDocument,
  ParsedDocument,
  Provenance,
  UnderstandingResult,
  ValueValidator,
} from './types.js';
import { FileLimitError } from './errors.js';
import { contentHash, resultCacheKey } from './cache.js';
import { sniffMimeType } from './sniff.js';
import { validateValues } from './schema.js';
import { createDocxParser } from './docx.js';
import { createXlsxParser } from './xlsx.js';
import { createEmailParser, createTextParser } from './email.js';
import { createBasicPdfParser } from './pdf.js';

export interface FileUnderstandingOptions {
  /** Tried in order; the first that accepts the sniffed type parses. Default: the in-house readers. */
  readonly parsers?: readonly DocumentParser[];
  readonly ocr?: Ocr;
  readonly vision?: VisionReader;
  readonly speech?: SpeechToText;
  readonly extractor?: FieldExtractor;
  readonly classifier?: DocumentClassifier;
  readonly injectionSignal?: InjectionSignal;
  readonly cache?: ResultCache<UnderstandingResult>;
  /** Bump when anything in the host's pipeline changes. Part of every cache key. */
  readonly pipelineVersion: string;
  /** Largest file accepted. Default 50 MiB. */
  readonly maxBytes?: number;
  /** How deep e-mail attachments are read. 0 = not read. Default 2. */
  readonly maxAttachmentDepth?: number;
  /** Most attachments read per file. Default 20. */
  readonly maxAttachments?: number;
}

export interface UnderstandOptions {
  readonly tenantId: string;
  /** Fields to extract (data). Omit to only read and classify. */
  readonly fields?: readonly FieldDefinition[];
  /** Version of the field definitions; part of the cache key. */
  readonly schemaVersion?: string;
  /** Document types and intents (data). */
  readonly labels?: { readonly types: readonly ClassLabel[]; readonly intents?: readonly ClassLabel[] };
  /** Run OCR on a PDF that has a text layer, to compare the two and cross-check exact strings. Default true when an OCR engine accepts the type. */
  readonly ocrCrossCheck?: boolean;
  readonly validators?: readonly ValueValidator[];
  /** Skip the cache for this call. */
  readonly noCache?: boolean;
}

export interface FileUnderstanding {
  understand(ctx: ExecutionContext, file: FileInput, opts: UnderstandOptions): Promise<UnderstandingResult>;
  /** Read a file into a normalised document only (no model calls unless a page needs OCR, vision or speech). */
  read(ctx: ExecutionContext, file: FileInput): Promise<{ document: NormalisedDocument; ocrPages?: readonly DocumentPage[] }>;
}

export function defaultParsers(): DocumentParser[] {
  return [createBasicPdfParser(), createDocxParser(), createXlsxParser(), createEmailParser(), createTextParser()];
}

export function createFileUnderstanding(options: FileUnderstandingOptions): FileUnderstanding {
  const parsers = options.parsers ?? defaultParsers();
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
  const maxDepth = options.maxAttachmentDepth ?? 2;
  const maxAttachments = options.maxAttachments ?? 20;

  function finish(parsed: ParsedDocument, extra: { provenance: Provenance[]; warnings: string[]; hidden: HiddenTextFinding[] }): NormalisedDocument {
    // Strip invisible characters from every page and record what went.
    const hidden: HiddenTextFinding[] = [...(parsed.hidden ?? []), ...extra.hidden];
    const pages = parsed.pages.map((p) => {
      const s = stripHiddenText(p.text, { location: `page ${p.page}` });
      hidden.push(...s.findings);
      return s.changed ? { ...p, text: s.text } : p;
    });
    return {
      kind: parsed.kind,
      mimeType: parsed.mimeType,
      pages,
      tables: parsed.tables ?? [],
      attachments: parsed.attachments ?? [],
      metadata: parsed.metadata ?? {},
      hidden,
      activeContent: parsed.activeContent ?? [],
      warnings: [...(parsed.warnings ?? []), ...extra.warnings],
      ...(parsed.segments ? { segments: parsed.segments } : {}),
      provenance: extra.provenance,
    };
  }

  async function readBytes(ctx: ExecutionContext, file: FileBytes, depth: number, crossCheck: boolean): Promise<{ document: NormalisedDocument; ocrPages?: readonly DocumentPage[] }> {
    const provenance: Provenance[] = [];
    const warnings: string[] = [];
    const hidden: HiddenTextFinding[] = [];
    let parsed: ParsedDocument | undefined;
    let ocrPages: readonly DocumentPage[] | undefined;
    const m = file.mimeType;

    if (m.startsWith('image/')) {
      const pages: DocumentPage[] = [];
      if (options.vision) {
        const r = await options.vision.read(file, ctx);
        provenance.push(r.provenance);
        pages.push({ page: 1, text: r.text, source: 'vision' });
      }
      if (options.ocr?.accepts(m)) {
        const r = await options.ocr.read(file, ctx);
        provenance.push(r.provenance);
        ocrPages = r.pages;
        if (pages.length === 0) pages.push(...r.pages);
      }
      if (pages.length === 0) throw new FileLimitError('no_engine', 'An image needs a vision reader or an OCR engine, and neither is configured.');
      parsed = { kind: 'image', mimeType: m, pages };
    } else if (m.startsWith('audio/')) {
      if (!options.speech) throw new FileLimitError('no_engine', 'Audio needs a speech-to-text engine, and none is configured.');
      const r = await options.speech.transcribe(file, ctx);
      provenance.push(r.provenance);
      parsed = { kind: 'audio', mimeType: m, pages: [{ page: 1, text: r.text, source: 'transcript' }], segments: r.segments, metadata: r.language ? { language: r.language } : {} };
    } else {
      const parser = parsers.find((p) => p.accepts(m));
      if (!parser) throw new FileLimitError('no_parser', `No reader is configured for files of type ${m}.`);
      parsed = await parser.parse(file, ctx);
      provenance.push({ step: 'parse', engine: parser.id, version: parser.version, region: 'in-process' });
      const empty = parsed.pages.every((p) => p.text.trim() === '');
      if (m === 'application/pdf' && options.ocr?.accepts(m) && (empty || crossCheck)) {
        const r = await options.ocr.read(file, ctx);
        provenance.push(r.provenance);
        ocrPages = r.pages;
        if (empty) {
          parsed = { ...parsed, pages: r.pages, warnings: [...(parsed.warnings ?? []), 'The PDF has no text layer; the OCR text is used.'] };
        } else {
          for (const p of parsed.pages) {
            const o = r.pages.find((x) => x.page === p.page);
            if (!o) continue;
            const cmp = compareTextLayers(p.text, o.text, { location: `page ${p.page}` });
            if (cmp.finding) hidden.push(cmp.finding);
          }
        }
      }
    }

    // E-mail attachments: read (not extracted) up to the depth limit, appended as labelled pages.
    const atts = parsed.attachments ?? [];
    if (atts.length > 0 && depth < maxDepth) {
      let pageNo = parsed.pages.reduce((n, p) => Math.max(n, p.page), 0);
      const extraPages: DocumentPage[] = [];
      for (const [i, a] of atts.slice(0, maxAttachments).entries()) {
        try {
          const sniffed = sniffMimeType(a.bytes, a.mimeType).mimeType;
          const sub = await readBytes(ctx, { bytes: a.bytes, mimeType: sniffed }, depth + 1, false);
          provenance.push(...sub.document.provenance);
          hidden.push(...sub.document.hidden.map((h) => ({ ...h, location: `attachment ${i + 1}${h.location ? `, ${h.location}` : ''}` })));
          for (const p of sub.document.pages) extraPages.push({ ...p, page: ++pageNo, label: `attachment ${i + 1} (${sniffed})${p.label ? `: ${p.label}` : ''}` });
          if (sub.document.activeContent.length > 0) warnings.push(`Attachment ${i + 1} has active content: ${sub.document.activeContent.join(', ')}.`);
        } catch (err) {
          warnings.push(`Attachment ${i + 1} (${a.mimeType}) was not read: ${(err as Error).message}`);
        }
      }
      if (atts.length > maxAttachments) warnings.push(`Only the first ${maxAttachments} of ${atts.length} attachments were read.`);
      parsed = { ...parsed, pages: [...parsed.pages, ...extraPages] };
    } else if (atts.length > 0) {
      warnings.push(`${atts.length} attachment(s) are deeper than the read limit and were not read.`);
    }

    return { document: finish(parsed, { provenance, warnings, hidden }), ...(ocrPages ? { ocrPages } : {}) };
  }

  async function read(ctx: ExecutionContext, file: FileInput, crossCheck = true) {
    if (file.bytes.length > maxBytes) throw new FileLimitError('file_too_large', `The file is ${file.bytes.length} bytes; at most ${maxBytes} are accepted.`);
    const sniff = sniffMimeType(file.bytes, file.declaredMimeType);
    const out = await readBytes(ctx, { bytes: file.bytes, mimeType: sniff.mimeType }, 0, crossCheck);
    if (sniff.mismatch) {
      return { ...out, document: { ...out.document, warnings: [`The file was declared as ${sniff.mismatch.declared} but is ${sniff.mismatch.sniffed}; it was read as ${sniff.mismatch.sniffed}.`, ...out.document.warnings] } };
    }
    return out;
  }

  return {
    read: (ctx, file) => read(ctx, file),

    async understand(ctx, file, opts) {
      if (!opts.tenantId) throw new WeaveIntelError({ code: 'INVALID_INPUT', message: 'understand() needs the tenant id.' });
      if (file.bytes.length > maxBytes) throw new FileLimitError('file_too_large', `The file is ${file.bytes.length} bytes; at most ${maxBytes} are accepted.`);
      const hash = contentHash(file.bytes);
      const cacheKey = resultCacheKey({
        tenantId: opts.tenantId,
        contentHash: hash,
        pipelineVersion: options.pipelineVersion,
        ...(opts.schemaVersion ? { schemaVersion: opts.schemaVersion } : {}),
        modelVersion: [options.extractor?.id, options.classifier?.id, options.ocr ? `${options.ocr.id}@${options.ocr.version}` : '', options.vision?.id, options.speech?.id].filter(Boolean).join('|'),
        extra: {
          fields: JSON.stringify(opts.fields ?? []),
          labels: JSON.stringify(opts.labels ?? null),
          ocr: String(opts.ocrCrossCheck ?? true),
        },
      });
      if (options.cache && !opts.noCache) {
        const hit = await options.cache.get(cacheKey);
        if (hit) return { ...hit, fromCache: true };
      }

      const { document, ocrPages } = await read(ctx, file, opts.ocrCrossCheck ?? true);
      const provenance: Provenance[] = [...document.provenance];

      const injection = options.injectionSignal
        ? await options.injectionSignal.assess(document.pages.map((p) => p.text).join('\n'), { hiddenText: document.hidden })
        : undefined;

      const classification = opts.labels && options.classifier ? await options.classifier.classify(document, opts.labels, ctx) : undefined;
      if (classification) provenance.push(classification.provenance);

      let values: UnderstandingResult['values'];
      if (opts.fields && opts.fields.length > 0) {
        if (!options.extractor) throw new WeaveIntelError({ code: 'INVALID_CONFIG', message: 'Fields were asked for and no field extractor is configured.' });
        const sniffed = sniffMimeType(file.bytes, file.declaredMimeType).mimeType;
        const raw = await options.extractor.extract(document, opts.fields, ctx, { original: { bytes: file.bytes, mimeType: sniffed } });
        provenance.push(raw.provenance);
        values = await validateValues(raw.values, opts.fields, document, raw.provenance, {
          ...(ocrPages ? { ocrPages } : {}),
          ...(opts.validators ? { validators: opts.validators } : {}),
        });
      }

      const result: UnderstandingResult = {
        cacheKey,
        fromCache: false,
        contentHash: hash,
        document,
        ...(classification ? { classification } : {}),
        ...(values ? { values } : {}),
        ...(injection ? { injection } : {}),
        provenance,
      };
      if (options.cache && !opts.noCache) await options.cache.set(cacheKey, result);
      return result;
    },
  };
}
