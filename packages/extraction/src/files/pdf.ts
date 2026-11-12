// SPDX-License-Identifier: MIT
/**
 * PDF text layer readers.
 *
 * 1. `createBasicPdfParser` — in-house and dependency-free. It reads simple,
 *    born-digital PDFs: plain and FlateDecode content streams, object streams,
 *    the page tree, `Tj`/`TJ`/`'`/`"` text operators, and ToUnicode maps for
 *    embedded fonts. It is NOT a full PDF engine (no other filters, no
 *    encryption, approximate spacing). For production text layers use
 *    `createPdfJsParser` with pdfjs-dist.
 *    It also spots the classic hiding tricks in the content stream —
 *    invisible text (render mode 3), white fill, fonts under 1 point — and keeps
 *    that text out of the page text, reporting it as `hidden_formatting`.
 * 2. `createPdfJsParser(pdfjs)` — pdfjs-dist (Apache-2.0) passed in by the host,
 *    with font faces, `eval` and system fonts off. Returns text spans with
 *    page-relative boxes for provenance.
 *
 * Both report active content: JavaScript, open actions, launch actions and
 * embedded files are listed, never run.
 */

import { inflateSync } from 'node:zlib';
import type { HiddenTextFinding } from '@weaveintel/guardrails';
import type { DocumentParser, FileBytes } from './ports.js';
import type { DocumentPage, ParsedDocument, TextSpan } from './types.js';
import { FileLimitError } from './errors.js';
import { MIME } from './sniff.js';

const latin1 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

export function pdfActiveContent(raw: string): string[] {
  const out: string[] = [];
  if (/\/JavaScript\b|\/JS\s*[(<]/.test(raw)) out.push('PDF JavaScript');
  if (/\/OpenAction\b/.test(raw)) out.push('PDF open action');
  if (/\/Launch\b/.test(raw)) out.push('PDF launch action');
  if (/\/EmbeddedFile\b/.test(raw)) out.push('PDF embedded files');
  if (/\/Encrypt\b/.test(raw)) out.push('PDF encryption');
  return out;
}

// ─── The basic in-house reader ───────────────────────────────

interface PdfObject {
  dict: string;
  stream?: Uint8Array;
}

export interface BasicPdfOptions {
  /** Most pages read. Default 500. */
  readonly maxPages?: number;
  /** Most bytes one content stream may inflate to. Default 32 MiB. */
  readonly maxStreamBytes?: number;
  /** Keep invisible / white / tiny text in the page text (it is reported either way). Default false. */
  readonly keepHiddenText?: boolean;
}

function inflate(data: Uint8Array, max: number): Uint8Array {
  try {
    return new Uint8Array(inflateSync(data, { maxOutputLength: max }));
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new FileLimitError('pdf_stream_too_large', 'A PDF stream inflates past the size limit.');
    throw new FileLimitError('pdf_stream_damaged', 'A PDF stream could not be decompressed.');
  }
}

function collectObjects(bytes: Uint8Array, maxStream: number): Map<number, PdfObject> {
  const raw = latin1(bytes);
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = raw.indexOf('endobj', start);
    if (end < 0) break;
    const body = raw.slice(start, end);
    const si = body.search(/\bstream\r?\n/);
    if (si >= 0) {
      const dict = body.slice(0, si);
      const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)![0].length;
      const lenMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let dataEnd = lenMatch ? dataStart + Number(lenMatch[1]) : raw.lastIndexOf('endstream', end);
      if (dataEnd > end || dataEnd < dataStart) dataEnd = raw.lastIndexOf('endstream', end);
      let data = bytes.subarray(dataStart, dataEnd);
      if (/\/Filter\s*\/FlateDecode|\/Filter\s*\[\s*\/FlateDecode\s*\]/.test(dict)) data = inflate(data, maxStream);
      else if (/\/Filter/.test(dict)) data = new Uint8Array(0); // other filters: not read by the basic reader
      objects.set(num, { dict, stream: data });
    } else {
      objects.set(num, { dict: body });
    }
    re.lastIndex = end;
  }
  // Objects packed inside object streams.
  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict) || !obj.stream) continue;
    const n = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const text = latin1(obj.stream);
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const id = header[i * 2]!;
      const off = first + header[i * 2 + 1]!;
      const next = i + 1 < n ? first + header[(i + 1) * 2 + 1]! : text.length;
      if (!objects.has(id)) objects.set(id, { dict: text.slice(off, next) });
    }
  }
  return objects;
}

