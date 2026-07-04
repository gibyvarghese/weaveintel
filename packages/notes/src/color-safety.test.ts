// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { sanitizeColor } from './color-safety.js';

describe('color-safety — sanitizeColor (security gate)', () => {
  it('accepts plain colours', () => {
    expect(sanitizeColor('#FAC775')).toBe('#FAC775');
    expect(sanitizeColor('#fff')).toBe('#fff');
    expect(sanitizeColor('#11223344')).toBe('#11223344'); // 8-digit hex (with alpha)
    expect(sanitizeColor('rgb(10, 20, 30)')).toBe('rgb(10, 20, 30)');
    expect(sanitizeColor('rgba(10,20,30,0.5)')).toBe('rgba(10,20,30,0.5)');
    expect(sanitizeColor('hsl(200, 50%, 40%)')).toBe('hsl(200, 50%, 40%)');
    expect(sanitizeColor('  coral  ')).toBe('coral'); // trimmed + lowercased
    expect(sanitizeColor('RebeccaPurple')).toBe('rebeccapurple');
  });
  it('rejects anything that could carry CSS/script', () => {
    const hostile = [
      'red;}body{display:none}',
      'url(javascript:alert(1))',
      'expression(alert(1))',
      '#fff;background:url(x)',
      'rgb(0,0,0);}',
      '</style><script>',
      'var(--x)',
      'a'.repeat(64),
      '',
      '   ',
      123,
      null,
      undefined,
      {},
    ];
    for (const h of hostile) expect(sanitizeColor(h as unknown)).toBeNull();
  });
  it('STRESS: a thousand random-ish inputs never returns a string with a brace/semicolon/paren-call', () => {
    for (let i = 0; i < 1000; i++) {
      const candidate = `${i % 2 ? '#' : ''}${(i * 2654435761 >>> 0).toString(16)}${i % 3 ? ';}' : ''}`;
      const out = sanitizeColor(candidate);
      if (out !== null) {
        expect(out).not.toMatch(/[;{}]/);
        expect(out).not.toContain('url(');
      }
    }
  });
});
