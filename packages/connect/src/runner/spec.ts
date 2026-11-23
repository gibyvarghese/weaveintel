/**
 * An operation and its mappings, as rows describe them (FRAMEWORK 5.3, 4.6). The host reads its tables into these
 * shapes; nothing here knows a table name.
 */
import type { Outcome } from '../types.js'
import type { Transform } from './transforms.js'

/** How a list answer continues (FRAMEWORK 5.3, a closed list). */
export const PAGING_STYLES = ['none', 'cursor', 'offset_limit', 'page_number', 'link_header', 'next_url_in_body', 'token_in_body'] as const
/** One paging style. */
export type PagingStyle = (typeof PAGING_STYLES)[number]

/** How a repeat of a write is recognised (FRAMEWORK 5.5). */
export const IDEMPOTENCY_STYLES = ['none', 'vendor_header', 'natural_key', 'client_reference', 'inherently_idempotent'] as const
/** One idempotency style. */
export type IdempotencyStyle = (typeof IDEMPOTENCY_STYLES)[number]

/**
 * How the body is sent (a closed list). `multipart`: `part:` rows become form-data parts (a file part carries a
 * platform file reference the host's door resolves). `binary`: the body is one file (`body:$` = a file reference).
 * `text`: the body is one string (`body:$`), sent as written.
 */
export const BODY_FORMATS = ['json', 'form', 'none', 'multipart', 'binary', 'text'] as const
/** One body format. */
export type BodyFormat = (typeof BODY_FORMATS)[number]

/** How the answer is read (a closed list). `file`: the host's door stores the answer as a platform file and the runner
 *  maps its reference (`$file`) into an output; the bytes never pass through the runner. */
export const RESPONSE_FORMATS = ['json', 'text', 'file'] as const
/** One response format. */
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number]

/**
 * Wire encodings (a closed list, connect only). A transform changes what a value MEANS and is shared with schemaWeave
 * inbound (contract v1); an encoding changes only how a value is WRITTEN on the wire for one service, both ways:
 *  - `adf_document`: plain text ⇄ an Atlassian Document Format document (paragraphs from blank-line-separated text).
 *  - `comma_list`: a list ⇄ `a,b,c`.
 *  - `json_text`: any value ⇄ its JSON text (a service that wants JSON inside a string field).
 */
export const ENCODINGS = ['none', 'adf_document', 'comma_list', 'json_text'] as const
/** One encoding. */
export type Encoding = (typeof ENCODINGS)[number]

/**
 * Query dialects for clause rows (a closed list). Each clause row says field, operator and where the value comes from;
 * the runner writes the clause with the dialect's own escaping, so an input can never change the query's shape.
 */
export const QUERY_DIALECTS = ['servicenow_encoded', 'jql', 'odata_filter'] as const
/** One dialect. */
export type QueryDialect = (typeof QUERY_DIALECTS)[number]
/** The operators each dialect allows (closed). `order_by` and `order_by_desc` take the FIELD from the row and no value. */
export const QUERY_OPERATORS: Readonly<Record<QueryDialect, readonly string[]>> = {
  servicenow_encoded: ['=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN', 'STARTSWITH', 'ENDSWITH', 'LIKE', 'NOT LIKE', 'ISEMPTY', 'ISNOTEMPTY', 'order_by', 'order_by_desc'],
  jql: ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', '~', '!~', 'is empty', 'is not empty', 'order_by', 'order_by_desc'],
  odata_filter: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'startswith', 'contains', 'order_by', 'order_by_desc'],
}

/** One clause row's shape: which dialect, which field (a fixed name, never an input), which operator. */
export interface QueryClause {
  readonly dialect: QueryDialect
  readonly field: string
  readonly operator: string
}

/** The methods an operation may use. */
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
/** One method. */
export type Method = (typeof METHODS)[number]

