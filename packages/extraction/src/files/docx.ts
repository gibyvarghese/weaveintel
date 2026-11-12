// SPDX-License-Identifier: MIT
/**
 * Word (.docx) reader, in-house: ZIP + XML, no package, no macro ever run.
 *
 * Reads paragraphs, tabs, line and page breaks, and tables from the body,
 * headers and footers. Text a person would not see is kept OUT of the page
 * text and reported as a `hidden_formatting` finding instead: hidden runs
 * (`w:vanish`), white text, text under 2 points, deleted tracked changes and
 * comments. A `vbaProject.bin` part is reported as active content.
 */

import type { HiddenTextFinding } from '@weaveintel/guardrails';
import type { DocumentParser, FileBytes } from './ports.js';
import type { DocumentPage, DocumentTable, ParsedDocument } from './types.js';
import { MIME } from './sniff.js';
import { readZip, type ZipLimits } from './zip.js';
import { attr, childrenNamed, findAll, firstChild, local, parseXml, textOf, type XmlElement } from './xml.js';

export interface DocxOptions {
  readonly zipLimits?: ZipLimits;
  /** Keep hidden text in the page text (it is reported either way). Default false. */
  readonly keepHiddenText?: boolean;
}

interface Collect {
  pages: string[];
  hidden: Map<string, string[]>;
  keepHidden: boolean;
}

function runHiddenReason(run: XmlElement): string | undefined {
  const rPr = firstChild(run, 'rPr');
  if (!rPr) return undefined;
  const vanish = firstChild(rPr, 'vanish') ?? firstChild(rPr, 'specVanish');
  if (vanish && attr(vanish, 'val') !== '0' && attr(vanish, 'val') !== 'false') return 'hidden run';
  const color = firstChild(rPr, 'color');
  const val = color ? attr(color, 'val')?.toUpperCase() : undefined;
  if (val === 'FFFFFF' || val === 'FFFFFE') return 'white text';
  const sz = firstChild(rPr, 'sz');
  const half = sz ? Number(attr(sz, 'val')) : NaN;
  if (Number.isFinite(half) && half < 4) return 'text under 2 points';
  return undefined;
}

function addHidden(c: Collect, reason: string, text: string): void {
  if (!text.trim()) return;
  const list = c.hidden.get(reason) ?? [];
  list.push(text);
  c.hidden.set(reason, list);
}

/** Text of a paragraph, appending to the current page and starting new pages at page breaks. */
function paragraph(p: XmlElement, c: Collect): void {
  const append = (s: string): void => {
    c.pages[c.pages.length - 1] += s;
  };
  const visit = (el: XmlElement, hiddenBy?: string): void => {
    for (const child of el.children) {
      if (typeof child === 'string') continue;
      const n = local(child.name);
      if (n === 'r') {
        const reason = hiddenBy ?? runHiddenReason(child);
        for (const part of child.children) {
          if (typeof part === 'string') continue;
          const pn = local(part.name);
          if (pn === 't') {
            const t = textOf(part);
            if (reason) {
              addHidden(c, reason, t);
              if (c.keepHidden) append(t);
            } else append(t);
          } else if (pn === 'delText') {
            addHidden(c, 'deleted tracked change', textOf(part));
          } else if (pn === 'tab') append('\t');
          else if (pn === 'br' || pn === 'cr') {
            if (attr(part, 'type') === 'page') c.pages.push('');
            else append('\n');
          } else if (pn === 'lastRenderedPageBreak') {
            c.pages.push('');
          }
        }
      } else if (n === 'del') {
        visit(child, 'deleted tracked change');
      } else if (n === 'hyperlink' || n === 'ins' || n === 'smartTag' || n === 'sdt' || n === 'sdtContent' || n === 'fldSimple') {
        visit(child, hiddenBy);
      }
    }
  };
  visit(p);
  append('\n');
}

function tableOf(tbl: XmlElement, c: Collect, page: number): DocumentTable {
  const rows: string[][] = [];
  for (const tr of childrenNamed(tbl, 'tr')) {
    const row: string[] = [];
    for (const tc of childrenNamed(tr, 'tc')) {
      const inner: Collect = { pages: [''], hidden: c.hidden, keepHidden: c.keepHidden };
      for (const p of findAll(tc, 'p')) paragraph(p, inner);
      row.push(inner.pages.join('').trim());
    }
    rows.push(row);
  }
  const [headers = [], ...rest] = rows;
  return { page, headers, rows: rest, headerRow: 1 };
}

