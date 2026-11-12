// SPDX-License-Identifier: MIT
/**
 * E-mail (.eml) and plain text / CSV / HTML readers.
 *
 * The e-mail reader is in-house: headers (folded lines, RFC 2047 encoded
 * words), nested multipart bodies, base64 and quoted-printable, charsets via
 * `TextDecoder`, attachment names (RFC 2231), and forwarded messages. Depth and
 * part count are capped. Attachments are RETURNED (bytes, type, name, depth);
 * the service decides whether to read them, up to its own depth limit.
 *
 * `createPostalMimeParser` wraps PostalMime (MIT-0) when the host has it: the
 * class is passed in, so this package does not depend on it.
 */

import type { HiddenTextFinding } from '@weaveintel/guardrails';
import type { DocumentParser, FileBytes } from './ports.js';
import type { DocumentAttachment, ParsedDocument } from './types.js';
import { FileLimitError } from './errors.js';
import { MIME } from './sniff.js';
import { decodeEntities } from './xml.js';

// ─── Text, CSV, HTML ─────────────────────────────────────────

export function decodeText(bytes: Uint8Array, charset = 'utf-8'): string {
  let label = charset.trim().toLowerCase().replace(/^"|"$/g, '');
  if (label === 'us-ascii' || label === 'ascii') label = 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const HIDDEN_STYLE = /(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:\.\d+)?(px|pt|em)?\s*(;|$)|opacity\s*:\s*0(\.0+)?\s*(;|$)|color\s*:\s*(#fff(fff)?|white)\b)/i;

/**
 * HTML to plain text. Scripts, styles and comments are dropped; elements styled
 * to be invisible (display:none, visibility:hidden, zero size or opacity, white
 * text) and the `hidden` attribute are kept out and reported.
 */
export function htmlToText(html: string): { text: string; hidden: HiddenTextFinding[] } {
  const hiddenParts: string[] = [];
  let s = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1\s*>/gi, '');
  // Remove invisible elements: find each opening tag styled to be invisible and
  // cut to its matching close tag (counting nested tags of the same name).
  const OPEN = /<([a-z][\w-]*)\b([^>]*)>/gi;
  for (let guard = 0; guard < 1000; guard++) {
    OPEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    let cut: { from: number; to: number } | undefined;
    while ((m = OPEN.exec(s)) !== null) {
      const attrs = m[2] ?? '';
      if (attrs.trimEnd().endsWith('/')) continue;
      const style = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
      const isHidden = /\shidden(\s|=|$)/i.test(` ${attrs}`) || (style !== null && HIDDEN_STYLE.test(style[2] ?? style[3] ?? ''));
      if (!isHidden) continue;
      const tag = m[1]!.toLowerCase();
      const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
      re.lastIndex = m.index + m[0].length;
      let depth = 1;
      let t: RegExpExecArray | null;
      let to = s.length;
      while ((t = re.exec(s)) !== null) {
        depth += t[1] ? -1 : 1;
        if (depth === 0) { to = t.index + t[0].length; break; }
      }
      cut = { from: m.index, to };
      break;
    }
    if (!cut) break;
    const inner = decodeEntities(s.slice(cut.from, cut.to).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (inner) hiddenParts.push(inner);
    s = `${s.slice(0, cut.from)} ${s.slice(cut.to)}`;
  }
  const text = decodeEntities(
    s
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article|blockquote)\s*>/gi, '\n')
      .replace(/<(td|th)\b[^>]*>/gi, '\t')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return {
    text,
    hidden: hiddenParts.length > 0 ? [{ kind: 'hidden_formatting', count: hiddenParts.length, decoded: hiddenParts.join(' ').slice(0, 500), location: 'invisible HTML' }] : [],
  };
}

export function createTextParser(): DocumentParser {
  return {
    id: 'text-reader',
    version: '1',
    accepts: (m) => m.startsWith('text/') || m === 'application/json',
    async parse(file: FileBytes): Promise<ParsedDocument> {
      const raw = decodeText(file.bytes);
      if (file.mimeType === MIME.html) {
        const { text, hidden } = htmlToText(raw);
        return { kind: 'html', mimeType: MIME.html, pages: [{ page: 1, text, source: 'parsed' }], hidden };
      }
      const kind = file.mimeType === MIME.csv ? 'csv' : 'text';
      const tables =
        kind === 'csv'
          ? (() => {
              const rows = parseCsv(raw);
              const [headers = [], ...rest] = rows;
              return [{ page: 1, headers, rows: rest, headerRow: 1 }];
            })()
          : [];
      return { kind, mimeType: file.mimeType, pages: [{ page: 1, text: raw, source: 'parsed' }], tables };
    },
  };
}

/** RFC 4180 CSV (quoted fields, doubled quotes, embedded newlines). The separator is guessed from the first line. */
export function parseCsv(text: string, sep?: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = sep ?? ([',', ';', '\t'].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0]);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

// ─── MIME ────────────────────────────────────────────────────

export interface EmailLimits {
  /** Deepest nesting of multiparts and forwarded messages. Default 8. */
  readonly maxDepth?: number;
  /** Most parts in one message. Default 200. */
  readonly maxParts?: number;
}

interface MimePart {
  headers: Map<string, string>;
  body: Uint8Array;
}

const latin1 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};
const fromLatin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** RFC 2047 words: =?charset?B?...?= and =?charset?Q?...?=. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
      const bytes = enc.toUpperCase() === 'B'
        ? Uint8Array.from(Buffer.from(data, 'base64'))
        : fromLatin1(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))));
      return decodeText(bytes, charset.split('*')[0]);
    });
}

