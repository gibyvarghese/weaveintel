// Regression tests for the CodeQL js/polynomial-redos and incomplete-sanitisation fixes:
// each pathological input must finish quickly, and normal inputs keep their old result.
import { describe, expect, it } from 'vitest';
import { blocksBetween, trimTrailingChar, trimTrailingSlashes } from '../../strings.js';
import { dropCommentsAndRawText, htmlToText, stripTags } from '../email.js';
import { parsePdfBasic, parseToUnicode, pdfTitle } from '../pdf.js';
import { trimNumberEnds } from '../mapping.js';
import { parseJsonAnswer } from '../engines.js';
import { graphShareId } from '../../sources/graph.js';
import { driveQueryString } from '../../sources/gdrive.js';
import { makePdf, textPage } from './fixtures.js';

const N = 50_000;
/** Runs `fn` and fails if it takes longer than `ms` (the old regexes took seconds on these inputs). */
function fast<T>(fn: () => T, ms = 500): T {
  const t0 = performance.now();
  const out = fn();
  expect(performance.now() - t0).toBeLessThan(ms);
  return out;
}

describe('string helpers', () => {
  it('trims trailing slashes like /\\/+$/ and is linear on slash runs', () => {
    expect(trimTrailingSlashes('https://x/api//')).toBe('https://x/api');
    expect(trimTrailingSlashes('https://x/api')).toBe('https://x/api');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
    const evil = `${'/'.repeat(N)}x`;
    expect(fast(() => trimTrailingSlashes(evil))).toBe(evil);
  });

  it('trims trailing zeros like /0+$/', () => {
    expect(trimTrailingChar('12500', '0')).toBe('125');
    expect(trimTrailingChar('000', '0')).toBe('');
    const evil = `${'0'.repeat(N)}1`;
    expect(fast(() => trimTrailingChar(evil, '0'))).toBe(evil);
  });

  it('finds open/close blocks like a lazy regex, and stops at an unclosed opener', () => {
    expect([...blocksBetween('a[1]b[2]c[3', '[', ']')]).toEqual(['1', '2']);
    expect(fast(() => [...blocksBetween('beginbfchar'.repeat(N), 'beginbfchar', 'endbfchar')])).toEqual([]);
  });
});

describe('HTML to text', () => {
  it('keeps the old result for normal HTML', () => {
    const { text, hidden } = htmlToText('<html><head><title>T</title></head><body><!-- note --><p>Hello <b>world</b></p><script>x()</script><style>p{}</style><p>a &lt; b</p><div style="display:none">secret</div></body></html>');
    expect(text).toBe('Hello world\na < b');
    expect(hidden[0]?.decoded).toBe('secret');
  });

  it('removes markup that only forms once something between its pieces is cut', () => {
    expect(dropCommentsAndRawText('a<scr<!-- -->ipt>alert(1)</script>b')).toBe('ab');
    expect(dropCommentsAndRawText('a<!<!-- x -->-- hidden -->b')).toBe('ab');
    expect(htmlToText('ok<scr<!---->ipt>alert(1)</scr<!---->ipt>').text).toBe('ok');
  });

  it('treats an unclosed comment or script as running to the end, as a browser does', () => {
    expect(dropCommentsAndRawText('a<!-- never closed <p>x</p>')).toBe('a');
    expect(dropCommentsAndRawText('a<script>never closed')).toBe('a');
  });

  it('strips tags like /<[^>]+>/g', () => {
    expect(stripTags('a<b>c</b>d', '')).toBe('acd');
    expect(stripTags('a <> b', '')).toBe('a <> b');
    expect(stripTags('x < y', '')).toBe('x < y');
    expect(stripTags('<a<b>c', ' ')).toBe(' c');
  });

  it('is fast on repeated unclosed comments, scripts and tags', () => {
    fast(() => htmlToText('<!--'.repeat(N)));
    fast(() => htmlToText('<script'.repeat(N)));
    fast(() => htmlToText('<a'.repeat(N)));
    fast(() => htmlToText(`${'<td'.repeat(N)}`));
    fast(() => htmlToText(`<p>x</p>${'<div style="display:none"'.repeat(5000)}`));
    fast(() => htmlToText('<scr<!---->ipt>'.repeat(2000)));
  });
});

