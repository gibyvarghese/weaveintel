// SPDX-License-Identifier: MIT
/**
 * docling-serve over HTTP, as a `DocumentParser` and an `Ocr` engine.
 *
 * Docling (MIT; Granite-Docling weights Apache-2.0) runs as a self-hosted
 * container on a server, never on a laptop. This adapter speaks its v1 REST
 * API: `POST /v1/convert/source` with the file as base64, asking for Markdown
 * and the DoclingDocument JSON, which carries page numbers and boxes.
 *
 * The HTTP call goes through the `fetch` the HOST passes in (its guarded
 * transport, allowed to reach this one private address). There is no default
 * to the global fetch on purpose.
 *
 * Status: written against the docling-serve v1 API as documented (synced
 * docs v1.21.0); tested against a local stand-in server, not a real
 * docling-serve. Confirm field names against the deployed version.
 */

import { WeaveIntelError } from '@weaveintel/core';
import type { DocumentParser, FileBytes, Ocr } from './ports.js';
import type { DocumentPage, DocumentTable, ParsedDocument, Provenance, TextSpan } from './types.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface DoclingServeOptions {
  /** e.g. http://docling.internal:5001 */
  readonly baseUrl: string;
  /** The host's guarded fetch. */
  readonly fetch: FetchLike;
  /** Sent as `X-Api-Key` when docling-serve runs with an API key. */
  readonly apiKey?: string;
  /** Run OCR on pages (scans). Default true. */
  readonly doOcr?: boolean;
  /** Per-call timeout. Default 120 s. */
  readonly timeoutMs?: number;
  /** For provenance. */
  readonly region?: string;
  readonly version?: string;
}

const ACCEPTS = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/html',
  'text/markdown',
]);

const EXT: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/tiff': 'tiff', 'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/html': 'html', 'text/markdown': 'md',
};

interface DoclingProv { page_no?: number; bbox?: { l: number; t: number; r: number; b: number; coord_origin?: string } }
interface DoclingJson {
  pages?: Record<string, { size?: { width: number; height: number } }>;
  texts?: Array<{ text?: string; prov?: DoclingProv[] }>;
  tables?: Array<{ prov?: DoclingProv[]; data?: { grid?: Array<Array<{ text?: string }>> } }>;
}

/** DoclingDocument JSON → pages with spans (boxes as page fractions, top-left origin) and tables. */
export function doclingJsonToPages(json: DoclingJson, source: DocumentPage['source']): { pages: DocumentPage[]; tables: DocumentTable[] } {
  const byPage = new Map<number, { lines: string[]; spans: TextSpan[] }>();
  const sizes = json.pages ?? {};
  for (const t of json.texts ?? []) {
    const prov = t.prov?.[0];
    const page = prov?.page_no ?? 1;
    const entry = byPage.get(page) ?? { lines: [], spans: [] };
    const text = t.text ?? '';
    entry.lines.push(text);
    const size = sizes[String(page)]?.size;
    if (prov?.bbox && size && size.width > 0 && size.height > 0) {
      const { l, t: top, r, b, coord_origin } = prov.bbox;
      const y = coord_origin === 'BOTTOMLEFT' ? (size.height - top) / size.height : top / size.height;
      entry.spans.push({ text, region: { x: l / size.width, y: Math.max(0, y), width: (r - l) / size.width, height: Math.abs(top - b) / size.height } });
    }
    byPage.set(page, entry);
  }
  const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, e]) => ({ page, text: e.lines.join('\n'), source, spans: e.spans }));
  const tables: DocumentTable[] = (json.tables ?? []).map((t) => {
    const grid = (t.data?.grid ?? []).map((row) => row.map((c) => c.text ?? ''));
    const [headers = [], ...rows] = grid;
    return { ...(t.prov?.[0]?.page_no ? { page: t.prov[0].page_no } : {}), headers, rows, headerRow: 1 };
  });
  return { pages, tables };
}

async function convert(opts: DoclingServeOptions, file: FileBytes, ocr: boolean, forceOcr = false): Promise<{ json?: DoclingJson; md?: string }> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/convert/source`;
  const body = JSON.stringify({
    options: { to_formats: ['md', 'json'], do_ocr: ocr, force_ocr: forceOcr, image_export_mode: 'placeholder', abort_on_error: false },
    sources: [{ kind: 'file', base64_string: Buffer.from(file.bytes).toString('base64'), filename: `document.${EXT[file.mimeType] ?? 'bin'}` }],
  });
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
  const res = await opts.fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000) });
  const text = await res.text();
  if (!res.ok) {
    throw new WeaveIntelError({ code: res.status === 401 || res.status === 403 ? 'AUTH_FAILED' : 'PROVIDER_ERROR', message: `docling-serve answered ${res.status}.`, provider: 'docling-serve', retryable: res.status >= 500 });
  }
  let parsed: { status?: string; errors?: unknown[]; document?: { md_content?: string; json_content?: DoclingJson } };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: 'docling-serve answered with something that is not JSON.', provider: 'docling-serve' });
  }
  if (parsed.status && parsed.status !== 'success' && parsed.status !== 'partial_success') {
    throw new WeaveIntelError({ code: 'PROVIDER_ERROR', message: `docling-serve could not convert the file (${parsed.status}).`, provider: 'docling-serve' });
  }
  return { ...(parsed.document?.json_content ? { json: parsed.document.json_content } : {}), ...(parsed.document?.md_content ? { md: parsed.document.md_content } : {}) };
}

export function createDoclingServeEngine(opts: DoclingServeOptions): { parser: DocumentParser; ocr: Ocr } {
  const version = opts.version ?? 'v1';
  const prov = (step: Provenance['step']): Provenance => ({ step, engine: 'docling-serve', version, ...(opts.region ? { region: opts.region } : {}) });
  const toDoc = (file: FileBytes, r: { json?: DoclingJson; md?: string }, source: DocumentPage['source']): ParsedDocument => {
    const { pages, tables } = r.json ? doclingJsonToPages(r.json, source) : { pages: [] as DocumentPage[], tables: [] as DocumentTable[] };
    const kind = file.mimeType === 'application/pdf' ? 'pdf' : file.mimeType.startsWith('image/') ? 'image' : 'unknown';
    return {
      kind,
      mimeType: file.mimeType,
      pages: pages.length > 0 ? pages : [{ page: 1, text: r.md ?? '', source }],
      tables,
      warnings: pages.length > 0 ? [] : ['docling-serve returned no page structure; the Markdown is one page.'],
    };
  };
  return {
    parser: {
      id: 'docling-serve',
      version,
      accepts: (m) => ACCEPTS.has(m),
      async parse(file) {
        return toDoc(file, await convert(opts, file, opts.doOcr ?? true), 'parsed');
      },
    },
    ocr: {
      id: 'docling-serve-ocr',
      version,
      accepts: (m) => m === 'application/pdf' || m.startsWith('image/'),
      async read(file) {
        // force_ocr: read what is VISIBLE on the rendered page, ignoring the text layer, for the cross-check.
        const doc = toDoc(file, await convert(opts, file, true, true), 'ocr');
        return { pages: doc.pages, provenance: prov('ocr') };
      },
    },
  };
}
