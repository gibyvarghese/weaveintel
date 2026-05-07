/**
 * @weaveintel/workflows — input-validator.ts
 *
 * Phase 5 — Lightweight JSON-Schema-lite validator for
 * `WorkflowDefinition.inputSchema`.
 *
 * Deliberate scope (no `ajv` dependency, no $ref, no oneOf/anyOf):
 *   - `type`: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
 *   - `required`: string[]
 *   - `properties`: Record<string, schema>
 *   - `items`: schema (for arrays — applied to every element)
 *   - `enum`: unknown[]
 *   - `minimum` / `maximum` (numbers)
 *   - `minLength` / `maxLength` (strings)
 *
 * Anything else is ignored. This keeps the engine self-contained while
 * covering the 80% of input-shape governance cases. Apps that need full
 * JSON Schema can wire in their own validator and skip the engine's check
 * by leaving `inputSchema` unset.
 */

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const TYPE_LABELS = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;
type SchemaType = (typeof TYPE_LABELS)[number];

function checkType(value: unknown, type: SchemaType): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && !Number.isNaN(value);
  return typeof value === type;
}

function validateNode(value: unknown, schema: Record<string, unknown>, path: string, errors: ValidationError[]): void {
  // type
  const type = schema['type'];
  if (typeof type === 'string' && (TYPE_LABELS as readonly string[]).includes(type)) {
    if (!checkType(value, type as SchemaType)) {
      errors.push({ path, message: `expected type "${type}"` });
      return; // further checks are pointless if type is wrong
    }
  }

  // enum
  const en = schema['enum'];
  if (Array.isArray(en) && !en.some(v => v === value || JSON.stringify(v) === JSON.stringify(value))) {
    errors.push({ path, message: `value not in enum` });
  }

  // numeric bounds
  if (typeof value === 'number') {
    const min = schema['minimum'];
    const max = schema['maximum'];
    if (typeof min === 'number' && value < min) errors.push({ path, message: `must be >= ${min}` });
    if (typeof max === 'number' && value > max) errors.push({ path, message: `must be <= ${max}` });
  }

  // string bounds
  if (typeof value === 'string') {
    const minL = schema['minLength'];
    const maxL = schema['maxLength'];
    if (typeof minL === 'number' && value.length < minL) errors.push({ path, message: `length must be >= ${minL}` });
    if (typeof maxL === 'number' && value.length > maxL) errors.push({ path, message: `length must be <= ${maxL}` });
  }

  // object: required + properties
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key !== 'string') continue;
        if (!(key in obj)) errors.push({ path: path ? `${path}.${key}` : key, message: 'is required' });
      }
    }
    const properties = schema['properties'];
    if (properties && typeof properties === 'object') {
      for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
        if (sub && typeof sub === 'object' && key in obj) {
          validateNode(obj[key], sub as Record<string, unknown>, path ? `${path}.${key}` : key, errors);
        }
      }
    }
  }

  // array: items
  if (Array.isArray(value)) {
    const items = schema['items'];
    if (items && typeof items === 'object') {
      value.forEach((el, i) => {
        validateNode(el, items as Record<string, unknown>, `${path}[${i}]`, errors);
      });
    }
  }
}

export function validateWorkflowInput(input: unknown, schema: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];
  validateNode(input ?? {}, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

export class WorkflowInputValidationError extends Error {
  readonly workflowId: string;
  readonly errors: ValidationError[];

  constructor(workflowId: string, errors: ValidationError[]) {
    const summary = errors.slice(0, 5).map(e => `${e.path || '<root>'}: ${e.message}`).join('; ');
    super(`Workflow "${workflowId}" input validation failed: ${summary}`);
    this.name = 'WorkflowInputValidationError';
    this.workflowId = workflowId;
    this.errors = errors;
  }
}
