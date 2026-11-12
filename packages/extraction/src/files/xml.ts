// SPDX-License-Identifier: MIT
/**
 * A minimal XML reader for Office files. It builds a small tree of elements
 * and text and decodes the five named entities and numeric references.
 *
 * Safety: a DOCTYPE is refused outright (no entity expansion, so no "billion
 * laughs" and no external entities). Processing instructions and comments are
 * skipped. Nesting depth and node count are capped.
 */

import { FileLimitError } from './errors.js';

export interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: (XmlElement | string)[];
}

const NAMED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ref: string) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return NAMED[ref] ?? m;
  });
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(xml: string, limits?: { maxDepth?: number; maxNodes?: number }): XmlElement {
  const maxDepth = limits?.maxDepth ?? 256;
  const maxNodes = limits?.maxNodes ?? 2_000_000;
  const root: XmlElement = { name: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  let nodes = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      const tail = xml.slice(i);
      if (tail.trim()) stack[stack.length - 1]!.children.push(decodeEntities(tail));
      break;
    }
    if (lt > i) stack[stack.length - 1]!.children.push(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      stack[stack.length - 1]!.children.push(xml.slice(lt + 9, end < 0 ? xml.length : end));
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      throw new FileLimitError('xml_doctype', 'The file contains an XML DOCTYPE, which is not accepted.');
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end < 0 ? xml.length : end + 2;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) break;
    const body = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      // Pop to the matching element (tolerant of small errors).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const sp = inner.search(/\s/);
    const name = sp < 0 ? inner : inner.slice(0, sp);
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      ATTR.lastIndex = 0;
      let m: RegExpExecArray | null;
      const rest = inner.slice(sp);
      while ((m = ATTR.exec(rest)) !== null) attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
    }
    const el: XmlElement = { name, attrs, children: [] };
    if (++nodes > maxNodes) throw new FileLimitError('xml_too_large', 'The XML has too many elements.');
    stack[stack.length - 1]!.children.push(el);
    if (!selfClosing) {
      stack.push(el);
      if (stack.length > maxDepth) throw new FileLimitError('xml_too_deep', 'The XML is nested too deeply.');
    }
  }
  return root;
}

/** Local name without the namespace prefix: `w:t` → `t`. */
export const local = (name: string): string => {
  const c = name.indexOf(':');
  return c < 0 ? name : name.slice(c + 1);
};

export function* walk(el: XmlElement): Generator<XmlElement> {
  for (const c of el.children) {
    if (typeof c !== 'string') {
      yield c;
      yield* walk(c);
    }
  }
}

export function childrenNamed(el: XmlElement, localName: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== 'string' && local(c.name) === localName);
}

export function firstChild(el: XmlElement, localName: string): XmlElement | undefined {
  return childrenNamed(el, localName)[0];
}

export function findAll(el: XmlElement, localName: string): XmlElement[] {
  return [...walk(el)].filter((e) => local(e.name) === localName);
}

/** All text below an element. */
export function textOf(el: XmlElement): string {
  let out = '';
  for (const c of el.children) out += typeof c === 'string' ? c : textOf(c);
  return out;
}

/** An attribute by local name (`w:val` and `val` both match `val`). */
export function attr(el: XmlElement, localName: string): string | undefined {
  for (const [k, v] of Object.entries(el.attrs)) if (local(k) === localName) return v;
  return undefined;
}
