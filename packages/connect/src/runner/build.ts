/**
 * Build one request from an operation and its `out` rows. The base address fixes the host: inputs fill path
 * segments (always encoded), query parameters, headers, body fields, multipart parts and query clauses, but can never
 * change where the request goes, and never the shape of a query (clause rows fix field and operator).
 */
import { createHash } from 'node:crypto'
import type { ConnectRefusal, FileRef, WirePart, WireRequest } from '../types.js'
import { refusal } from '../types.js'
import { encodeValue } from './encodings.js'
import { getAt, setAt } from './paths.js'
import { clauseTakesNoValue, joinClauses, writeClause } from './query.js'
import type { OperationSpec, QueryDialect, RequestMapping } from './spec.js'
import { applyTransform, type ChoiceMaps } from './transforms.js'

/** The built request, or why not. */
export type BuildResult = { readonly ok: true; readonly request: WireRequest } | ConnectRefusal

const words = (name: string): string => name.replace(/[_.]/g, ' ').trim()
const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

/** Whether a value is a platform file reference (`{ ref, filename?, contentType? }`). */
export function isFileRef(v: unknown): v is FileRef {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  return typeof r['ref'] === 'string' && r['ref'] !== '' && Object.keys(r).every((k) => k === 'ref' || k === 'filename' || k === 'contentType')
}

/** The derived vendor-side repeat key: stable for one dispatch of one tool, across retries and approval resumes. */
export function deriveIdempotencyKey(dispatchId: string, toolKey: string): string {
  return `geni-${createHash('sha256').update(`${dispatchId}\n${toolKey}`).digest('hex').slice(0, 32)}`
}

/** Whether sending the same operation twice cannot do the thing twice. */
export function safeToRepeat(spec: Pick<OperationSpec, 'method' | 'idempotency'>): boolean {
  return spec.method === 'GET' || spec.idempotency !== 'none'
}

function valueOf(row: RequestMapping, input: Readonly<Record<string, unknown>>, settings: Readonly<Record<string, string>>, maps: ChoiceMaps): unknown {
  const raw = row.from === 'input' ? getAt(input, row.source) : row.from === 'setting' ? settings[row.source] : row.source
  let v = row.transform === undefined || row.transform === 'none' ? raw : applyTransform(row.transform, raw, row.transformArg ?? '', maps)
  if (isEmpty(v) && row.defaultValue !== undefined && row.defaultValue !== '') v = row.defaultValue
  return encodeValue(row.encoding, v)
}

/** Whether a key may be merged: an exact name, or a `prefix*` pattern. */
function allowed(key: string, allow: readonly string[]): boolean {
  return allow.some((a) => (a.endsWith('*') ? key.startsWith(a.slice(0, -1)) && key.length > a.length - 1 : key === a))
}

const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))

/**
 * Build the request (before the credential is applied).
 * @param spec The operation.
 * @param rows Its `out` rows.
 * @param input The tool's checked input.
 * @param settings The connection's non-secret settings.
 * @param options The repeat key, when the operation sends one; choice maps for `choice_map` transforms.
 */
