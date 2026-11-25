/**
 * Query clauses: a filter built from rows, written in the service's own query language with its own escaping.
 *
 * WHY
 * A free-text query input (`sysparm_query`, `jql`, `$filter`) lets whoever fills the input change the query's shape:
 * `active=true^ORnumber=INC1` widens a "my open incidents" read to anything. A clause row fixes the FIELD and the
 * OPERATOR in the pack; only the VALUE comes from an input, and the runner escapes it for the dialect. Clauses of the
 * same target are joined with AND; ordering rows (`order_by`, `order_by_desc`) take their field from the row.
 *
 * Dialects (closed list, {@link QUERY_DIALECTS}): ServiceNow encoded queries, Jira JQL, OData `$filter`.
 */
import type { ConnectRefusal } from '../types.js'
import { refusal } from '../types.js'
import { QUERY_OPERATORS, type QueryClause, type QueryDialect } from './spec.js'

const FIELD: Readonly<Record<QueryDialect, RegExp>> = {
  // 123TEXTQUERY321 is ServiceNow's documented full-text pseudo-field (`123TEXTQUERY321=words`).
  servicenow_encoded: /^(123TEXTQUERY321|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*)$/,
  jql: /^([A-Za-z_][A-Za-z0-9_]*|cf\[\d+\]|"[^"\\]+")$/,
  odata_filter: /^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/,
}

const NO_VALUE = new Set(['ISEMPTY', 'ISNOTEMPTY', 'is empty', 'is not empty', 'order_by', 'order_by_desc'])
const LIST_OPS = new Set(['IN', 'NOT IN', 'in', 'not in'])

/** Whether a clause row is well formed (checked when a pack is read, and again when a request is built). */
export function checkClause(c: QueryClause): string | undefined {
  const ops = QUERY_OPERATORS[c.dialect]
  if (ops === undefined) return `"${String(c.dialect)}" is not a query dialect.`
  if (!ops.includes(c.operator)) return `"${c.operator}" is not an operator of ${c.dialect} (${ops.join(', ')}).`
  if (!FIELD[c.dialect].test(c.field)) return `"${c.field}" is not a field name ${c.dialect} accepts.`
  return undefined
}

/** Whether the operator takes no value (the row is written whenever it is present). */
export function clauseTakesNoValue(operator: string): boolean {
  return NO_VALUE.has(operator)
}

function scalar(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return String(v)
  return undefined
}

function snValue(v: string): string | ConnectRefusal {
  if (/[\r\n]/.test(v)) return refusal('BAD_INPUT', 'A filter value can’t contain a line break.')
  return v.replace(/\^/g, '^^')
}

function jqlValue(v: unknown): string | undefined {
  const s = scalar(v)
  return s === undefined ? undefined : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function odataValue(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return String(v)
  return typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : undefined
}

/** One clause to its text, or why not. Ordering rows answer `{ order: … }`. */
export function writeClause(c: QueryClause, value: unknown): { readonly ok: true; readonly text: string; readonly order?: boolean } | ConnectRefusal {
  const bad = checkClause(c)
  if (bad !== undefined) return refusal('BAD_OPERATION', bad)
  const isOrder = c.operator === 'order_by' || c.operator === 'order_by_desc'
  const desc = c.operator === 'order_by_desc'
  const list = Array.isArray(value) ? value : [value]
  switch (c.dialect) {
    case 'servicenow_encoded': {
      if (isOrder) return { ok: true, text: `${desc ? 'ORDERBYDESC' : 'ORDERBY'}${c.field}`, order: true }
      if (NO_VALUE.has(c.operator)) return { ok: true, text: `${c.field}${c.operator}` }
      const parts: string[] = []
      for (const each of LIST_OPS.has(c.operator) ? list : [value]) {
        const s = scalar(each)
        if (s === undefined) return refusal('BAD_INPUT', `The ${c.field.replace(/_/g, ' ')} filter needs a plain value.`)
        if (LIST_OPS.has(c.operator) && s.includes(',')) return refusal('BAD_INPUT', 'A value in a list filter can’t contain a comma.')
        const e = snValue(s)
        if (typeof e !== 'string') return e
        parts.push(e)
      }
      return { ok: true, text: `${c.field}${c.operator}${parts.join(',')}` }
    }
    case 'jql': {
      if (isOrder) return { ok: true, text: `${c.field} ${desc ? 'DESC' : 'ASC'}`, order: true }
      if (c.operator === 'is empty' || c.operator === 'is not empty') return { ok: true, text: `${c.field} ${c.operator === 'is empty' ? 'is EMPTY' : 'is not EMPTY'}` }
      if (LIST_OPS.has(c.operator)) {
        const vals = list.map(jqlValue)
        if (vals.some((x) => x === undefined) || vals.length === 0) return refusal('BAD_INPUT', `The ${c.field} filter needs plain values.`)
        return { ok: true, text: `${c.field} ${c.operator} (${vals.join(', ')})` }
      }
      const v = jqlValue(value)
      if (v === undefined) return refusal('BAD_INPUT', `The ${c.field} filter needs a plain value.`)
      return { ok: true, text: `${c.field} ${c.operator} ${v}` }
    }
    case 'odata_filter': {
      if (isOrder) return { ok: true, text: `${c.field} ${desc ? 'desc' : 'asc'}`, order: true }
      const v = odataValue(value)
      if (v === undefined) return refusal('BAD_INPUT', `The ${c.field} filter needs a plain value.`)
      if (c.operator === 'startswith' || c.operator === 'contains') return { ok: true, text: `${c.operator}(${c.field},${v})` }
      return { ok: true, text: `${c.field} ${c.operator} ${v}` }
    }
  }
}

/** Join a target's clauses and orderings into the dialect's query text. */
export function joinClauses(dialect: QueryDialect, clauses: readonly string[], orders: readonly string[]): string {
  switch (dialect) {
    case 'servicenow_encoded': return [...clauses, ...orders].join('^')
    case 'jql': return `${clauses.join(' AND ')}${orders.length > 0 ? `${clauses.length > 0 ? ' ' : ''}ORDER BY ${orders.join(', ')}` : ''}`
    // OData orders go in their own target (`query:$orderby`); a target holding only orderings is written as one.
    case 'odata_filter': return clauses.length > 0 ? clauses.join(' and ') : orders.join(',')
  }
}
