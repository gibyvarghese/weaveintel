// SPDX-License-Identifier: MIT
/**
 * Excel (.xlsx) reader, in-house: ZIP + XML, no package, nothing recalculated.
 *
 * Reads cached cell values (shared strings, inline strings, numbers, booleans),
 * turns date-formatted numbers into ISO dates, finds each sheet's header row,
 * and returns one table and one page per VISIBLE sheet. Hidden sheets, rows
 * and columns are kept out and reported as `hidden_formatting` findings. A
 * `vbaProject.bin` part is reported as active content. Formulas are never
 * evaluated: the value Excel last saved is used.
 */

import type { HiddenTextFinding } from '@weaveintel/guardrails';
import type { DocumentParser, FileBytes } from './ports.js';
import type { DocumentPage, DocumentTable, ParsedDocument } from './types.js';
import { MIME } from './sniff.js';
import { readZip, type ZipLimits } from './zip.js';
import { attr, childrenNamed, findAll, firstChild, parseXml, textOf } from './xml.js';

export interface XlsxOptions {
  readonly zipLimits?: ZipLimits;
  /** Most cells read per sheet. Default 200,000. */
  readonly maxCellsPerSheet?: number;
  /** Most rows kept per table in the result. Default 10,000. (Large files stream through code, not a model.) */
  readonly maxRowsPerTable?: number;
}

/** "B12" → [row 12, column index 1]. */
export function cellRef(ref: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.toUpperCase());
  if (!m) return { row: 0, col: 0 };
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col: col - 1 };
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Excel serial date (1900 system) → ISO date (or date-time when it has a time part). */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const d = new Date(ms);
  const iso = d.toISOString();
  return serial % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19);
}

/** Pick the header row: the first of the top rows where most cells are distinct, non-numeric text. */
export function findHeaderRow(rows: readonly (readonly string[])[]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i]!.filter((c) => c.trim() !== '');
    if (cells.length < 2) continue;
    const texty = cells.filter((c) => !/^-?[\d.,]+%?$/.test(c.trim()));
    const distinct = new Set(cells.map((c) => c.trim().toLowerCase())).size === cells.length;
    const width = Math.max(...rows.slice(i, i + 5).map((r) => r.filter((c) => c.trim() !== '').length));
    if (distinct && texty.length / cells.length >= 0.8 && cells.length >= Math.ceil(width * 0.6)) return i;
  }
  return 0;
}