const refsIn = (s: string): number[] => [...s.matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));

function dictValue(dict: string, key: string): string | undefined {
  const i = dict.search(new RegExp(`/${key}(?![A-Za-z])`));
  if (i < 0) return undefined;
  let s = dict.slice(i + key.length + 1).trimStart();
  if (s.startsWith('<<')) {
    let depth = 0;
    for (let k = 0; k < s.length - 1; k++) {
      if (s[k] === '<' && s[k + 1] === '<') { depth++; k++; }
      else if (s[k] === '>' && s[k + 1] === '>') { depth--; k++; if (depth === 0) return s.slice(0, k + 1); }
    }
    return s;
  }
  if (s.startsWith('[')) return s.slice(0, s.indexOf(']') + 1);
  const ref = /^(\d+\s+\d+\s+R)/.exec(s);
  if (ref) return ref[1];
  return /^[^\s/<>[\]]+|^\/[^\s/<>[\]]+/.exec(s)?.[0];
}

function resolveDict(objects: Map<number, PdfObject>, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const r = /^(\d+)\s+\d+\s+R$/.exec(value.trim());
  return r ? objects.get(Number(r[1]))?.dict : value;
}

/** ToUnicode CMap: bfchar and bfrange → code → text. */
export function parseToUnicode(cmap: string): { map: Map<number, string>; twoByte: boolean } {
  const map = new Map<number, string>();
  const hexToStr = (h: string): string => {
    let out = '';
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    if (h.length % 4 === 2) out += String.fromCharCode(parseInt(h.slice(-2), 16));
    return out;
  };
  let twoByte = false;
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      if (p[1]!.length >= 4) twoByte = true;
      map.set(parseInt(p[1]!, 16), hexToStr(p[2]!));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(p[1]!, 16);
      const hi = parseInt(p[2]!, 16);
      if (p[1]!.length >= 4) twoByte = true;
      if (hi - lo > 65_535) continue;
      if (p[4] !== undefined) {
        const base = hexToStr(p[4]);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
      } else {
        const list = [...p[5]!.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexToStr(x[1]!));
        list.forEach((t, k) => map.set(lo + k, t));
      }
    }
  }
  return { map, twoByte };
}

interface Font { map?: Map<number, string>; twoByte: boolean }

function decodeString(bytes: string, font: Font | undefined): string {
  if (!font?.map) return bytes;
  let out = '';
  const step = font.twoByte ? 2 : 1;
  for (let i = 0; i + step <= bytes.length; i += step) {
    const code = step === 2 ? (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1) : bytes.charCodeAt(i);
    out += font.map.get(code) ?? (step === 1 ? bytes[i] : '');
  }
  return out;
}

type Token = { t: 'str'; v: string } | { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'op'; v: string } | { t: 'arr'; v: Token[] };