function body(root: XmlElement, c: Collect, tables: DocumentTable[]): void {
  const container = findAll(root, 'body')[0] ?? root;
  const visit = (el: XmlElement): void => {
    for (const child of el.children) {
      if (typeof child === 'string') continue;
      const n = local(child.name);
      if (n === 'p') paragraph(child, c);
      else if (n === 'tbl') {
        const t = tableOf(child, c, c.pages.length);
        tables.push(t);
        // Tables also appear in the page text, one row per line, cells by tab.
        c.pages[c.pages.length - 1] += [t.headers, ...t.rows].map((r) => r.join('\t')).join('\n') + '\n';
      } else if (n === 'sdt' || n === 'sdtContent' || n === 'customXml') visit(child);
    }
  };
  visit(container);
}

export function parseDocx(bytes: Uint8Array, opts: DocxOptions = {}): ParsedDocument {
  const zip = readZip(bytes, opts.zipLimits);
  const c: Collect = { pages: [''], hidden: new Map(), keepHidden: opts.keepHiddenText ?? false };
  const tables: DocumentTable[] = [];
  const warnings: string[] = [];
  const activeContent: string[] = [];

  if (zip.entries.some((e) => /vbaProject\.bin$/i.test(e.name))) activeContent.push('macros (vbaProject.bin)');
  if (zip.entries.some((e) => /^word\/embeddings\//i.test(e.name))) activeContent.push('embedded objects (word/embeddings)');

  const headerParts = zip.entries.map((e) => e.name).filter((n) => /^word\/header\d*\.xml$/.test(n));
  const footerParts = zip.entries.map((e) => e.name).filter((n) => /^word\/footer\d*\.xml$/.test(n));

  body(parseXml(zip.readText('word/document.xml')), c, tables);

  const extra = (parts: string[], label: string): string => {
    const out: Collect = { pages: [''], hidden: c.hidden, keepHidden: c.keepHidden };
    for (const part of parts) for (const p of findAll(parseXml(zip.readText(part)), 'p')) paragraph(p, out);
    const text = out.pages.join('').trim();
    return text ? `[${label}]\n${text}\n` : '';
  };
  const headerText = extra(headerParts, 'header');
  const footerText = extra(footerParts, 'footer');

  if (zip.has('word/comments.xml')) {
    const comments = findAll(parseXml(zip.readText('word/comments.xml')), 'comment').map((cm) => textOf(cm).trim()).filter(Boolean);
    for (const t of comments) addHidden(c, 'comment', t);
  }

  const metadata: Record<string, string> = {};
  if (zip.has('docProps/core.xml')) {
    const core = parseXml(zip.readText('docProps/core.xml'));
    for (const el of findAll(core, 'title')) metadata['title'] = textOf(el).trim();
    for (const el of findAll(core, 'creator')) metadata['author'] = textOf(el).trim();
    for (const el of findAll(core, 'subject')) metadata['subject'] = textOf(el).trim();
  }

  // Pages: drop empty ones made by consecutive breaks; header/footer go on the first page.
  const texts = c.pages.map((t) => t.replace(/\n{3,}/g, '\n\n').trim());
  const nonEmpty = texts.filter((t, i) => t !== '' || i === 0);
  const pages: DocumentPage[] = nonEmpty.map((text, i) => ({
    page: i + 1,
    text: i === 0 ? `${headerText}${text}${footerText ? `\n${footerText}` : ''}`.trim() : text,
    source: 'parsed',
  }));
  if (c.pages.length === 1) warnings.push('Word files carry no fixed pages; page numbers follow the page breaks Word recorded, so they may differ from print.');

  const hidden: HiddenTextFinding[] = [...c.hidden.entries()].map(([reason, list]) => ({
    kind: 'hidden_formatting',
    count: list.length,
    decoded: list.join(' ').slice(0, 500),
    location: reason,
  }));

  return { kind: 'docx', mimeType: MIME.docx, pages, tables, metadata, hidden, activeContent, warnings };
}

export function createDocxParser(opts: DocxOptions = {}): DocumentParser {
  return {
    id: 'docx-reader',
    version: '1',
    accepts: (m) => m === MIME.docx || m === MIME.docm,
    async parse(file: FileBytes) {
      const doc = parseDocx(file.bytes, opts);
      return file.mimeType === MIME.docm ? { ...doc, mimeType: MIME.docm } : doc;
    },
  };
}