export function parseXlsx(bytes: Uint8Array, opts: XlsxOptions = {}): ParsedDocument {
  const zip = readZip(bytes, opts.zipLimits);
  const maxCells = opts.maxCellsPerSheet ?? 200_000;
  const maxRows = opts.maxRowsPerTable ?? 10_000;
  const activeContent: string[] = [];
  const warnings: string[] = [];
  const hidden: HiddenTextFinding[] = [];
  if (zip.entries.some((e) => /vbaProject\.bin$/i.test(e.name))) activeContent.push('macros (vbaProject.bin)');
  if (zip.entries.some((e) => /^xl\/externalLinks\//i.test(e.name))) activeContent.push('external links (ignored)');

  const shared: string[] = zip.has('xl/sharedStrings.xml')
    ? findAll(parseXml(zip.readText('xl/sharedStrings.xml')), 'si').map((si) =>
        // Rich text: only the text runs, never phonetic hints (rPh).
        childrenNamed(si, 'r').length > 0
          ? childrenNamed(si, 'r').map((r) => textOf(firstChild(r, 't') ?? { name: 't', attrs: {}, children: [] })).join('')
          : textOf(firstChild(si, 't') ?? si),
      )
    : [];

  // Styles: which cell formats are dates.
  const dateStyles = new Set<number>();
  if (zip.has('xl/styles.xml')) {
    const styles = parseXml(zip.readText('xl/styles.xml'));
    const custom = new Map<number, string>();
    for (const nf of findAll(styles, 'numFmt')) custom.set(Number(attr(nf, 'numFmtId')), attr(nf, 'formatCode') ?? '');
    const cellXfs = findAll(styles, 'cellXfs')[0];
    childrenNamed(cellXfs ?? { name: '', attrs: {}, children: [] }, 'xf').forEach((xf, idx) => {
      const id = Number(attr(xf, 'numFmtId') ?? 0);
      const code = custom.get(id)?.replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase() ?? '';
      if (BUILTIN_DATE_FORMATS.has(id) || (/[dy]/.test(code) && !/[#0]/.test(code))) dateStyles.add(idx);
    });
  }

  const wb = parseXml(zip.readText('xl/workbook.xml'));
  const rels = zip.has('xl/_rels/workbook.xml.rels') ? findAll(parseXml(zip.readText('xl/_rels/workbook.xml.rels')), 'Relationship') : [];
  const target = new Map(rels.map((r) => [attr(r, 'Id') ?? '', attr(r, 'Target') ?? '']));

  const pages: DocumentPage[] = [];
  const tables: DocumentTable[] = [];
  for (const sheet of findAll(wb, 'sheet')) {
    const name = attr(sheet, 'name') ?? 'Sheet';
    const state = attr(sheet, 'state') ?? 'visible';
    let path = target.get(attr(sheet, 'id') ?? '') ?? '';
    path = path.startsWith('/') ? path.slice(1) : `xl/${path.replace(/^\.\//, '')}`;
    if (!zip.has(path)) {
      warnings.push(`Sheet "${name}" has no data part.`);
      continue;
    }
    const xml = parseXml(zip.readText(path));
    const hiddenCols = new Set<number>();
    for (const col of findAll(xml, 'col')) {
      if (attr(col, 'hidden') === '1' || attr(col, 'hidden') === 'true') {
        for (let k = Number(attr(col, 'min')); k <= Number(attr(col, 'max')); k++) hiddenCols.add(k - 1);
      }
    }
    const grid = new Map<number, string[]>();
    const hiddenRows = new Set<number>();
    let cells = 0;
    let maxCol = 0;
    for (const row of findAll(xml, 'row')) {
      const r = Number(attr(row, 'r'));
      if (attr(row, 'hidden') === '1' || attr(row, 'hidden') === 'true') hiddenRows.add(r);
      for (const c of childrenNamed(row, 'c')) {
        if (++cells > maxCells) {
          warnings.push(`Sheet "${name}" has more than ${maxCells} cells; the rest were not read.`);
          break;
        }
        const ref = cellRef(attr(c, 'r') ?? '');
        const t = attr(c, 't') ?? 'n';
        const v = firstChild(c, 'v');
        let value = '';
        if (t === 's') value = shared[Number(v ? textOf(v) : -1)] ?? '';
        else if (t === 'inlineStr') value = textOf(firstChild(c, 'is') ?? c);
        else if (t === 'b') value = v && textOf(v) === '1' ? 'TRUE' : 'FALSE';
        else if (v) {
          value = textOf(v);
          const style = Number(attr(c, 's') ?? -1);
          if (t === 'n' && dateStyles.has(style) && /^\d+(\.\d+)?$/.test(value)) value = excelSerialToIso(Number(value));
        }
        const rowArr = grid.get(ref.row) ?? [];
        rowArr[ref.col] = value;
        grid.set(ref.row, rowArr);
        maxCol = Math.max(maxCol, ref.col + 1);
      }
    }
    const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
    const visibleRows: { n: number; cells: string[] }[] = [];
    const hiddenText: string[] = [];
    for (const n of rowNumbers) {
      const raw = grid.get(n)!;
      const full = Array.from({ length: maxCol }, (_, k) => raw[k] ?? '');
      const vis = full.filter((_, k) => !hiddenCols.has(k));
      for (const k of hiddenCols) if (full[k]) hiddenText.push(full[k]!);
      if (state !== 'visible' || hiddenRows.has(n)) {
        hiddenText.push(...vis.filter(Boolean));
        continue;
      }
      if (vis.some((x) => x.trim() !== '')) visibleRows.push({ n, cells: vis });
    }
    if (hiddenText.length > 0) {
      hidden.push({
        kind: 'hidden_formatting',
        count: hiddenText.length,
        decoded: hiddenText.join(' ').slice(0, 500),
        location: state !== 'visible' ? `hidden sheet "${name}"` : `hidden rows or columns in "${name}"`,
      });
    }
    if (state !== 'visible') continue;
    const rows = visibleRows.map((r) => r.cells);
    const h = findHeaderRow(rows);
    const page = pages.length + 1;
    const body = rows.slice(h + 1);
    if (body.length > maxRows) warnings.push(`Sheet "${name}" has ${body.length} rows; ${maxRows} are kept in the table.`);
    tables.push({ page, sheet: name, headers: rows[h] ?? [], rows: body.slice(0, maxRows), ...(visibleRows[h] ? { headerRow: visibleRows[h]!.n } : {}) });
    pages.push({ page, label: name, source: 'parsed', text: rows.map((r) => r.join('\t').replace(/\t+$/, '')).join('\n') });
  }

  return { kind: 'xlsx', mimeType: MIME.xlsx, pages, tables, hidden, activeContent, warnings, metadata: {} };
}

export function createXlsxParser(opts: XlsxOptions = {}): DocumentParser {
  return {
    id: 'xlsx-reader',
    version: '1',
    accepts: (m) => m === MIME.xlsx || m === MIME.xlsm,
    async parse(file: FileBytes) {
      const doc = parseXlsx(file.bytes, opts);
      return file.mimeType === MIME.xlsm ? { ...doc, mimeType: MIME.xlsm } : doc;
    },
  };
}