export function buildRequest(spec: OperationSpec, rows: readonly RequestMapping[], input: Readonly<Record<string, unknown>>, settings: Readonly<Record<string, string>>, options: { readonly idempotencyKey?: string | undefined; readonly choiceMaps?: ChoiceMaps | undefined } = {}): BuildResult {
  let base: URL
  try { base = new URL(spec.baseUrl) } catch { return refusal('NOT_AN_ADDRESS', 'The connection’s address is not a web address.') }
  if (base.protocol !== 'https:') return refusal('NOT_HTTPS', 'Only secure (https) addresses can be reached.')
  if (base.username !== '' || base.password !== '') return refusal('HAS_USERINFO', 'Addresses that contain a user name or password can’t be used.')
  const maps = options.choiceMaps ?? {}
  const pathValues = new Map<string, string>()
  const query: [string, string][] = []
  const headers: Record<string, string> = { accept: spec.responseFormat === 'text' || spec.responseFormat === 'file' ? '*/*' : 'application/json' }
  const body: Record<string, unknown> = {}
  const parts: WirePart[] = []
  let whole: { readonly value: unknown } | undefined
  let hasBody = false
  const clauses = new Map<string, { dialect: QueryDialect; clauses: string[]; orders: string[] }>()
  for (const row of rows) {
    const [part, ...rest] = row.target.split(':')
    const where = rest.join(':')
    if (row.clause !== undefined) {
      if (part !== 'query' && part !== 'body') return refusal('BAD_OPERATION', `The operation ${spec.key} has a filter row writing to “${row.target}”; filters go in a query parameter or a body field.`)
      const noValue = clauseTakesNoValue(row.clause.operator)
      const v = noValue ? undefined : valueOf(row, input, settings, maps)
      if (!noValue && isEmpty(v)) {
        if (row.required === true) return refusal('BAD_INPUT', `The ${words(row.source)} is needed.`)
        continue
      }
      const w = writeClause(row.clause, v)
      if (!w.ok) return w
      const into = clauses.get(row.target) ?? { dialect: row.clause.dialect, clauses: [], orders: [] }
      if (into.dialect !== row.clause.dialect) return refusal('BAD_OPERATION', `The operation ${spec.key} mixes two query languages in “${row.target}”.`)
      ;(w.order === true ? into.orders : into.clauses).push(w.text)
      clauses.set(row.target, into)
      continue
    }
    const v = valueOf(row, input, settings, maps)
    if (isEmpty(v)) {
      if (row.required === true || part === 'path') return refusal('BAD_INPUT', `The ${words(row.source)} is needed.`)
      continue
    }
    switch (part) {
      case 'path': pathValues.set(where, asText(v)); break
      case 'query': for (const each of Array.isArray(v) ? v : [v]) query.push([where, asText(each)]); break
      case 'header': headers[where.toLowerCase()] = asText(v); break
      case 'part': {
        if (spec.bodyFormat !== 'multipart') return refusal('BAD_OPERATION', `The operation ${spec.key} writes a part, but its body is not multipart.`)
        for (const each of Array.isArray(v) ? v : [v]) parts.push(isFileRef(each) ? { name: where, file: each } : { name: where, value: asText(each) })
        break
      }
      case 'body': {
        if (where === '$') { whole = { value: v }; break }
        if (where === '*' || where.endsWith('.*')) {
          const allow = row.allowKeys ?? []
          if (allow.length === 0) return refusal('BAD_OPERATION', `The operation ${spec.key} merges an object into the body without saying which keys may be sent.`)
          if (v === null || typeof v !== 'object' || Array.isArray(v)) return refusal('BAD_INPUT', `The ${words(row.source)} must be a set of named values.`)
          const prefix = where === '*' ? '' : `${where.slice(0, -2)}.`
          for (const [k, each] of Object.entries(v as Record<string, unknown>)) {
            if (!/^[A-Za-z0-9_.\-]+$/.test(k) || !allowed(k, allow)) return refusal('BAD_INPUT', `“${k}” can’t be set here.`)
            if (each === undefined) continue
            try { setAt(body, `${prefix}["${k}"]`, each) } catch { return refusal('BAD_INPUT', `“${k}” can’t be set here.`) }
          }
          hasBody = true
          break
        }
        setAt(body, where, v)
        hasBody = true
        break
      }
      default: return refusal('BAD_OPERATION', `The operation ${spec.key} has a mapping to “${row.target}”, which is not a part of a request.`)
    }
  }
  for (const [target, c] of clauses) {
    const text = joinClauses(c.dialect, c.clauses, c.orders)
    if (text === '') continue
    const [part, ...rest] = target.split(':')
    const where = rest.join(':')
    if (part === 'query') query.push([where, text])
    else { setAt(body, where, text); hasBody = true }
  }
  const key = options.idempotencyKey
  if (key !== undefined && key !== '') {
    if (spec.idempotency === 'vendor_header' && spec.idempotencyHeader !== undefined && spec.idempotencyHeader !== '') headers[spec.idempotencyHeader.toLowerCase()] = key
    if (spec.idempotency === 'client_reference' && spec.idempotencyTarget !== undefined && spec.idempotencyTarget.startsWith('body:')) { setAt(body, spec.idempotencyTarget.slice(5), key); hasBody = true }
  }
  let missing = ''
  const path = spec.pathTemplate.replace(/\{([a-z][a-z0-9_]*)\}/gi, (_, name: string) => {
    const v = pathValues.get(name)
    if (v === undefined) { missing ||= name; return '' }
    return encodeURIComponent(v)
  })
  if (missing !== '') return refusal('BAD_INPUT', `The ${words(missing)} is needed.`)
  // No path of its own: the connection's address is the whole address (a webhook destination), so it is kept as given.
  const joined = path === '' ? base.pathname : `${base.pathname.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
  const url = new URL(`${base.origin}${joined}`)
  for (const [k, v] of base.searchParams) url.searchParams.append(k, v)
  for (const [k, v] of query) url.searchParams.append(k, v)
  if (url.host !== base.host) return refusal('OUTSIDE_REACH', 'That request would leave the connection’s address, so it was not built.')
  let text: string | undefined
  let file: FileRef | undefined
  switch (spec.bodyFormat) {
    case 'json':
      if (whole !== undefined) { text = JSON.stringify(whole.value); headers['content-type'] = 'application/json' }
      else if (hasBody || spec.method !== 'GET') { text = JSON.stringify(body); headers['content-type'] = 'application/json' }
      break
    case 'form':
      if (hasBody) {
        text = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, asText(v)])).toString()
        headers['content-type'] = 'application/x-www-form-urlencoded'
      }
      break
    case 'text':
      if (whole === undefined || typeof whole.value !== 'string') return refusal('BAD_INPUT', 'The text to send is needed.')
      text = whole.value
      headers['content-type'] ??= 'text/plain; charset=utf-8'
      break
    case 'binary':
      if (whole === undefined || !isFileRef(whole.value)) return refusal('BAD_INPUT', 'The file to send is needed.')
      file = whole.value
      break
    case 'multipart':
      if (parts.length === 0) return refusal('BAD_INPUT', 'Something to send is needed.')
      break
    case 'none':
      break
  }
  const max = spec.maxRequestBytes
  if (max !== undefined && max > 0 && text !== undefined && Buffer.byteLength(text, 'utf8') > max) {
    return refusal('TOO_LARGE', `This is longer than the application accepts (${String(max)} bytes), so it was not sent.`)
  }
  return { ok: true, request: {
    method: spec.method, url: url.toString(), headers,
    ...(text === undefined ? {} : { body: text }),
    ...(spec.bodyFormat === 'multipart' ? { parts } : {}),
    ...(file === undefined ? {} : { file }),
    ...(spec.responseFormat === 'file' ? { expect: 'file' as const } : {}),
  } }
}