/** Tokenise a content stream (strings, hex strings, numbers, names, arrays, operators). */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const stack: Token[][] = [out];
  let i = 0;
  const push = (tok: Token): void => { stack[stack.length - 1]!.push(tok); };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '%') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '(') {
      let depth = 1; let s = ''; i++;
      while (i < src.length && depth > 0) {
        const ch = src[i]!;
        if (ch === '\\') {
          const n = src[i + 1]!;
          const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (esc[n] !== undefined) { s += esc[n]; i += 2; }
          else if (/[0-7]/.test(n)) { const o = /^[0-7]{1,3}/.exec(src.slice(i + 1))![0]; s += String.fromCharCode(parseInt(o, 8)); i += 1 + o.length; }
          else if (n === '\r' || n === '\n') { i += n === '\r' && src[i + 2] === '\n' ? 3 : 2; }
          else { s += n; i += 2; }
          continue;
        }
        if (ch === '(') depth++;
        if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
        s += ch; i++;
      }
      push({ t: 'str', v: s });
      continue;
    }
    if (c === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i);
      const hex = src.slice(i + 1, end < 0 ? src.length : end).replace(/\s/g, '');
      let s = '';
      for (let k = 0; k < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      push({ t: 'str', v: s });
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (c === '<' || c === '>') { i += 2; continue; }
    if (c === '[') { const arr: Token[] = []; push({ t: 'arr', v: arr }); stack.push(arr); i++; continue; }
    if (c === ']') { if (stack.length > 1) stack.pop(); i++; continue; }
    if (c === '/') { const m = /^\/[^\s/<>[\]()%]*/.exec(src.slice(i, i + 128))!; push({ t: 'name', v: m[0].slice(1) }); i += m[0].length; continue; }
    const m = /^[^\s/<>[\]()%]+/.exec(src.slice(i, i + 64));
    if (!m) { i++; continue; }
    const word = m[0];
    i += word.length;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push({ t: 'num', v: Number(word) });
    else push({ t: 'op', v: word });
  }
  return out;
}

interface PageRead { text: string; hidden: string[] }

function readContent(src: string, fonts: Map<string, Font>, keepHidden: boolean): PageRead {
  const tokens = tokenize(src);
  let text = '';
  const hidden: string[] = [];
  let font: Font | undefined;
  let fontSize = 12;
  let renderMode = 0;
  let white = false;
  let lastY: number | undefined;
  const operands: Token[] = [];
  const saved: Array<{ renderMode: number; white: boolean; fontSize: number; font: Font | undefined }> = [];
  const emit = (s: string): void => {
    const invisible = renderMode === 3 || white || Math.abs(fontSize) < 1;
    if (invisible) {
      if (s.trim()) hidden.push(s);
      if (!keepHidden) return;
    }
    text += s;
  };
  const show = (tok: Token | undefined): void => {
    if (!tok) return;
    if (tok.t === 'str') emit(decodeString(tok.v, font));
    else if (tok.t === 'arr') {
      let s = '';
      for (const el of tok.v) {
        if (el.t === 'str') s += decodeString(el.v, font);
        else if (el.t === 'num' && el.v < -200) s += ' ';
      }
      emit(s);
    }
  };
  const nums = (): number[] => operands.filter((o): o is { t: 'num'; v: number } => o.t === 'num').map((o) => o.v);
  for (const tok of tokens) {
    if (tok.t !== 'op') { operands.push(tok); continue; }
    switch (tok.v) {
      case 'BT': break;
      case 'ET': text += '\n'; lastY = undefined; break;
      case 'q': saved.push({ renderMode, white, fontSize, font }); break;
      case 'Q': { const s = saved.pop(); if (s) { renderMode = s.renderMode; white = s.white; fontSize = s.fontSize; font = s.font; } break; }
      case 'Tf': {
        const name = operands.find((o) => o.t === 'name') as { v: string } | undefined;
        font = name ? fonts.get(name.v) : undefined;
        fontSize = nums()[0] ?? fontSize;
        break;
      }
      case 'Tr': renderMode = nums()[0] ?? 0; break;
      case 'rg': { const [r, g, b] = nums(); white = r === 1 && g === 1 && b === 1; break; }
      case 'g': white = nums()[0] === 1; break;
      case 'k': { const [c, m, y, k] = nums(); white = c === 0 && m === 0 && y === 0 && k === 0; break; }
      case 'Td': case 'TD': {
        const [, ty] = nums();
        if (ty !== undefined && ty !== 0) text += '\n'; else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
        break;
      }
      case 'Tm': {
        const y = nums()[5];
        if (lastY !== undefined && y !== undefined && Math.abs(y - lastY) > 0.5) text += '\n';
        else if (text && !text.endsWith('\n') && !text.endsWith(' ')) text += ' ';
        lastY = y;
        break;
      }
      case 'T*': text += '\n'; break;
      case 'Tj': show(operands[operands.length - 1]); break;
      case 'TJ': show(operands[operands.length - 1]); break;
      case "'": text += '\n'; show(operands[operands.length - 1]); break;
      case '"': text += '\n'; show(operands[operands.length - 1]); break;
      default: break;
    }
    operands.length = 0;
  }
  return { text: text.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim(), hidden };
}

