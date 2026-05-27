/**
 * @weaveintel/workflows — output-schema-validator.ts
 *
 * Phase W3 — Validate a step's output against a JSON-Schema-lite descriptor
 * after the handler completes.  Same narrow subset as the input validator:
 *   type, required, properties, enum, items (arrays), minimum/maximum.
 *
 * Three actions on failure:
 *   warn   — record errors, emit event, continue with original output.
 *   fail   — mark step failed with a structured error message.
 *   coerce — attempt to coerce mismatched primitive fields, then continue.
 */

export interface OutputValidationError {
  path: string;
  message: string;
}

export interface OutputValidationResult {
  valid: boolean;
  errors: OutputValidationError[];
  /** Present only when action='coerce'; contains the coerced output. */
  coercedOutput?: unknown;
}

type JsonSchemaLite = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, JsonSchemaLite>;
  enum?: unknown[];
  items?: JsonSchemaLite;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

/** Validate `value` against `schema`; collect errors keyed by dotted path. */
export function validateStepOutput(
  output: unknown,
  schema: Record<string, unknown>,
  action: 'warn' | 'fail' | 'coerce' = 'warn',
): OutputValidationResult {
  const errors: OutputValidationError[] = [];
  const coerced = action === 'coerce' ? deepClone(output) : undefined;
  validateNode(output, schema as JsonSchemaLite, '', errors, action === 'coerce' ? coerced : undefined);
  return {
    valid: errors.length === 0,
    errors,
    ...(action === 'coerce' ? { coercedOutput: coerced } : {}),
  };
}

function validateNode(
  value: unknown,
  schema: JsonSchemaLite,
  path: string,
  errors: OutputValidationError[],
  coercedParent?: unknown,
): void {
  const label = path || '(root)';

  // type check
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!matchesType(value, types)) {
      if (coercedParent !== undefined && path !== '') {
        const lastDot = path.lastIndexOf('.');
        const key = lastDot >= 0 ? path.slice(lastDot + 1) : path;
        const parent = lastDot >= 0 ? getByPath(coercedParent, path.slice(0, lastDot)) : coercedParent;
        if (parent !== null && typeof parent === 'object' && !Array.isArray(parent)) {
          const coerced = coercePrimitive(value, types[0]!);
          if (coerced !== undefined) {
            (parent as Record<string, unknown>)[key] = coerced;
          } else {
            errors.push({ path: label, message: `Expected ${types.join('|')} but got ${typeOf(value)}` });
          }
        }
      } else {
        errors.push({ path: label, message: `Expected ${types.join('|')} but got ${typeOf(value)}` });
      }
      return;
    }
  }

  // enum check
  if (schema.enum !== undefined) {
    if (!schema.enum.some(e => jsonEqual(e, value))) {
      errors.push({ path: label, message: `Value not in enum: ${JSON.stringify(value)}` });
    }
  }

  // number bounds
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path: label, message: `${value} < minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path: label, message: `${value} > maximum ${schema.maximum}` });
    }
  }

  // string length
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: label, message: `Length ${value.length} < minLength ${schema.minLength}` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path: label, message: `Length ${value.length} > maxLength ${schema.maxLength}` });
    }
  }

  // object properties
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;

    if (schema.required) {
      for (const req of schema.required) {
        if (!(req in obj)) {
          errors.push({ path: `${label}.${req}`, message: `Required field missing` });
        }
      }
    }

    if (schema.properties) {
      for (const [k, propSchema] of Object.entries(schema.properties)) {
        if (k in obj) {
          const childPath = path ? `${path}.${k}` : k;
          validateNode(obj[k], propSchema, childPath, errors, coercedParent);
        }
      }
    }
  }

  // array items
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      validateNode(item, schema.items!, `${label}[${i}]`, errors, coercedParent);
    });
  }
}

function matchesType(value: unknown, types: string[]): boolean {
  return types.some(t => {
    switch (t) {
      case 'null':    return value === null;
      case 'boolean': return typeof value === 'boolean';
      case 'number':  return typeof value === 'number';
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'string':  return typeof value === 'string';
      case 'array':   return Array.isArray(value);
      case 'object':  return typeof value === 'object' && value !== null && !Array.isArray(value);
      default:        return false;
    }
  });
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function coercePrimitive(value: unknown, targetType: string): unknown {
  try {
    switch (targetType) {
      case 'string':  return String(value);
      case 'number':  { const n = Number(value); return isNaN(n) ? undefined : n; }
      case 'integer': { const n = Math.round(Number(value)); return isNaN(n) ? undefined : n; }
      case 'boolean': return Boolean(value);
      default:        return undefined;
    }
  } catch { return undefined; }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deepClone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
