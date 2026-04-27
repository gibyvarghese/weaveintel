/**
 * @weaveintel/agents — Supervisor utility tools
 *
 * These are pure, deterministic, side-effect-free tools the supervisor
 * may call directly without delegating. They are registered automatically
 * by `buildSupervisorRuntime` unless `includeUtilityTools` is set to false.
 *
 * Design contract:
 *   - No network I/O
 *   - No filesystem access
 *   - No subprocess spawn
 *   - No mutable state across calls
 *   - Bounded cost (microseconds, not seconds)
 *
 * Anything that needs I/O or compute must live on a worker (e.g. cse_run_code
 * on a `code_executor` worker, web_search on a `researcher` worker).
 */

import type { Tool } from '@weaveintel/core';
import { weaveTool } from '@weaveintel/core';

// ── datetime ────────────────────────────────────────────────

const DATETIME_FORMATS = ['iso', 'unix', 'unix_ms', 'date', 'time', 'weekday', 'rfc2822'] as const;
type DatetimeFormat = (typeof DATETIME_FORMATS)[number];

function formatDate(now: Date, format: DatetimeFormat, timezone?: string): string {
  // Timezone is honored via Intl when supported; otherwise ignored.
  const useIntl = (opts: Intl.DateTimeFormatOptions): string => {
    try {
      return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timezone }).format(now);
    } catch {
      return new Intl.DateTimeFormat('en-US', opts).format(now);
    }
  };
  switch (format) {
    case 'iso':
      return now.toISOString();
    case 'unix':
      return String(Math.floor(now.getTime() / 1000));
    case 'unix_ms':
      return String(now.getTime());
    case 'date':
      return useIntl({ year: 'numeric', month: '2-digit', day: '2-digit' });
    case 'time':
      return useIntl({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    case 'weekday':
      return useIntl({ weekday: 'long' });
    case 'rfc2822':
      return now.toUTCString();
  }
}

export function buildDatetimeTool(defaultTimezone?: string): Tool {
  return weaveTool<{ format?: DatetimeFormat; timezone?: string }>({
    name: 'datetime',
    description:
      'Return the current date/time in a chosen format. Pure, side-effect-free utility for the supervisor. Formats: iso, unix, unix_ms, date, time, weekday, rfc2822. Optional timezone (IANA, e.g. "Pacific/Auckland").',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: [...DATETIME_FORMATS],
          description: 'Output format. Defaults to iso.',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone identifier. Defaults to the agent runtime default.',
        },
      },
    },
    async execute(args) {
      const format = args.format ?? 'iso';
      const tz = args.timezone ?? defaultTimezone;
      return formatDate(new Date(), format, tz);
    },
    tags: ['utility', 'time', 'supervisor-safe'],
  });
}

// ── math_eval ───────────────────────────────────────────────

function tokenize(expression: string): string[] {
  const sanitized = expression.replace(/\^/g, '**').replace(/\s+/g, '');
  if (!sanitized || sanitized.length > 200) throw new Error('Invalid expression');
  if (/[^0-9+\-*/.%()]/.test(sanitized)) throw new Error('Expression contains unsupported characters');
  const tokens = sanitized.match(/\*\*|\d+(?:\.\d+)?|[()+\-*/%]/g);
  if (!tokens || tokens.join('') !== sanitized) throw new Error('Expression could not be parsed');
  return tokens;
}