export function parsePdfBasic(bytes: Uint8Array, opts: BasicPdfOptions = {}): ParsedDocument {
  const maxPages = opts.maxPages ?? 500;
  const maxStream = opts.maxStreamBytes ?? 32 * 1024 * 1024;
  const raw = latin1(bytes);
  if (!raw.startsWith('%PDF-')) throw new FileLimitError('pdf_malformed', 'The file is not a PDF.');
  const activeContent = pdfActiveContent(raw);
  if (activeContent.includes('PDF encryption')) {
    return { kind: 'pdf', mimeType: MIME.pdf, pages: [], activeContent, warnings: ['The PDF is encrypted; the basic reader cannot read it.'] };
  }
  const objects = collectObjects(bytes, maxStream);
  const rootRef = [...raw.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop()?.[1];
  const warnings: string[] = [];

  // Walk the page tree in order, carrying inherited resources.
  const pageList: Array<{ dict: string; resources?: string }> = [];
  const seen = new Set<number>();
  const visit = (num: number, inherited?: string): void => {
    if (seen.has(num) || pageList.length >= maxPages) return;
    seen.add(num);
    const obj = objects.get(num);
    if (!obj) return;
    const resources = dictValue(obj.dict, 'Resources') ?? inherited;
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      for (const kid of refsIn(dictValue(obj.dict, 'Kids') ?? '')) visit(kid, resources);
    } else if (/\/Type\s*\/Page\b/.test(obj.dict)) {
      pageList.push({ dict: obj.dict, ...(resources ? { resources } : {}) });
    }
  };
  const catalog = rootRef ? objects.get(Number(rootRef)) : undefined;
  const pagesRef = catalog ? refsIn(dictValue(catalog.dict, 'Pages') ?? '')[0] : undefined;
  if (pagesRef !== undefined) visit(pagesRef);
  if (pageList.length === 0) {
    // No usable tree: fall back to every page object in file order.
    for (const obj of objects.values()) if (/\/Type\s*\/Page\b/.test(obj.dict) && pageList.length < maxPages) pageList.push({ dict: obj.dict });
    if (pageList.length > 0) warnings.push('The page tree could not be followed; pages are in file order.');
  }

  const fontCache = new Map<string, Font>();
  const fontsFor = (resources: string | undefined): Map<string, Font> => {
    const out = new Map<string, Font>();
    const res = resolveDict(objects, resources);
    const fontDict = resolveDict(objects, res ? dictValue(res, 'Font') : undefined);
    if (!fontDict) return out;
    for (const m of fontDict.matchAll(/\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g)) {
      const key = m[2]!;
      if (!fontCache.has(key)) {
        const fobj = objects.get(Number(key));
        const tu = fobj ? refsIn(dictValue(fobj.dict, 'ToUnicode') ?? '')[0] : undefined;
        const stream = tu !== undefined ? objects.get(tu)?.stream : undefined;
        fontCache.set(key, stream ? parseToUnicode(latin1(stream)) : { twoByte: /Identity-H/.test(fobj?.dict ?? '') });
      }
      out.set(m[1]!, fontCache.get(key)!);
    }
    return out;
  };

  const pages: DocumentPage[] = [];
  const hiddenAll: { page: number; text: string }[] = [];
  pageList.forEach((pg, idx) => {
    const contents = dictValue(pg.dict, 'Contents');
    let ids = refsIn(contents ?? '');
    // `/Contents 7 0 R` may point at an array object.
    if (ids.length === 1 && !objects.get(ids[0]!)?.stream) ids = refsIn(objects.get(ids[0]!)?.dict ?? '');
    const src = ids.map((id) => (objects.get(id)?.stream ? latin1(objects.get(id)!.stream!) : '')).join('\n');
    const r = readContent(src, fontsFor(pg.resources), opts.keepHiddenText ?? false);
    pages.push({ page: idx + 1, text: r.text, source: 'text_layer' });
    for (const h of r.hidden) hiddenAll.push({ page: idx + 1, text: h });
  });

  const hidden: HiddenTextFinding[] = [];
  const byPage = new Map<number, string[]>();
  for (const h of hiddenAll) byPage.set(h.page, [...(byPage.get(h.page) ?? []), h.text]);
  for (const [page, list] of byPage) {
    hidden.push({ kind: 'hidden_formatting', count: list.length, decoded: list.join(' ').slice(0, 500), location: `page ${page} (invisible, white or sub-1pt text)` });
  }
  if (pages.every((p) => p.text === '')) warnings.push('No text layer was found (a scan, or filters the basic reader does not read): OCR is needed.');
  const title = /\/Title\s*\(([^)]*)\)/.exec(raw)?.[1];
  return { kind: 'pdf', mimeType: MIME.pdf, pages, hidden, activeContent, warnings, metadata: title ? { title } : {} };
}