function splitHeaders(raw: string): { headers: Map<string, string>; bodyStart: number } {
  const m = /\r?\n\r?\n/.exec(raw);
  const headEnd = m ? m.index : raw.length;
  const bodyStart = m ? m.index + m[0].length : raw.length;
  const headers = new Map<string, string>();
  const unfolded = raw.slice(0, headEnd).replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const c = line.indexOf(':');
    if (c <= 0) continue;
    const key = line.slice(0, c).trim().toLowerCase();
    if (!headers.has(key)) headers.set(key, line.slice(c + 1).trim());
  }
  return { headers, bodyStart };
}

/** `type/subtype; a=b; c="d"` → { value, params }. Handles RFC 2231 `name*=utf-8''...`. */
export function headerParams(value: string | undefined): { value: string; params: Record<string, string> } {
  if (!value) return { value: '', params: {} };
  const [first, ...rest] = value.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    let k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
    const continued = /\*\d+\*?$/.test(k);
    if (k.endsWith('*')) {
      // RFC 2231: charset'language'percent-encoded
      k = k.slice(0, -1).replace(/\*\d+$/, '');
      const m = /^([^']*)'[^']*'(.*)$/.exec(v);
      const pct = (x: string): Uint8Array => fromLatin1(x.replace(/%([0-9A-Fa-f]{2})/g, (_y, h: string) => String.fromCharCode(parseInt(h, 16))));
      v = m ? decodeText(pct(m[2]!), m[1] || 'utf-8') : decodeText(pct(v));
    } else k = k.replace(/\*\d+$/, '');
    params[k] = continued && params[k] ? params[k] + v : v;
  }
  return { value: first!.trim().toLowerCase(), params };
}

function decodeBody(part: MimePart): Uint8Array {
  const enc = (part.headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  if (enc === 'base64') return Uint8Array.from(Buffer.from(latin1(part.body).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'));
  if (enc === 'quoted-printable') {
    const s = latin1(part.body).replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    return fromLatin1(s);
  }
  return part.body;
}

function parsePart(bytes: Uint8Array): MimePart {
  const raw = latin1(bytes);
  const { headers, bodyStart } = splitHeaders(raw);
  return { headers, body: bytes.subarray(bodyStart) };
}

export interface ParsedEmail {
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly html?: string;
  readonly attachments: DocumentAttachment[];
  readonly hidden: HiddenTextFinding[];
}

export function parseEmail(bytes: Uint8Array, limits: EmailLimits = {}): ParsedEmail {
  const maxDepth = limits.maxDepth ?? 8;
  const maxParts = limits.maxParts ?? 200;
  let parts = 0;
  const texts: string[] = [];
  const htmls: string[] = [];
  const attachments: DocumentAttachment[] = [];

  const walk = (part: MimePart, depth: number, attachmentDepth: number): void => {
    if (++parts > maxParts) throw new FileLimitError('email_too_many_parts', `The message has more than ${maxParts} parts.`);
    if (depth > maxDepth) throw new FileLimitError('email_too_deep', `The message is nested more than ${maxDepth} levels deep.`);
    const ct = headerParams(part.headers.get('content-type') ?? 'text/plain');
    const cd = headerParams(part.headers.get('content-disposition'));
    const filename = decodeEncodedWords(cd.params['filename'] ?? ct.params['name'] ?? '') || undefined;
    if (ct.value.startsWith('multipart/')) {
      const boundary = ct.params['boundary'];
      if (!boundary) return;
      const raw = latin1(part.body);
      const delim = `--${boundary}`;
      const pieces = raw.split(new RegExp(`(?:^|\\r?\\n)${delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
      const children = pieces.slice(1, pieces.length).filter((p) => p.trim() !== '' && !p.startsWith('--'));
      const isAlternative = ct.value === 'multipart/alternative';
      if (isAlternative) {
        const parsed = children.map((c) => parsePart(fromLatin1(c)));
        const plain = parsed.find((p) => headerParams(p.headers.get('content-type')).value === 'text/plain');
        const chosen = plain ?? parsed.find((p) => headerParams(p.headers.get('content-type')).value === 'text/html') ?? parsed[0];
        if (chosen) walk(chosen, depth + 1, attachmentDepth);
        // The HTML alternative is still read for hidden content.
        const html = parsed.find((p) => p !== chosen && headerParams(p.headers.get('content-type')).value === 'text/html');
        if (html) htmls.push(decodeText(decodeBody(html), headerParams(html.headers.get('content-type')).params['charset']));
        return;
      }
      for (const c of children) walk(parsePart(fromLatin1(c)), depth + 1, attachmentDepth);
      return;
    }
    const body = decodeBody(part);
    const isAttachment = cd.value === 'attachment' || (filename !== undefined && !ct.value.startsWith('text/'));
    if (ct.value === 'message/rfc822' || isAttachment) {
      attachments.push({ ...(filename ? { filename } : {}), mimeType: ct.value || MIME.octet, bytes: body, depth: attachmentDepth + 1 });
      return;
    }
    const decoded = decodeText(body, ct.params['charset']);
    if (ct.value === 'text/html') htmls.push(decoded);
    else texts.push(decoded);
  };

  const top = parsePart(bytes);
  walk(top, 0, 0);
  const hidden: HiddenTextFinding[] = [];
  let text = texts.join('\n\n').trim();
  for (const h of htmls) {
    const r = htmlToText(h);
    hidden.push(...r.hidden);
    if (!text) text = r.text;
  }
  const headers: Record<string, string> = {};
  for (const k of ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'reply-to']) {
    const v = top.headers.get(k);
    if (v) headers[k] = decodeEncodedWords(v);
  }
  return { headers, text, ...(htmls[0] ? { html: htmls[0] } : {}), attachments, hidden };
}

function emailDocument(e: ParsedEmail): ParsedDocument {
  const head = ['from', 'to', 'cc', 'date', 'subject'].filter((k) => e.headers[k]).map((k) => `${k[0]!.toUpperCase()}${k.slice(1)}: ${e.headers[k]}`).join('\n');
  return {
    kind: 'email',
    mimeType: MIME.eml,
    pages: [{ page: 1, label: 'message', source: 'parsed', text: `${head}\n\n${e.text}`.trim() }],
    attachments: e.attachments,
    metadata: { ...e.headers },
    hidden: e.hidden,
    warnings: e.attachments.length > 0 ? [`${e.attachments.length} attachment(s) were found and returned, not read here.`] : [],
  };
}

export function createEmailParser(limits: EmailLimits = {}): DocumentParser {
  return {
    id: 'email-reader',
    version: '1',
    accepts: (m) => m === MIME.eml,
    async parse(file: FileBytes) {
      return emailDocument(parseEmail(file.bytes, limits));
    },
  };
}

// ─── PostalMime adapter (the class is passed in) ─────────────

/** The part of PostalMime's API this adapter uses (postal-mime 2.x–4.x). */
export interface PostalMimeLike {
  parse(input: Uint8Array | ArrayBuffer | string): Promise<{
    from?: { address?: string; name?: string };
    to?: Array<{ address?: string; name?: string }>;
    cc?: Array<{ address?: string; name?: string }>;
    subject?: string;
    date?: string;
    messageId?: string;
    text?: string;
    html?: string;
    attachments: Array<{ filename?: string | null; mimeType: string; content: ArrayBuffer | Uint8Array | string }>;
  }>;
}

export function createPostalMimeParser(PostalMime: { new (): PostalMimeLike } | PostalMimeLike): DocumentParser {
  const make = (): PostalMimeLike => (typeof PostalMime === 'function' ? new (PostalMime as new () => PostalMimeLike)() : PostalMime);
  const addr = (a?: { address?: string; name?: string }): string => (a ? (a.name ? `${a.name} <${a.address ?? ''}>` : a.address ?? '') : '');
  return {
    id: 'postal-mime',
    version: '4',
    accepts: (m) => m === MIME.eml,
    async parse(file: FileBytes) {
      const email = await make().parse(file.bytes);
      const html = email.html ? htmlToText(email.html) : undefined;
      const headers: Record<string, string> = {};
      if (email.from) headers['from'] = addr(email.from);
      if (email.to?.length) headers['to'] = email.to.map(addr).join(', ');
      if (email.cc?.length) headers['cc'] = email.cc.map(addr).join(', ');
      if (email.subject) headers['subject'] = email.subject;
      if (email.date) headers['date'] = email.date;
      if (email.messageId) headers['message-id'] = email.messageId;
      return emailDocument({
        headers,
        text: (email.text ?? html?.text ?? '').trim(),
        attachments: email.attachments.map((a) => ({
          ...(a.filename ? { filename: a.filename } : {}),
          mimeType: a.mimeType,
          bytes: typeof a.content === 'string' ? new TextEncoder().encode(a.content) : a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content),
          depth: 1,
        })),
        hidden: html?.hidden ?? [],
      });
    },
  };
}
