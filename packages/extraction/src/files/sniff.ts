// SPDX-License-Identifier: MIT
/**
 * Work out what a file really is from its first bytes, to pick a parser.
 *
 * This is a reader's sniff, not the intake gate: the full magic-byte table,
 * the declared-vs-sniffed refusal and the allow-lists live in schemaWeave's
 * safe intake. Here a mismatch is only reported, and the sniffed type wins.
 */

import { looksLikeZip, readZip } from './zip.js';

export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  docm: 'application/vnd.ms-word.document.macroEnabled.12',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  eml: 'message/rfc822',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  csv: 'text/csv',
  html: 'text/html',
  text: 'text/plain',
  ole: 'application/x-ole-storage',
  octet: 'application/octet-stream',
} as const;

const starts = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));

export interface SniffResult {
  readonly mimeType: string;
  /** Set when the declared type disagrees with what the bytes are. */
  readonly mismatch?: { readonly declared: string; readonly sniffed: string };
}

function ooxmlKind(bytes: Uint8Array): string {
  try {
    const zip = readZip(bytes, { maxEntries: 5000 });
    const ct = zip.has('[Content_Types].xml') ? zip.readText('[Content_Types].xml') : '';
    if (zip.has('word/document.xml')) return ct.includes('macroEnabled') ? MIME.docm : MIME.docx;
    if (zip.has('xl/workbook.xml')) return ct.includes('macroEnabled') ? MIME.xlsm : MIME.xlsx;
    if (zip.has('ppt/presentation.xml')) return MIME.pptx;
    return MIME.zip;
  } catch {
    return MIME.zip;
  }
}

function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  if (n === 0) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = bytes[i]!;
    if (c === 0) return false;
    if (c < 0x09 || (c > 0x0d && c < 0x20)) bad++;
  }
  if (bad / n > 0.02) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, n - 4 > 0 ? n - 4 : n));
    return true;
  } catch {
    return false;
  }
}

function textKind(bytes: Uint8Array): string {
  const head = new TextDecoder('utf-8').decode(bytes.subarray(0, 2048));
  if (/^\s*<(!doctype html|html|head|body)\b/i.test(head)) return MIME.html;
  if (/^(received|return-path|from|to|subject|date|message-id|mime-version|delivered-to|x-[\w-]+):/im.test(head.split(/\r?\n\r?\n/)[0] ?? '') &&
      /^(from|subject|date|message-id):/im.test(head)) return MIME.eml;
  const lines = head.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 6);
  if (lines.length >= 2) {
    for (const sep of [',', ';', '\t']) {
      const counts = lines.map((l) => l.split(sep).length - 1);
      if (counts[0]! >= 1 && counts.every((c) => c === counts[0])) return MIME.csv;
    }
  }
  return MIME.text;
}

export function sniffMimeType(bytes: Uint8Array, declared?: string): SniffResult {
  let sniffed: string = MIME.octet;
  if (ascii(bytes, 0, 5) === '%PDF-') sniffed = MIME.pdf;
  else if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) sniffed = MIME.png;
  else if (starts(bytes, [0xff, 0xd8, 0xff])) sniffed = MIME.jpeg;
  else if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') sniffed = MIME.gif;
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') sniffed = MIME.webp;
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') sniffed = MIME.wav;
  else if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) sniffed = MIME.mp3;
  else if (ascii(bytes, 0, 4) === 'OggS') sniffed = MIME.ogg;
  else if (ascii(bytes, 4, 8) === 'ftyp' && /^(M4A |M4B |mp42|isom)/.test(ascii(bytes, 8, 12))) sniffed = MIME.m4a;
  else if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) sniffed = MIME.ole;
  else if (looksLikeZip(bytes)) sniffed = ooxmlKind(bytes);
  else if (looksLikeText(bytes)) sniffed = textKind(bytes);

  const d = declared?.split(';')[0]!.trim().toLowerCase();
  // A text type declared for text bytes is not a disagreement (markdown, json ...).
  const compatible = !d || d === sniffed || (sniffed.startsWith('text/') && (d.startsWith('text/') || d === 'application/json'));
  return compatible ? { mimeType: sniffed === MIME.text && d?.startsWith('text/') ? d : sniffed } : { mimeType: sniffed, mismatch: { declared: d!, sniffed } };
}