export function createBasicPdfParser(opts: BasicPdfOptions = {}): DocumentParser {
  return {
    id: 'pdf-basic',
    version: '1',
    accepts: (m) => m === MIME.pdf,
    async parse(file: FileBytes) {
      return parsePdfBasic(file.bytes, opts);
    },
  };
}

// ─── pdfjs-dist adapter (module passed in) ───────────────────

/** The part of pdfjs-dist's API this adapter uses (pdfjs-dist 4.x and 5.x, `legacy/build/pdf.mjs` in Node). */
export interface PdfJsLike {
  getDocument(params: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getViewport(o: { scale: number }): { width: number; height: number };
        getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean }> }>;
        cleanup?(): void;
      }>;
      getMetadata?(): Promise<{ info?: Record<string, unknown> }>;
      destroy(): Promise<void>;
    }>;
  };
  version?: string;
}

export function createPdfJsParser(pdfjs: PdfJsLike, opts: { maxPages?: number } = {}): DocumentParser {
  return {
    id: 'pdfjs',
    version: pdfjs.version ?? '5',
    accepts: (m) => m === MIME.pdf,
    async parse(file: FileBytes): Promise<ParsedDocument> {
      // pdfjs takes ownership of the buffer: hand it a copy.
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(file.bytes),
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        stopAtErrors: false,
        verbosity: 0,
      }).promise;
      try {
        const n = Math.min(doc.numPages, opts.maxPages ?? 500);
        const pages: DocumentPage[] = [];
        for (let i = 1; i <= n; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          const spans: TextSpan[] = [];
          let text = '';
          for (const item of content.items) {
            if (typeof item.str !== 'string') continue;
            text += item.str + (item.hasEOL ? '\n' : '');
            if (item.str.trim() && item.transform) {
              const [, , , , x = 0, y = 0] = item.transform;
              const h = item.height ?? Math.abs(item.transform[3] ?? 0);
              spans.push({
                text: item.str,
                region: {
                  x: Math.max(0, x / vp.width),
                  y: Math.max(0, (vp.height - y - h) / vp.height),
                  width: Math.min(1, (item.width ?? 0) / vp.width),
                  height: Math.min(1, h / vp.height),
                },
              });
            }
          }
          pages.push({ page: i, text: text.replace(/[ \t]+\n/g, '\n').trim(), source: 'text_layer', spans });
          page.cleanup?.();
        }
        const raw = latin1(file.bytes.subarray(0, Math.min(file.bytes.length, 8 * 1024 * 1024)));
        const info = (await doc.getMetadata?.())?.info ?? {};
        const metadata: Record<string, string> = {};
        if (typeof info['Title'] === 'string' && info['Title']) metadata['title'] = info['Title'];
        if (typeof info['Author'] === 'string' && info['Author']) metadata['author'] = info['Author'];
        const warnings = doc.numPages > n ? [`The PDF has ${doc.numPages} pages; ${n} were read.`] : [];
        if (pages.every((p) => p.text === '')) warnings.push('No text layer was found: OCR is needed.');
        return { kind: 'pdf', mimeType: MIME.pdf, pages, metadata, activeContent: pdfActiveContent(raw), warnings };
      } finally {
        await doc.destroy();
      }
    },
  };
}
