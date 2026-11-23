/**
 * Build one request from an operation and its `out` rows. The base address fixes the host: inputs fill path
 * segments (always encoded), query parameters, headers and body fields, but can never change where the request goes.
 */
import { createHash } from 'node:crypto'
import type { ConnectRefusal, WireRequest } from '../types.js'
import { refusal } from '../types.js'
import { getAt, setAt } from './paths.js'
import type { OperationSpec, RequestMapping } from './spec.js'
import { applyTransform, type ChoiceMaps } from './transforms.js'

/** The built request, or why not. */
export type BuildResult = { readonly ok: true; readonly request: WireRequest } | ConnectRefusal

const words = (name: string): string => name.replace(/[_.]/g, ' ').trim()
const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

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
  return v
}

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
  const headers: Record<string, string> = { accept: 'application/json' }
  const body: Record<string, unknown> = {}
  let hasBody = false
  for (const row of rows) {
    const [part, ...rest] = row.target.split(':')
    const where = rest.join(':')
    const v = valueOf(row, input, settings, maps)
    if (isEmpty(v)) {
      if (row.required === true || part === 'path') return refusal('BAD_INPUT', `The ${words(row.source)} is needed.`)
      continue
    }
    switch (part) {
      case 'path': pathValues.set(where, typeof v === 'string' ? v : JSON.stringify(v)); break
      case 'query': for (const each of Array.isArray(v) ? v : [v]) query.push([where, typeof each === 'string' ? each : JSON.stringify(each)]); break
      case 'header': headers[where.toLowerCase()] = typeof v === 'string' ? v : JSON.stringify(v); break
      case 'body': setAt(body, where, v); hasBody = true; break
      default: return refusal('BAD_OPERATION', `The operation ${spec.key} has a mapping to “${row.target}”, which is not a part of a request.`)
    }
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
  if (spec.bodyFormat === 'json' && (hasBody || spec.method !== 'GET')) {
    text = JSON.stringify(body)
    headers['content-type'] = 'application/json'
  } else if (spec.bodyFormat === 'form' && hasBody) {
    text = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString()
    headers['content-type'] = 'application/x-www-form-urlencoded'
  }
  return { ok: true, request: { method: spec.method, url: url.toString(), headers, ...(text === undefined ? {} : { body: text }) } }
}
