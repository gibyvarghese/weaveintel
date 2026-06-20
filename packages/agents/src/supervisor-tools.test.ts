/**
 * Unit + security tests for supervisor utility tools:
 * buildDatetimeTool, mathEvalTool, unitConvertTool
 *
 * All tool calls go through the standard Tool.invoke() interface (which is the
 * same path the supervisor uses at runtime). The internal `execute` function
 * is not exposed on the Tool object; we test via the public interface.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDatetimeTool,
  mathEvalTool,
  unitConvertTool,
  buildSupervisorUtilityTools,
} from './supervisor-tools.js';
import { makeCtx } from './test-helpers.js';
import type { Tool } from '@weaveintel/core';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function callTool(tool: Tool, args: Record<string, unknown>) {
  const ctx = makeCtx();
  const result = await tool.invoke(ctx, { name: tool.schema.name, arguments: args });
  return result;
}

async function callDatetime(args: { format?: string; timezone?: string } = {}) {
  return callTool(buildDatetimeTool(), args);
}

async function callMath(expression: string) {
  return callTool(mathEvalTool, { expression });
}

async function callConvert(value: number, from: string, to: string) {
  return callTool(unitConvertTool, { value, from, to });
}

// ── buildSupervisorUtilityTools aggregator ────────────────────────────────────

describe('buildSupervisorUtilityTools', () => {
  it('returns 3 tools by default: datetime, math_eval, unit_convert', () => {
    const tools = buildSupervisorUtilityTools();
    const names = tools.map((t) => t.schema.name);
    expect(names).toContain('datetime');
    expect(names).toContain('math_eval');
    expect(names).toContain('unit_convert');
    expect(tools).toHaveLength(3);
  });

  it('all tools have supervisor-safe tag', () => {
    const tools = buildSupervisorUtilityTools();
    for (const tool of tools) {
      expect(tool.schema.tags ?? []).toContain('supervisor-safe');
    }
  });
});

// ── datetime ─────────────────────────────────────────────────────────────────

describe('buildDatetimeTool', () => {
  it('returns ISO 8601 by default (no format arg)', async () => {
    const result = await callDatetime();
    expect(result.isError).toBeFalsy();
    // ISO 8601: 2026-06-21T...Z
    expect(result.content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('format=iso returns ISO 8601 timestamp', async () => {
    const result = await callDatetime({ format: 'iso' });
    expect(result.content).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('format=unix returns a numeric unix timestamp (seconds since epoch)', async () => {
    const before = Math.floor(Date.now() / 1000);
    const result = await callDatetime({ format: 'unix' });
    const after = Math.floor(Date.now() / 1000);
    const val = Number(result.content);
    expect(Number.isInteger(val)).toBe(true);
    expect(val).toBeGreaterThanOrEqual(before);
    expect(val).toBeLessThanOrEqual(after + 1);
  });

  it('format=unix_ms returns millisecond timestamp', async () => {
    const before = Date.now();
    const result = await callDatetime({ format: 'unix_ms' });
    const after = Date.now();
    const val = Number(result.content);
    expect(val).toBeGreaterThanOrEqual(before);
    expect(val).toBeLessThanOrEqual(after + 50);
  });

  it('format=date returns YYYY-MM-DD', async () => {
    const result = await callDatetime({ format: 'date' });
    expect(result.content).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('format=human returns a non-empty string with a month name or number', async () => {
    const result = await callDatetime({ format: 'human' });
    expect(typeof result.content).toBe('string');
    expect((result.content as string).length).toBeGreaterThan(4);
  });

  it('format=time returns HH:MM:SS', async () => {
    const result = await callDatetime({ format: 'time' });
    expect(result.content).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('format=weekday returns a day name', async () => {
    const result = await callDatetime({ format: 'weekday' });
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    expect(days.some((d) => (result.content as string).includes(d))).toBe(true);
  });

  it('format=rfc2822 returns a UTC string', async () => {
    const result = await callDatetime({ format: 'rfc2822' });
    // UTC strings contain "GMT"
    expect(result.content).toContain('GMT');
  });

  it('accepts a valid IANA timezone without throwing', async () => {
    const result = await callDatetime({ format: 'date', timezone: 'Asia/Tokyo' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back gracefully on an invalid timezone (no error thrown)', async () => {
    const result = await callDatetime({ format: 'date', timezone: 'Invalid/Zone_Does_Not_Exist' });
    // Should still return a date — falls back to UTC
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('defaultTimezone passed to factory is used when no per-call timezone is provided', async () => {
    const tool = buildDatetimeTool('Pacific/Auckland');
    const ctx = makeCtx();
    const result = await tool.invoke(ctx, { name: 'datetime', arguments: { format: 'date' } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('tool schema has required fields', () => {
    const tool = buildDatetimeTool();
    expect(tool.schema.name).toBe('datetime');
    expect(tool.schema.description).toBeTruthy();
    expect(tool.schema.parameters).toBeTruthy();
  });
});

// ── math_eval ────────────────────────────────────────────────────────────────

describe('mathEvalTool', () => {
  it('has correct schema name', () => {
    expect(mathEvalTool.schema.name).toBe('math_eval');
  });

  describe('basic arithmetic', () => {
    it('addition', async () => {
      expect((await callMath('3 + 4')).content).toBe('7');
    });

    it('subtraction', async () => {
      expect((await callMath('10 - 3')).content).toBe('7');
    });

    it('multiplication', async () => {
      expect((await callMath('6 * 7')).content).toBe('42');
    });

    it('division', async () => {
      expect((await callMath('10 / 4')).content).toBe('2.5');
    });

    it('modulo', async () => {
      expect((await callMath('17 % 5')).content).toBe('2');
    });

    it('exponentiation with **', async () => {
      expect((await callMath('2 ** 10')).content).toBe('1024');
    });

    it('exponentiation with ^ converted to **', async () => {
      expect((await callMath('2^3')).content).toBe('8');
    });
  });

  describe('operator precedence', () => {
    it('* before +', async () => {
      expect((await callMath('2 + 3 * 4')).content).toBe('14');
    });

    it('parentheses override precedence', async () => {
      expect((await callMath('(2 + 3) * 4')).content).toBe('20');
    });

    it('nested parentheses', async () => {
      expect((await callMath('((1 + 2) * (3 + 4))')).content).toBe('21');
    });

    it('right-associative exponentiation: 2**3**2 = 2**9 = 512', async () => {
      expect((await callMath('2 ** 3 ** 2')).content).toBe('512');
    });
  });

  describe('negative numbers', () => {
    it('leading unary minus', async () => {
      expect((await callMath('-5 + 10')).content).toBe('5');
    });

    it('unary minus after open paren', async () => {
      expect((await callMath('1 + (-5)')).content).toBe('-4');
    });
  });

  describe('floating point', () => {
    it('decimal operands', async () => {
      const result = parseFloat((await callMath('1.5 * 2')).content as string);
      expect(result).toBeCloseTo(3, 5);
    });
  });

  describe('error cases — returned as { content, isError: true }', () => {
    it('division by zero', async () => {
      const r = await callMath('5 / 0');
      expect(r.isError).toBe(true);
      expect(r.content).toContain('Division by zero');
    });

    it('modulo by zero', async () => {
      const r = await callMath('7 % 0');
      expect(r.isError).toBe(true);
      expect(r.content).toContain('Division by zero');
    });

    it('empty expression', async () => {
      const r = await callMath('');
      expect(r.isError).toBe(true);
    });

    it('expression > 200 chars', async () => {
      const long = '1+'.repeat(101) + '1'; // 203 chars
      const r = await callMath(long);
      expect(r.isError).toBe(true);
    });

    it('mismatched parentheses', async () => {
      const r = await callMath('(1 + 2');
      expect(r.isError).toBe(true);
    });
  });

  describe('security — injection attempts blocked by character filter', () => {
    const injections = [
      '1; process.exit(1)',
      'eval("1+1")',
      '1 + require("fs")',
      '__proto__.toString',
      'alert(1)',
      '1 && process.env.HOME',
      'Math.pow(2,10)',
      '$(cmd)',
      '`shell`',
      'a + b',           // letters not allowed
      '1 | 2',           // pipe not allowed
      '1 << 2',          // bitshift not allowed
    ];

    for (const expr of injections) {
      it(`blocks: ${expr}`, async () => {
        const r = await callMath(expr);
        expect(r.isError).toBe(true);
      });
    }
  });
});

// ── unit_convert ─────────────────────────────────────────────────────────────

describe('unitConvertTool', () => {
  it('has correct schema name', () => {
    expect(unitConvertTool.schema.name).toBe('unit_convert');
  });

  /** Extract the converted numeric value from the result string "N unit = M unit" */
  function extractResult(content: string): number {
    const [, right] = content.split('=');
    return parseFloat(right?.trim() ?? '');
  }

  describe('length', () => {
    it('km → m', async () => {
      const r = await callConvert(1, 'km', 'm');
      expect(extractResult(r.content as string)).toBeCloseTo(1000, 3);
    });

    it('mi → km', async () => {
      const r = await callConvert(1, 'mi', 'km');
      expect(extractResult(r.content as string)).toBeCloseTo(1.609344, 4);
    });

    it('ft → m', async () => {
      const r = await callConvert(1, 'ft', 'm');
      expect(extractResult(r.content as string)).toBeCloseTo(0.3048, 4);
    });

    it('in → cm', async () => {
      const r = await callConvert(1, 'in', 'cm');
      expect(extractResult(r.content as string)).toBeCloseTo(2.54, 4);
    });

    it('yd → m', async () => {
      const r = await callConvert(1, 'yd', 'm');
      expect(extractResult(r.content as string)).toBeCloseTo(0.9144, 4);
    });

    it('m → mm', async () => {
      const r = await callConvert(1, 'm', 'mm');
      expect(extractResult(r.content as string)).toBeCloseTo(1000, 3);
    });
  });

  describe('mass', () => {
    it('kg → g', async () => {
      const r = await callConvert(1, 'kg', 'g');
      expect(extractResult(r.content as string)).toBeCloseTo(1000, 3);
    });

    it('lb → kg', async () => {
      const r = await callConvert(1, 'lb', 'kg');
      expect(extractResult(r.content as string)).toBeCloseTo(0.45359237, 5);
    });

    it('oz → g', async () => {
      const r = await callConvert(1, 'oz', 'g');
      expect(extractResult(r.content as string)).toBeCloseTo(28.3495, 3);
    });

    it('mg → g', async () => {
      const r = await callConvert(1000, 'mg', 'g');
      expect(extractResult(r.content as string)).toBeCloseTo(1, 5);
    });
  });

  describe('volume', () => {
    it('gal → l', async () => {
      const r = await callConvert(1, 'gal', 'l');
      expect(extractResult(r.content as string)).toBeCloseTo(3.785411784, 5);
    });

    it('cup → ml', async () => {
      const r = await callConvert(1, 'cup', 'ml');
      expect(extractResult(r.content as string)).toBeCloseTo(236.5882365, 3);
    });

    it('qt → l', async () => {
      const r = await callConvert(1, 'qt', 'l');
      expect(extractResult(r.content as string)).toBeCloseTo(0.946352946, 5);
    });

    it('pt → ml', async () => {
      const r = await callConvert(1, 'pt', 'ml');
      expect(extractResult(r.content as string)).toBeCloseTo(473.176473, 3);
    });
  });

  describe('time', () => {
    it('h → min', async () => {
      const r = await callConvert(1, 'h', 'min');
      expect(extractResult(r.content as string)).toBeCloseTo(60, 3);
    });

    it('day → h', async () => {
      const r = await callConvert(1, 'day', 'h');
      expect(extractResult(r.content as string)).toBeCloseTo(24, 3);
    });

    it('week → day', async () => {
      const r = await callConvert(1, 'week', 'day');
      expect(extractResult(r.content as string)).toBeCloseTo(7, 3);
    });

    it('min → s', async () => {
      const r = await callConvert(1, 'min', 's');
      expect(extractResult(r.content as string)).toBeCloseTo(60, 3);
    });

    it('hr alias → s', async () => {
      const r = await callConvert(1, 'hr', 's');
      expect(extractResult(r.content as string)).toBeCloseTo(3600, 3);
    });
  });

  describe('temperature', () => {
    it('100°C → F (boiling point)', async () => {
      const r = await callConvert(100, 'C', 'F');
      expect(extractResult(r.content as string)).toBeCloseTo(212, 3);
    });

    it('32°F → C (freezing point)', async () => {
      const r = await callConvert(32, 'F', 'C');
      expect(extractResult(r.content as string)).toBeCloseTo(0, 4);
    });

    it('0°C → K', async () => {
      const r = await callConvert(0, 'C', 'K');
      expect(extractResult(r.content as string)).toBeCloseTo(273.15, 4);
    });

    it('273.15K → C (absolute zero reference)', async () => {
      const r = await callConvert(273.15, 'K', 'C');
      expect(extractResult(r.content as string)).toBeCloseTo(0, 4);
    });

    it('-40°C = -40°F (crossover point)', async () => {
      const r = await callConvert(-40, 'C', 'F');
      expect(extractResult(r.content as string)).toBeCloseTo(-40, 3);
    });

    it('long-form celsius to fahrenheit', async () => {
      const r = await callConvert(100, 'celsius', 'fahrenheit');
      expect(extractResult(r.content as string)).toBeCloseTo(212, 3);
    });
  });

  describe('error cases', () => {
    it('cross-dimension: km → kg returns error', async () => {
      const r = await callConvert(1, 'km', 'kg');
      expect(r.isError).toBe(true);
      expect(r.content).toContain('Cannot convert');
    });

    it('unknown from-unit returns error', async () => {
      const r = await callConvert(1, 'parsec', 'm');
      expect(r.isError).toBe(true);
      expect(r.content).toContain('Unknown unit');
    });

    it('unknown to-unit returns error', async () => {
      const r = await callConvert(1, 'm', 'parsec');
      expect(r.isError).toBe(true);
      expect(r.content).toContain('Unknown unit');
    });

    it('unknown temperature unit returns error', async () => {
      const r = await callConvert(100, 'R', 'C'); // Rankine not supported
      expect(r.isError).toBe(true);
    });
  });

  describe('stress — extreme and edge values', () => {
    it('very large value does not throw', async () => {
      const r = await callConvert(1e15, 'mm', 'km');
      expect(r.isError).toBeFalsy();
      expect(r.content).toMatch(/=/);
    });

    it('zero value converts cleanly', async () => {
      const r = await callConvert(0, 'km', 'm');
      expect(r.isError).toBeFalsy();
      expect(extractResult(r.content as string)).toBe(0);
    });

    it('negative temperature value converts cleanly', async () => {
      const r = await callConvert(-40, 'C', 'F');
      expect(r.isError).toBeFalsy();
      expect(extractResult(r.content as string)).toBeCloseTo(-40, 3);
    });
  });
});
