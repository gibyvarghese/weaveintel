// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { sanitizeSvg, svgToDataUri, svgToSafeDataUri } from './svg.js';

const OK = '<svg viewBox="0 0 100 100"><path d="M10 10 C 20 0, 40 0, 50 50" fill="#F4C0D1" stroke="#A8281F"/><circle cx="50" cy="50" r="20" fill="red"/><text x="10" y="90">heart</text></svg>';

describe('svg — sanitizeSvg (keeps safe vector art)', () => {
  it('passes a clean illustration + adds the namespace', () => {
    const s = sanitizeSvg(OK)!;
    expect(s).toContain('<path');
    expect(s).toContain('<circle');
    expect(s).toContain('heart');
    expect(s).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
  it('keeps a same-document #fragment href (gradients/defs)', () => {
    const s = sanitizeSvg('<svg><defs><linearGradient id="g"/></defs><rect fill="url(#g)" href="#g"/></svg>')!;
    expect(s).toContain('href="#g"');
  });
});

describe('svg — sanitizeSvg (SECURITY: strips every active vector)', () => {
  it('removes <script>', () => {
    const s = sanitizeSvg('<svg><script>alert(1)</script><rect/></svg>')!;
    expect(s).not.toContain('<script'); expect(s).toContain('<rect');
  });
  it('removes onload / onclick + other event handlers', () => {
    const s = sanitizeSvg('<svg onload="alert(1)"><rect onclick="x()" onmouseover=\'y()\'/></svg>')!;
    expect(s).not.toMatch(/onload|onclick|onmouseover/i);
  });
  it('removes <foreignObject> (HTML/script escape) + media + animation', () => {
    const s = sanitizeSvg('<svg><foreignObject><body><script>1</script></body></foreignObject><animate attributeName="x"/><rect/></svg>')!;
    expect(s.toLowerCase()).not.toContain('foreignobject');
    expect(s.toLowerCase()).not.toContain('<animate');
    expect(s).not.toContain('<script');
  });
  it('strips javascript: + external hrefs (keeps only #fragments)', () => {
    const s = sanitizeSvg('<svg><a href="javascript:alert(1)"><rect/></a><image href="https://evil.com/x.png"/><use xlink:href="https://evil/x"/></svg>')!;
    expect(s).not.toContain('javascript:');
    expect(s).not.toContain('evil.com');
    expect(s).not.toContain('https://evil');
  });
  it('strips DOCTYPE/ENTITY (XXE), comments, CDATA, xml prolog', () => {
    const s = sanitizeSvg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "danger">]><svg><!-- c --><![CDATA[ x ]]><rect/></svg>')!;
    expect(s).not.toMatch(/DOCTYPE|ENTITY|<!--|CDATA/i);
    expect(s).toContain('<rect');
  });
  it('strips style="url(...)" + expression(...)', () => {
    const s = sanitizeSvg('<svg><rect style="fill:red;background:url(http://evil/x)"/><rect style=\'width:expression(alert(1))\'/></svg>')!;
    expect(s).not.toContain('url('); expect(s).not.toContain('expression(');
  });
  it('refuses non-SVG / oversize / junk', () => {
    expect(sanitizeSvg('<div>not svg</div>')).toBeNull();
    expect(sanitizeSvg('')).toBeNull();
    expect(sanitizeSvg(null)).toBeNull();
    expect(sanitizeSvg(42)).toBeNull();
    expect(sanitizeSvg('<svg>' + 'x'.repeat(300_000) + '</svg>')).toBeNull();
  });
  it('STRESS: 200 hostile SVGs never throw + never leak script/js/onload', () => {
    for (let i = 0; i < 200; i++) {
      const hostile = `<svg onload="a${i}()"><script>${i}</script><a href="javascript:${i}"><rect style="x:expression(${i})"/></a></svg>`;
      const out = sanitizeSvg(hostile);
      if (out) { expect(out).not.toContain('<script'); expect(out).not.toMatch(/onload/i); expect(out).not.toContain('javascript:'); expect(out).not.toContain('expression('); }
    }
  });
});

describe('svg — data URIs', () => {
  it('makes an inert data:image/svg+xml URI', () => {
    const uri = svgToDataUri('<svg><rect/></svg>');
    expect(uri.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });
  it('svgToSafeDataUri sanitises then encodes, or null for unsafe', () => {
    expect(svgToSafeDataUri(OK)!.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(svgToSafeDataUri('<div>x</div>')).toBeNull();
    // a script-laden svg is sanitised before encoding (not rejected).
    const safe = svgToSafeDataUri('<svg><script>alert(1)</script><rect/></svg>')!;
    const decoded = Buffer.from(safe.split(',')[1]!, 'base64').toString('utf8');
    expect(decoded).not.toContain('<script');
  });
});
