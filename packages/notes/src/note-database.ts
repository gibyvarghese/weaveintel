// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — typed DATABASE properties, validation + rollups.
 *
 * A "note database" is a Notion-style table: a set of typed PROPERTIES (columns) and
 * ROWS whose values conform to those types. This module is the pure, reusable core of
 * that model — property definitions, value coercion/validation, relation + rollup
 * computation, and the supported view types — with NO I/O, so it is trivially testable
 * and runs anywhere. The host application persists the schema in `note_databases.columns_json`
 * and the values in `note_db_rows.fields_json`.
 *
 * --- For someone new to this ---
 * Think of a spreadsheet where each column has a TYPE (text, number, a date, a
 * dropdown, a checkbox…). A "relation" column links a row to rows in ANOTHER table
 * (like "this Task belongs to that Project"). A "rollup" then summarises across that
 * link ("how many tasks are done?", "total cost"). This file knows the rules: it
 * cleans up a value to match its column's type and computes those summaries.
 */

/** The supported column types (the StarterKit subset Notion-style apps use). */
export type PropertyType =
  | 'text' | 'number' | 'select' | 'multi_select' | 'date' | 'checkbox'
  | 'url' | 'email' | 'relation' | 'rollup';

/** How a rollup aggregates across a relation. */
export type RollupFn =
  | 'count' | 'count_unique' | 'sum' | 'average' | 'min' | 'max'
  | 'percent_checked' | 'show_original';

/** A single column definition. */
export interface PropertyDef {
  /** Stable key used in a row's `fields_json`. */
  key: string;
  /** Display name. */
  name: string;
  type: PropertyType;
  /** Choices for `select` / `multi_select`. */
  options?: string[];
  /** For `relation`: the target database id whose rows this column links to. */
  relationDatabaseId?: string;
  /** For `rollup`: which relation to follow, which target property to read, and how to aggregate. */
  rollup?: { relationKey: string; targetKey: string; fn: RollupFn };
}

/** The supported database VIEWS (how rows are laid out). */
export const VIEW_TYPES = ['table', 'board', 'calendar', 'timeline', 'gallery'] as const;
export type DatabaseViewType = typeof VIEW_TYPES[number];
export function isViewType(v: unknown): v is DatabaseViewType { return typeof v === 'string' && (VIEW_TYPES as readonly string[]).includes(v); }

const PROPERTY_TYPES = new Set<PropertyType>(['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'email', 'relation', 'rollup']);
const ROLLUP_FNS = new Set<RollupFn>(['count', 'count_unique', 'sum', 'average', 'min', 'max', 'percent_checked', 'show_original']);

/** Parse + sanitize a database schema (from `columns_json`). Drops malformed properties. */
export function parseSchema(columnsJson: string | unknown[]): PropertyDef[] {
  let raw: unknown;
  if (typeof columnsJson === 'string') { try { raw = JSON.parse(columnsJson); } catch { return []; } }
  else raw = columnsJson;
  if (!Array.isArray(raw)) return [];
  const out: PropertyDef[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const key = typeof p['key'] === 'string' ? p['key'].trim() : '';
    const type = p['type'] as PropertyType;
    if (!key || seen.has(key) || !PROPERTY_TYPES.has(type)) continue;
    seen.add(key);
    const def: PropertyDef = { key, name: typeof p['name'] === 'string' && p['name'].trim() ? p['name'] : key, type };
    if ((type === 'select' || type === 'multi_select') && Array.isArray(p['options'])) def.options = (p['options'] as unknown[]).filter((o): o is string => typeof o === 'string');
    if (type === 'relation' && typeof p['relationDatabaseId'] === 'string') def.relationDatabaseId = p['relationDatabaseId'];
    if (type === 'rollup' && p['rollup'] && typeof p['rollup'] === 'object') {
      const r = p['rollup'] as Record<string, unknown>;
      if (typeof r['relationKey'] === 'string' && typeof r['targetKey'] === 'string' && ROLLUP_FNS.has(r['fn'] as RollupFn)) {
        def.rollup = { relationKey: r['relationKey'], targetKey: r['targetKey'], fn: r['fn'] as RollupFn };
      }
    }
    out.push(def);
  }
  return out;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,255}$/;

/** Coerce a raw value to its property type. Returns the cleaned value, or null when invalid/empty. */
export function coerceValue(value: unknown, def: Pick<PropertyDef, 'type' | 'options'>): unknown {
  switch (def.type) {
    case 'text': return value == null ? null : String(value);
    case 'number': { const n = typeof value === 'number' ? value : Number(value); return Number.isFinite(n) ? n : null; }
    case 'checkbox': return value === true || value === 'true' || value === 1 || value === '1';
    case 'date': { if (typeof value !== 'string' && !(value instanceof Date)) return null; const d = new Date(value as string); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); }
    case 'url': return typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
    case 'email': return typeof value === 'string' && EMAIL_RE.test(value.trim()) ? value.trim() : null;
    case 'select': { const s = value == null ? '' : String(value); return def.options && !def.options.includes(s) ? null : (s || null); }
    case 'multi_select': {
      const arr = Array.isArray(value) ? value.map(String) : (value == null || value === '' ? [] : String(value).split(',').map((s) => s.trim()));
      return def.options ? arr.filter((s) => def.options!.includes(s)) : arr.filter(Boolean);
    }
    case 'relation': return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : (typeof value === 'string' && value ? [value] : []);
    case 'rollup': return null; // computed, never stored
  }
}

/** Validate + coerce a whole row's fields against a schema. Returns the cleaned values (rollups excluded). */
export function validateRow(fields: Record<string, unknown>, schema: PropertyDef[]): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const def of schema) {
    if (def.type === 'rollup') continue;
    if (!(def.key in fields)) continue;
    const coerced = coerceValue(fields[def.key], def);
    if (fields[def.key] != null && fields[def.key] !== '' && coerced == null && def.type !== 'select' && def.type !== 'multi_select') {
      errors.push(`'${def.name}' expected ${def.type}`);
    }
    values[def.key] = coerced;
  }
  return { values, errors };
}

/**
 * Compute a rollup value: follow `relationKey` to the related rows, read `targetKey`
 * from each, and aggregate with `fn`. `relatedRows` are the rows this row links to.
 */
export function computeRollup(def: NonNullable<PropertyDef['rollup']>, relatedRows: Array<Record<string, unknown>>): unknown {
  const vals = relatedRows.map((r) => r[def.targetKey]);
  const nums = vals.map((v) => (typeof v === 'number' ? v : Number(v))).filter((n) => Number.isFinite(n));
  switch (def.fn) {
    case 'count': return relatedRows.length;
    case 'count_unique': return new Set(vals.map((v) => JSON.stringify(v ?? null))).size;
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'average': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'min': return nums.length ? Math.min(...nums) : null;
    case 'max': return nums.length ? Math.max(...nums) : null;
    case 'percent_checked': { const checked = vals.filter((v) => v === true || v === 'true' || v === 1).length; return relatedRows.length ? Math.round((checked / relatedRows.length) * 100) : 0; }
    case 'show_original': return vals.filter((v) => v != null);
  }
}