/** Paging settings. Only the ones its style needs are read. */
export interface PagingSpec {
  readonly style: PagingStyle
  readonly pageSizeParam?: string | undefined
  readonly pageSize?: number | undefined
  /** `cursor`: the query parameter; `token_in_body`: the body field. */
  readonly cursorParam?: string | undefined
  /** Where the next cursor, token or address is in the answer. */
  readonly cursorPath?: string | undefined
  readonly offsetParam?: string | undefined
  readonly totalPath?: string | undefined
  readonly pageParam?: string | undefined
  /** `page_number`: an answer field that is true on the last page. */
  readonly lastPath?: string | undefined
  /** `offset_limit`: the first item's offset. 0 (default) or 1 (SCIM's `startIndex`). */
  readonly offsetBase?: 0 | 1 | undefined
  /** Default 50. */
  readonly maxPages?: number | undefined
}

/** A declared outcome: an answer code (and optionally a vendor code at a path) that means a given outcome. */
export interface OutcomeRule {
  readonly status?: number | undefined
  readonly vendorCodePath?: string | undefined
  readonly vendorCode?: string | undefined
  readonly outcome: Outcome
}

/** One operation. */
export interface OperationSpec {
  readonly key: string
  readonly method: Method
  /** The connection's base address for the operation's endpoint. Must be https. */
  readonly baseUrl: string
  /** Path with `{name}` placeholders filled by `path:` mapping rows. */
  readonly pathTemplate: string
  readonly bodyFormat: BodyFormat
  /** Default `json`. */
  readonly responseFormat?: ResponseFormat | undefined
  /** Refuse before sending a request whose body is longer than this (some services fail larger requests outright). */
  readonly maxRequestBytes?: number | undefined
  /** Default: 200 to 299. */
  readonly successStatuses?: readonly number[] | undefined
  readonly idempotency: IdempotencyStyle
  /** `vendor_header`: the header that carries the key. */
  readonly idempotencyHeader?: string | undefined
  /** `client_reference`: where our key is written, for example `body:external_id`. */
  readonly idempotencyTarget?: string | undefined
  /** Where the list of items is in the answer (for list outputs). */
  readonly itemsPath?: string | undefined
  readonly paging?: PagingSpec | undefined
  readonly outcomes?: readonly OutcomeRule[] | undefined
}

/** Where a request value comes from: a tool input, a connection setting, or a fixed value. */
export type MappingFrom = 'input' | 'setting' | 'fixed'

/**
 * One `out` row: a value into a request part. Targets:
 *  - `path:x`, `query:x`, `header:X-Foo`, `body:a.b` (as before), `part:x` (a multipart part);
 *  - `body:$`: the value IS the body (a bare string, number, list, or for `binary` a file reference);
 *  - `body:*` or `body:a.b.*`: merge the keys of an input object into the body (or into `a.b`), only the keys
 *    `allowKeys` names (`customfield_*` allows a prefix). Nothing else of the object is sent;
 *  - with `clause`: a query clause, joined with the other clause rows of the same target in the clause's dialect.
 */
export interface RequestMapping {
  readonly from: MappingFrom
  /** The input name (or nested input path), the setting key, or the fixed value. */
  readonly source: string
  readonly target: string
  readonly transform?: Transform | undefined
  readonly transformArg?: string | undefined
  readonly encoding?: Encoding | undefined
  readonly defaultValue?: string | undefined
  readonly required?: boolean | undefined
  /** For `body:*` targets: the keys that may be merged (exact, or `prefix*`). Required for those targets. */
  readonly allowKeys?: readonly string[] | undefined
  /** For query-clause rows. */
  readonly clause?: QueryClause | undefined
}

/** One `in` row: a value from the answer into an output (or into a field of each item of a list output). */
export interface ResponseMapping {
  /** Path in the answer, or in each item when `itemOf` is set. */
  readonly source: string
  /** The output (or item field) name. */
  readonly target: string
  /** The list output this row fills a field of. */
  readonly itemOf?: string | undefined
  readonly transform?: Transform | undefined
  readonly transformArg?: string | undefined
  readonly encoding?: Encoding | undefined
  readonly defaultValue?: string | undefined
}

/** An output the tool declares. Anything not declared is dropped. */
export interface DeclaredOutput {
  readonly name: string
}
