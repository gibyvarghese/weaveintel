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

/** How the body is sent. */
export const BODY_FORMATS = ['json', 'form', 'none'] as const
/** One body format. */
export type BodyFormat = (typeof BODY_FORMATS)[number]

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

/** One `out` row: a value into a request part (`path:x`, `query:x`, `header:X-Foo`, `body:a.b`). */
export interface RequestMapping {
  readonly from: MappingFrom
  /** The input name (or nested input path), the setting key, or the fixed value. */
  readonly source: string
  readonly target: string
  readonly transform?: Transform | undefined
  readonly transformArg?: string | undefined
  readonly defaultValue?: string | undefined
  readonly required?: boolean | undefined
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
  readonly defaultValue?: string | undefined
}

/** An output the tool declares. Anything not declared is dropped. */
export interface DeclaredOutput {
  readonly name: string
}
