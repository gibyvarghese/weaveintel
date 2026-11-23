/**
 * An OData (v4) source on the generic operation runner (F-L2d, FRAMEWORK 4.2).
 *
 * WHAT THIS IS (plain language)
 * An OData service lists records from an "entity set" (`/People`) and takes its options in the address:
 * `$select` (which fields), `$filter` (which records), `$top` (at most how many). It pages by itself: it sends as many
 * records as the page size the caller asks for (`Prefer: odata.maxpagesize=N`) and an `@odata.nextLink` address for
 * the rest. This adapter turns a short description of such a source into the runner's own operation and mapping rows,
 * so an OData read runs, pages, is capped and is mapped exactly like a REST read; there is no second runner.
 *
 * FILTERS FROM TOOL INPUTS ARE DATA, NEVER QUERY TEXT
 * Each filter names one field, one comparison and the tool input that supplies the value. The value is written as an
 * OData literal of its declared type (a string quoted with its quotes doubled, a number that must be a number, a date
 * that must be a date), so no input can add a clause. Field and entity-set names must be plain OData identifiers.
 *
 * Next links are followed only on the source's own host (the runner's rule for `next_url_in_body`).
 */
import type { DeclaredOutput, OperationSpec, RequestMapping, ResponseMapping } from '../runner/spec.js'

/** The comparisons a filter may use (OData's logical operators). */
export const ODATA_COMPARISONS = ['eq', 'ne', 'gt', 'ge', 'lt', 'le'] as const
/** One comparison. */
export type ODataComparison = (typeof ODATA_COMPARISONS)[number]
/** The literal types a filter value may have. */
export type ODataLiteralType = 'string' | 'number' | 'boolean' | 'date'

/** One field the source reads, and the item field it lands in. */
export interface ODataField { readonly field: string; readonly output: string }
/** One filter: `field op <value of the input>`, left out when the input is not given. */
export interface ODataFilter { readonly field: string; readonly op: ODataComparison; readonly input: string; readonly type: ODataLiteralType }

/** An OData source, as a connector pack would describe it. */
export interface ODataSource {
  readonly key: string
  readonly label: string
  /** The service root, https (for example `https://host/svc`). */
  readonly baseUrl: string
  readonly entitySet: string
  readonly select: readonly ODataField[]
  readonly filters?: readonly ODataFilter[] | undefined
  /** `$top`: at most this many records in all. */
  readonly top?: number | undefined
  /** Records per page, asked for with `Prefer: odata.maxpagesize`. */
  readonly pageSize?: number | undefined
  /** Pages read at most (the runner's cap; default 50). */
  readonly maxPages?: number | undefined
  /** The list output's name (default `items`). */
  readonly output?: string | undefined
}

/** The input name the built filter is passed under. */
export const ODATA_FILTER_INPUT = 'odata_filter'

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}(\/[A-Za-z_][A-Za-z0-9_]{0,127}){0,3}$/
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2}))?$/

/**
 * Write one value as an OData literal of its type.
 * @throws when the value is not of that type.
 */
export function odataLiteral(value: unknown, type: ODataLiteralType): string {
  switch (type) {
    case 'string': return `'${String(value).replace(/'/g, "''")}'`
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : Number.NaN
      if (!Number.isFinite(n)) throw new Error('An OData filter value of type number must be a number.')
      return String(n)
    }
    case 'boolean': {
      if (value === true || value === 'true') return 'true'
      if (value === false || value === 'false') return 'false'
      throw new Error('An OData filter value of type boolean must be true or false.')
    }
    case 'date': {
      const s = String(value).trim()
      if (!DATE.test(s)) throw new Error('An OData filter value of type date must be a date (2026-11-23, or a date and time).')
      return s
    }
  }
}

/**
 * The tool input with the built `$filter` added under {@link ODATA_FILTER_INPUT} (left out when no filter's input is
 * given).
 */
export function odataFilter(source: ODataSource, input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const clauses: string[] = []
  for (const f of source.filters ?? []) {
    const v = input[f.input]
    if (v === undefined || v === null || v === '') continue
    clauses.push(`${f.field} ${f.op} ${odataLiteral(v, f.type)}`)
  }
  const { [ODATA_FILTER_INPUT]: _ignored, ...rest } = input
  return clauses.length === 0 ? rest : { ...rest, [ODATA_FILTER_INPUT]: clauses.join(' and ') }
}

/** What the runner needs for one OData read (everything but the input, settings, credential and door). */
export interface ODataOperation {
  readonly spec: OperationSpec
  readonly request: readonly RequestMapping[]
  readonly response: readonly ResponseMapping[]
  readonly outputs: readonly DeclaredOutput[]
}

/**
 * Build the runner's operation for an OData source.
 * @throws when a name is not a plain OData identifier, a comparison is unknown, or a size is not a positive whole number.
 */
export function odataOperation(source: ODataSource): ODataOperation {
  if (!IDENTIFIER.test(source.entitySet)) throw new Error(`The entity set “${source.entitySet}” is not a plain OData name.`)
  if (source.select.length === 0) throw new Error('An OData source must select at least one field.')
  for (const f of [...source.select.map((s) => s.field), ...(source.filters ?? []).map((x) => x.field)]) if (!IDENTIFIER.test(f)) throw new Error(`The field “${f}” is not a plain OData name.`)
  for (const f of source.filters ?? []) if (!(ODATA_COMPARISONS as readonly string[]).includes(f.op)) throw new Error(`“${f.op}” is not an OData comparison.`)
  for (const [name, n] of [['top', source.top], ['page size', source.pageSize], ['most pages', source.maxPages]] as const) {
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) throw new Error(`The ${name} must be a positive whole number.`)
  }
  const list = source.output ?? 'items'
  const request: RequestMapping[] = [
    { from: 'fixed', source: source.select.map((s) => s.field).join(','), target: 'query:$select' },
    { from: 'input', source: ODATA_FILTER_INPUT, target: 'query:$filter' },
    ...(source.top === undefined ? [] : [{ from: 'fixed' as const, source: String(source.top), target: 'query:$top' }]),
    ...(source.pageSize === undefined ? [] : [{ from: 'fixed' as const, source: `odata.maxpagesize=${String(source.pageSize)}`, target: 'header:Prefer' }]),
  ]
  return {
    spec: {
      key: source.key, method: 'GET', baseUrl: source.baseUrl, pathTemplate: `/${source.entitySet}`, bodyFormat: 'none', idempotency: 'inherently_idempotent',
      itemsPath: 'value',
      paging: { style: 'next_url_in_body', cursorPath: '["@odata.nextLink"]', ...(source.maxPages === undefined ? {} : { maxPages: source.maxPages }) },
    },
    request,
    response: source.select.map((s) => ({ itemOf: list, source: s.field, target: s.output })),
    outputs: [{ name: list }],
  }
}
