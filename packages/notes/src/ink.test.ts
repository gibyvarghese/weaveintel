// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  strokeToPath, strokesToSvg, strokesBounds, validateStrokes, inkFromPrimitives, recolorStrokes,
  type InkStroke,
} from './ink.js';

describe('ink — strokeToPath', () => {
  it('returns a move + curves for a multi-point stroke', () => {
    const d = strokeToPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }]);
    expect(d.startsWith('M ')).toBe(true);
    expect(d).toContain('Q'); // quadratic smoothing
  });
  it('handles empty + single-point gracefully', () => {
    expect(strokeToPath([])).toBe('');
    expect(strokeToPath([{ x: 5, y: 5 }]).startsWith('M 5 5')).toBe(true);
  });
  it('ignores non-finite points', () => {
    const d = strokeToPath([{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 10, y: 10 }, { x: 20, y: 20 }]);
    expect(d.startsWith('M 0 0')).toBe(true);
  });
});

describe('ink — strokesToSvg', () => {
  const strokes: InkStroke[] = [
    { points: [{ x: 0, y: 20 }, { x: 100, y: 20 }], color: '#3B6FB0', width: 3, tool: 'pen' },
    { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], color: '#FAC775', width: 10, tool: 'highlighter' },
    { points: [{ x: 5, y: 5 }, { x: 6, y: 6 }], color: '#000', width: 20, tool: 'eraser' },
  ];
  it('renders pen + highlighter, skips eraser', () => {
    const svg = strokesToSvg(strokes);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('stroke="#3B6FB0"');
    expect(svg).toContain('opacity="0.4"'); // highlighter is translucent
    expect((svg.match(/<path/g) ?? []).length).toBe(2); // eraser produced no path
  });
  it('computes a bounding box with padding', () => {
    const b = strokesBounds(strokes);
    expect(b.x).toBeLessThan(0); expect(b.w).toBeGreaterThan(100);
  });
});

describe('ink — inkFromPrimitives (the AI draws editable ink)', () => {
  it('makes an underline / line / arrow / box / circle / check', () => {
    const s = inkFromPrimitives([
      { kind: 'underline', x1: 0, x2: 80, y: 20, color: '#3B6FB0' },
      { kind: 'arrow', x1: 0, y1: 0, x2: 50, y2: 50 },
      { kind: 'box', x: 0, y: 0, w: 40, h: 30 },
      { kind: 'circle', cx: 20, cy: 20, r: 15 },
      { kind: 'check', x: 0, y: 0 },
    ]);
    expect(s.length).toBeGreaterThanOrEqual(5); // arrow = 2 strokes
    expect(s[0]!.color).toBe('#3B6FB0');
    expect(s.every((st) => st.author === 'ai')).toBe(true);
    // the box is a closed loop
    const box = s.find((st) => st.points.length === 5);
    expect(box).toBeTruthy();
  });
  it('recolours all non-eraser strokes', () => {
    const s = inkFromPrimitives([{ kind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }]);
    const re = recolorStrokes(s, '#0B6B4F');
    expect(re[0]!.color).toBe('#0B6B4F');
    expect(recolorStrokes(s, 'url(javascript:alert(1))')[0]!.color).toBe(s[0]!.color); // bad colour ignored
  });
});

describe('ink — validateStrokes (security + robustness)', () => {
  it('accepts a clean stroke', () => {
    const v = validateStrokes([{ points: [{ x: 1, y: 2, p: 0.5 }], color: '#14201B', width: 4, tool: 'pen' }]);
    expect(v).toHaveLength(1);
    expect(v[0]!.points[0]).toMatchObject({ x: 1, y: 2, p: 0.5 });
  });
  it('drops a script-laden colour → default ink; clamps width; whitelists tool', () => {
    const v = validateStrokes([{ points: [{ x: 0, y: 0 }], color: 'red;}body{}', width: 9999, tool: 'lightsaber' }]);
    expect(v[0]!.color).toBe('#14201B');
    expect(v[0]!.width).toBe(64);
    expect(v[0]!.tool).toBe('pen');
  });
  it('STRESS: caps strokes (400) + points (4000); drops non-finite coords', () => {
    const huge = Array.from({ length: 1000 }, () => ({ points: Array.from({ length: 9000 }, (_, i) => ({ x: i, y: i })), color: '#000', width: 2, tool: 'pen' }));
    const v = validateStrokes(huge);
    expect(v.length).toBeLessThanOrEqual(400);
    expect(v[0]!.points.length).toBeLessThanOrEqual(4000);
    const bad = validateStrokes([{ points: [{ x: 'DROP', y: 1 }, { x: 1, y: 2 }], color: '#000', width: 2, tool: 'pen' }]);
    expect(bad[0]!.points).toHaveLength(1); // the non-finite point was dropped
  });
  it('SECURITY: rendered SVG of hostile input never contains a brace/script/url', () => {
    const svg = strokesToSvg(validateStrokes([{ points: [{ x: 0, y: 0 }, { x: 5, y: 5 }], color: '</style><script>alert(1)</script>', width: 3, tool: 'pen' }]));
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('url(');
    expect(svg).toContain('stroke="#14201B"');
  });
  it('returns [] for non-array / garbage', () => {
    expect(validateStrokes(null)).toEqual([]);
    expect(validateStrokes('draw')).toEqual([]);
    expect(validateStrokes([{ points: [] }])).toEqual([]); // empty points → dropped
  });
});