function evaluateExpression(expression: string): number {
  const tokens = tokenize(expression);
  const values: number[] = [];
  const operators: string[] = [];
  const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '**': 3 } as const;
  const rightAssociative = new Set(['**']);
  const isOperator = (v: string): v is keyof typeof precedence =>
    Object.prototype.hasOwnProperty.call(precedence, v);

  const apply = () => {
    const op = operators.pop();
    if (!op) throw new Error('Malformed expression');
    if (op === '(') throw new Error('Mismatched parentheses');
    const right = values.pop();
    const left = values.pop();
    if (right == null || left == null) throw new Error('Malformed expression');
    switch (op) {
      case '+': values.push(left + right); break;
      case '-': values.push(left - right); break;
      case '*': values.push(left * right); break;
      case '/':
        if (right === 0) throw new Error('Division by zero');
        values.push(left / right); break;
      case '%':
        if (right === 0) throw new Error('Division by zero');
        values.push(left % right); break;
      case '**': values.push(left ** right); break;
      default: throw new Error('Unsupported operator');
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const previous = i > 0 ? tokens[i - 1] : undefined;
    const previousIsOperator = previous != null && isOperator(previous);
    const unary = token === '-' && (i === 0 || previous === '(' || previousIsOperator);

    if (unary) {
      const next = tokens[i + 1];
      if (next == null || !/^\d/.test(next)) throw new Error('Unary minus must precede a number');
      values.push(-Number(next));
      i += 1;
      continue;
    }
    if (/^\d/.test(token)) { values.push(Number(token)); continue; }
    if (token === '(') { operators.push(token); continue; }
    if (token === ')') {
      while (operators.length > 0 && operators[operators.length - 1] !== '(') apply();
      if (operators.pop() !== '(') throw new Error('Mismatched parentheses');
      continue;
    }
    if (!isOperator(token)) throw new Error('Unsupported operator');
    while (operators.length > 0) {
      const top = operators[operators.length - 1]!;
      if (top === '(') break;
      if (!isOperator(top)) throw new Error('Unsupported operator');
      const shouldApply = rightAssociative.has(token)
        ? precedence[top] > precedence[token]
        : precedence[top] >= precedence[token];
      if (!shouldApply) break;
      apply();
    }
    operators.push(token);
  }
  while (operators.length > 0) apply();
  if (values.length !== 1 || !Number.isFinite(values[0]!)) throw new Error('Malformed expression');
  return values[0]!;
}

export const mathEvalTool: Tool = weaveTool<{ expression: string }>({
  name: 'math_eval',
  description:
    'Evaluate a mathematical expression. Supports +, -, *, /, **, %, parentheses. Pure, side-effect-free. Use this for arithmetic the supervisor needs to verify or compute without delegating.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Math expression to evaluate, e.g. "(3 + 4) * 2"' },
    },
    required: ['expression'],
  },
  async execute(args) {
    try {
      return String(evaluateExpression(args.expression));
    } catch (e) {
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  },
  tags: ['math', 'utility', 'supervisor-safe'],
});

// ── unit_convert ────────────────────────────────────────────

// Conversion factors expressed as the multiplier needed to convert FROM the
// unit TO the canonical base unit for that dimension.
const UNIT_FACTORS: Record<string, { dimension: string; toBase: number }> = {
  // length (base: meter)
  m: { dimension: 'length', toBase: 1 },
  km: { dimension: 'length', toBase: 1000 },
  cm: { dimension: 'length', toBase: 0.01 },
  mm: { dimension: 'length', toBase: 0.001 },
  mi: { dimension: 'length', toBase: 1609.344 },
  yd: { dimension: 'length', toBase: 0.9144 },
  ft: { dimension: 'length', toBase: 0.3048 },
  in: { dimension: 'length', toBase: 0.0254 },
  // mass (base: kilogram)
  kg: { dimension: 'mass', toBase: 1 },
  g: { dimension: 'mass', toBase: 0.001 },
  mg: { dimension: 'mass', toBase: 0.000001 },
  lb: { dimension: 'mass', toBase: 0.45359237 },
  oz: { dimension: 'mass', toBase: 0.0283495231 },
  // volume (base: liter)
  l: { dimension: 'volume', toBase: 1 },
  ml: { dimension: 'volume', toBase: 0.001 },
  gal: { dimension: 'volume', toBase: 3.785411784 },
  qt: { dimension: 'volume', toBase: 0.946352946 },
  pt: { dimension: 'volume', toBase: 0.473176473 },
  cup: { dimension: 'volume', toBase: 0.2365882365 },
  // time (base: second)
  s: { dimension: 'time', toBase: 1 },
  ms: { dimension: 'time', toBase: 0.001 },
  min: { dimension: 'time', toBase: 60 },
  h: { dimension: 'time', toBase: 3600 },
  hr: { dimension: 'time', toBase: 3600 },
  day: { dimension: 'time', toBase: 86400 },
  week: { dimension: 'time', toBase: 604800 },
};

