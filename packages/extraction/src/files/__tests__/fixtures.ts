// SPDX-License-Identifier: MIT
/** Builders for test files, made in memory so no binary fixture is checked in. */

import { deflateSync } from 'node:zlib';
import { writeZip } from '../zip.js';

const enc = new TextEncoder();

export const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A .docx whose body is the given WordprocessingML (inside <w:body>). */
export async function makeDocx(bodyXml: string, extra: Record<string, string> = {}): Promise<Uint8Array> {
  return writeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${bodyXml}</w:body></w:document>`,
    'docProps/core.xml': '<cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:title>Test doc</dc:title><dc:creator>A. Author</dc:creator></cp:coreProperties>',
    ...extra,
  }, { deflate: true });
}

export const para = (...runs: string[]): string => `<w:p>${runs.join('')}</w:p>`;
export const run = (text: string, rPr = ''): string => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;

export interface SheetSpec {
  readonly name: string;
  readonly rows: readonly (readonly (string | number)[])[];
  readonly state?: 'hidden' | 'veryHidden';
  readonly hiddenRows?: readonly number[];
  readonly hiddenCols?: readonly number[];
  /** Columns (0-based) whose numbers are dates (style 1 = numFmt 14). */
  readonly dateCols?: readonly number[];
}

const colName = (i: number): string => {
  let s = '';
  let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/** A .xlsx with shared strings, optional hidden sheets/rows/cols and date-styled columns. */
export async function makeXlsx(sheets: readonly SheetSpec[], extra: Record<string, string> = {}): Promise<Uint8Array> {
  const shared: string[] = [];
  const sid = (s: string): number => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const files: Record<string, string> = {};
  sheets.forEach((sh, k) => {
    const rows = sh.rows.map((r, ri) => {
      const n = ri + 1;
      const cells = r.map((v, ci) => {
        const ref = `${colName(ci)}${n}`;
        if (typeof v === 'number') return `<c r="${ref}"${sh.dateCols?.includes(ci) ? ' s="1"' : ''}><v>${v}</v></c>`;
        return v === '' ? '' : `<c r="${ref}" t="s"><v>${sid(v)}</v></c>`;
      }).join('');
      return `<row r="${n}"${sh.hiddenRows?.includes(n) ? ' hidden="1"' : ''}>${cells}</row>`;
    }).join('');
    const cols = sh.hiddenCols?.length ? `<cols>${sh.hiddenCols.map((c) => `<col min="${c + 1}" max="${c + 1}" hidden="1"/>`).join('')}</cols>` : '';
    files[`xl/worksheets/sheet${k + 1}.xml`] = `<worksheet>${cols}<sheetData>${rows}</sheetData></worksheet>`;
  });
  files['xl/workbook.xml'] = `<workbook xmlns:r="r"><sheets>${sheets.map((s, k) => `<sheet name="${s.name}" sheetId="${k + 1}" r:id="rId${k + 1}"${s.state ? ` state="${s.state}"` : ''}/>`).join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] = `<Relationships>${sheets.map((_s, k) => `<Relationship Id="rId${k + 1}" Target="worksheets/sheet${k + 1}.xml"/>`).join('')}</Relationships>`;
  files['xl/sharedStrings.xml'] = `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`;
  files['xl/styles.xml'] = '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>';
  files['[Content_Types].xml'] = '<Types/>';
  return writeZip({ ...files, ...extra }, { deflate: true });
}

/** A PDF from per-page content streams (optionally FlateDecode, optionally with a ToUnicode font). */
export function makePdf(pages: readonly string[], opts: { deflate?: boolean; extraCatalog?: string; toUnicode?: string; trailerExtra?: string } = {}): Uint8Array {
  const objs: Array<{ dict: string; stream?: Uint8Array }> = [];
  const add = (dict: string, stream?: Uint8Array): number => { objs.push({ dict, ...(stream ? { stream } : {}) }); return objs.length; };
  const catalog = add('');
  const pagesObj = add('');
  const fontStreamId = opts.toUnicode ? add('', enc.encode(opts.toUnicode)) : undefined;
  const font = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica${fontStreamId ? ` /ToUnicode ${fontStreamId} 0 R` : ''} >>`);
  const pageIds: number[] = [];
  for (const content of pages) {
    const raw = enc.encode(content);
    const data = opts.deflate ? new Uint8Array(deflateSync(raw)) : raw;
    const c = add(`<< /Length ${data.length}${opts.deflate ? ' /Filter /FlateDecode' : ''} >>`, data);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1]!.dict = `<< /Type /Catalog /Pages ${pagesObj} 0 R${opts.extraCatalog ?? ''} >>`;
  objs[pagesObj - 1]!.dict = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const chunks: Uint8Array[] = [enc.encode('%PDF-1.7\n')];
  let len = chunks[0]!.length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(len);
    const dict = o.stream && !o.dict ? `<< /Length ${o.stream.length} >>` : o.dict;
    const head = enc.encode(`${i + 1} 0 obj\n${dict}\n${o.stream ? 'stream\n' : ''}`);
    const tail = enc.encode(`${o.stream ? '\nendstream' : ''}\nendobj\n`);
    chunks.push(head, ...(o.stream ? [o.stream] : []), tail);
    len += head.length + (o.stream?.length ?? 0) + tail.length;
  });
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${opts.trailerExtra ?? ''} >>\nstartxref\n${len}\n%%EOF\n`;
  chunks.push(enc.encode(xref));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** A simple text page: lines drawn top-down. */
export const textPage = (...lines: string[]): string =>
  `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? '0 -16 Td ' : ''}(${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj`).join(' ')} ET`;

export function makeEml(parts: { headers: Record<string, string>; body: string }): Uint8Array {
  const head = Object.entries(parts.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return enc.encode(`${head}\r\n\r\n${parts.body}`);
}

/** Encode ASCII as invisible Unicode tag characters. */
export const tags = (s: string): string => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
