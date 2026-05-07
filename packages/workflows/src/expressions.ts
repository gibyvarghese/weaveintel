/**
 * @weaveintel/workflows — expressions.ts
 *
 * A tiny JSONLogic-ish expression evaluator used by `condition` and `branch`
 * steps when their `config.expression` is set. Keeps Phase 1 dependency-free.
 *
 * Supported operators:
 *   { "var": "path.into.variables" }              → readPath(variables, path)
 *   { "var": ["path", default] }                  → readPath ?? default
 *   { "==":  [a, b] }     { "===": [a, b] }
 *   { "!=":  [a, b] }     { "!==": [a, b] }
 *   { "<":   [a, b] }     { "<=":  [a, b] }
 *   { ">":   [a, b] }     { ">=":  [a, b] }
 *   { "and": [a, b, ...] }    { "or": [a, b, ...] }    { "!": a }
 *   { "+":   [...] }   { "-": [...] }   { "*": [...] }   { "/": [...] }
 *   { "in":  [needle, haystackArrayOrString] }
 *   { "not_in": [needle, haystack] }
 *   { "if":  [cond, then, else] }
 *
 * Anything else returns `undefined`. Literal primitives (string/number/
 * boolean/null) and arrays of primitives pass through untouched.
 */
import { readPath } from './path.js';

export type Expression = unknown;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return Number.NaN;
}

export function evaluateExpression(
  expr: Expression,
  variables: Record<string, unknown>,
): unknown {
  if (expr === null || expr === undefined) return expr;
  if (typeof expr !== 'object') return expr;
  if (Array.isArray(expr)) return expr.map(e => evaluateExpression(e, variables));
  const obj = expr as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return expr; // not an operator object
  const op = keys[0]!;
  const raw = obj[op];

  // `var` is special — accepts a path string OR [path, default]
  if (op === 'var') {
    if (typeof raw === 'string') return readPath(variables, raw);
    if (Array.isArray(raw)) {
      const path = raw[0];
      if (typeof path !== 'string') return undefined;
      const fallback = raw.length > 1 ? evaluateExpression(raw[1], variables) : undefined;
      const v = readPath(variables, path);
      return v === undefined ? fallback : v;
    }
    return undefined;
  }

  const args = Array.isArray(raw) ? raw.map(a => evaluateExpression(a, variables)) : [evaluateExpression(raw, variables)];

  switch (op) {
    case '==':  return args[0] == args[1];
    case '===': return args[0] === args[1];
    case '!=':  return args[0] != args[1];
    case '!==': return args[0] !== args[1];
    case '<':   return (args[0] as number) <  (args[1] as number);
    case '<=':  return (args[0] as number) <= (args[1] as number);
    case '>':   return (args[0] as number) >  (args[1] as number);
    case '>=':  return (args[0] as number) >= (args[1] as number);
    case 'and': return args.every(Boolean);
    case 'or':  return args.some(Boolean);
    case '!':   return !args[0];
    case '+':   return args.reduce<number>((a, b) => a + asNumber(b), 0);
    case '-':   return args.length === 1 ? -asNumber(args[0]) : args.slice(1).reduce<number>((a, b) => a - asNumber(b), asNumber(args[0]));
    case '*':   return args.reduce<number>((a, b) => a * asNumber(b), 1);
    case '/':   return args.slice(1).reduce<number>((a, b) => a / asNumber(b), asNumber(args[0]));
    case 'in': {
      const [needle, haystack] = args;
      if (Array.isArray(haystack)) return haystack.includes(needle);
      if (typeof haystack === 'string' && typeof needle === 'string') return haystack.includes(needle);
      return false;
    }
    case 'not_in': {
      const [needle, haystack] = args;
      if (Array.isArray(haystack)) return !haystack.includes(needle);
      if (typeof haystack === 'string' && typeof needle === 'string') return !haystack.includes(needle);
      return true;
    }
    case 'if': {
      const [cond, then, otherwise] = args;
      return cond ? then : otherwise;
    }
    default:
      return undefined;
  }
}

/**
 * Truthy-cast helper for condition/branch decisions.
 * Returns `true` only when expression evaluates to a JS-truthy value.
 */
export function evaluateBoolean(
  expr: Expression,
  variables: Record<string, unknown>,
): boolean {
  return Boolean(evaluateExpression(expr, variables));
}

/** Type guard for "config has an expression worth evaluating". */
export function hasExpression(config: Record<string, unknown> | undefined): boolean {
  if (!config) return false;
  return isPlainObject(config['expression']) || Array.isArray(config['expression']);
}