describe('PDF basic reader', () => {
  it('still reads objects, text and title', () => {
    const doc = parsePdfBasic(makePdf([textPage('Hello PDF')]));
    expect(doc.pages[0]?.text).toContain('Hello PDF');
  });

  it('reads the title like /\\/Title\\s*\\(([^)]*)\\)/', () => {
    expect(pdfTitle('<< /Title (My Report) /Author (A) >>')).toBe('My Report');
    expect(pdfTitle('<< /Title(Nested (x) y) >>')).toBe('Nested (x');
    expect(pdfTitle('/TitleX /Title (Second)')).toBe('Second');
    expect(pdfTitle('<< /Author (A) >>')).toBeUndefined();
    expect(fast(() => pdfTitle('/Title(('.repeat(N)))).toBeUndefined();
  });

  it('is fast on long digit runs where an object header is expected', () => {
    const evil = new TextEncoder().encode(`%PDF-1.4\n${'0'.repeat(N)}\n%%EOF`);
    fast(() => parsePdfBasic(evil));
  });

  it('parses ToUnicode maps as before and is fast on unclosed blocks and arrays', () => {
    const cmap = 'beginbfchar <01> <0041> endbfchar beginbfrange <02> <03> <0042> <04> <05> [<0058> <0059>] endbfrange';
    const { map } = parseToUnicode(cmap);
    expect([1, 2, 3, 4, 5].map((c) => map.get(c))).toEqual(['A', 'B', 'C', 'X', 'Y']);
    fast(() => parseToUnicode('beginbfchar'.repeat(N)));
    fast(() => parseToUnicode('beginbfrange'.repeat(N)));
    fast(() => parseToUnicode(`beginbfrange ${'<0><0>[\\'.repeat(N)} endbfrange`));
  });
});

describe('number transforms, JSON answers, share ids, Drive queries', () => {
  it('trims around numbers like /^[^\\d+-.]+|[^\\d.]+$/g', () => {
    expect(trimNumberEnds('$1234.50')).toBe('1234.50');
    expect(trimNumberEnds('-12kg')).toBe('-12');
    expect(trimNumberEnds('EUR+3.5')).toBe('+3.5');
    expect(trimNumberEnds('abc')).toBe('');
    expect(fast(() => trimNumberEnds(`1${'-'.repeat(N)}2`))).toBe(`1${'-'.repeat(N)}2`);
  });

  it('parses fenced and bare JSON answers, and is fast on long whitespace', () => {
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer('{"a":2}')).toEqual({ a: 2 });
    expect(parseJsonAnswer('```\n{"a":3}   ```')).toEqual({ a: 3 });
    expect(() => fast(() => parseJsonAnswer(`{"a":${'\t'.repeat(N)}x`))).toThrow(/JSON/);
  });

  it('makes the same unpadded base64url share id', () => {
    const url = 'https://contoso.sharepoint.com/:w:/s/team/EabcDEF?e=1~2';
    const legacy = `u!${Buffer.from(url, 'utf8').toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-')}`;
    expect(graphShareId(url)).toBe(legacy);
    expect(graphShareId('a?>')).toBe(`u!${Buffer.from('a?>').toString('base64url')}`);
  });

  it('escapes backslashes as well as quotes in a Drive query string', () => {
    expect(driveQueryString("it's")).toBe("it\\'s");
    expect(driveQueryString('a\\b')).toBe('a\\\\b');
    // A trailing backslash must not escape the closing quote the caller adds.
    expect(`'${driveQueryString("x\\' or '1'='1")}'`).toBe("'x\\\\\\' or \\'1\\'=\\'1'");
  });
});