function convertTemperature(value: number, from: string, to: string): number {
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  // First convert to Celsius
  let c: number;
  if (f === 'c' || f === 'celsius') c = value;
  else if (f === 'f' || f === 'fahrenheit') c = (value - 32) * (5 / 9);
  else if (f === 'k' || f === 'kelvin') c = value - 273.15;
  else throw new Error(`Unknown temperature unit: ${from}`);

  if (t === 'c' || t === 'celsius') return c;
  if (t === 'f' || t === 'fahrenheit') return c * (9 / 5) + 32;
  if (t === 'k' || t === 'kelvin') return c + 273.15;
  throw new Error(`Unknown temperature unit: ${to}`);
}

export const unitConvertTool: Tool = weaveTool<{ value: number; from: string; to: string }>({
  name: 'unit_convert',
  description:
    'Convert between common units of length (m, km, cm, mm, mi, yd, ft, in), mass (kg, g, mg, lb, oz), volume (l, ml, gal, qt, pt, cup), time (s, ms, min, h, day, week), and temperature (C/F/K). Pure, side-effect-free.',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'number', description: 'The numeric value to convert.' },
      from: { type: 'string', description: 'The source unit (e.g. "km", "lb", "F").' },
      to: { type: 'string', description: 'The target unit (e.g. "mi", "kg", "C").' },
    },
    required: ['value', 'from', 'to'],
  },
  async execute(args) {
    try {
      const fromKey = args.from.trim();
      const toKey = args.to.trim();
      const tempUnits = new Set(['c', 'f', 'k', 'celsius', 'fahrenheit', 'kelvin']);
      if (tempUnits.has(fromKey.toLowerCase()) || tempUnits.has(toKey.toLowerCase())) {
        const out = convertTemperature(args.value, fromKey, toKey);
        return `${args.value} ${fromKey} = ${Number(out.toPrecision(10))} ${toKey}`;
      }
      const fromDef = UNIT_FACTORS[fromKey];
      const toDef = UNIT_FACTORS[toKey];
      if (!fromDef) throw new Error(`Unknown unit: ${fromKey}`);
      if (!toDef) throw new Error(`Unknown unit: ${toKey}`);
      if (fromDef.dimension !== toDef.dimension) {
        throw new Error(`Cannot convert ${fromDef.dimension} (${fromKey}) to ${toDef.dimension} (${toKey})`);
      }
      const out = (args.value * fromDef.toBase) / toDef.toBase;
      return `${args.value} ${fromKey} = ${Number(out.toPrecision(10))} ${toKey}`;
    } catch (e) {
      return { content: `Error: ${(e as Error).message}`, isError: true };
    }
  },
  tags: ['utility', 'units', 'supervisor-safe'],
});

// ── Aggregator ──────────────────────────────────────────────

export interface SupervisorUtilityToolsOptions {
  /** Default timezone for the `datetime` tool. */
  defaultTimezone?: string;
}

/**
 * Returns the canonical set of supervisor-safe utility tools registered by
 * `buildSupervisorRuntime` when `includeUtilityTools !== false`.
 */
export function buildSupervisorUtilityTools(opts: SupervisorUtilityToolsOptions = {}): Tool[] {
  return [buildDatetimeTool(opts.defaultTimezone), mathEvalTool, unitConvertTool];
}
