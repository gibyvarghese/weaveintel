/**
 * Run one operation: build, apply the credential, send through the caller's door, follow paging, map the answer
 * through declared outputs, and normalise the result to an outcome with a platform sentence. Holds no state.
 */
import type { ApplyResult } from '../credentials/apply.js'
import type { Json, Outcome, Send, SendResult, WireRequest } from '../types.js'
import { outcomeForStatus } from '../types.js'
import { buildRequest, safeToRepeat } from './build.js'
import { decodeValue } from './encodings.js'
import { getAt, setAt } from './paths.js'
import type { DeclaredOutput, OperationSpec, RequestMapping, ResponseMapping } from './spec.js'
import { applyTransform, type ChoiceMaps } from './transforms.js'

/** Everything one run needs. */
export interface RunInput {
  readonly spec: OperationSpec
  readonly request: readonly RequestMapping[]
  readonly response: readonly ResponseMapping[]
  readonly outputs: readonly DeclaredOutput[]
  readonly input: Readonly<Record<string, unknown>>
  readonly settings: Readonly<Record<string, string>>
  readonly choiceMaps?: ChoiceMaps | undefined
  /** Put the credential on a request (each page is signed afresh). */
  readonly credential: (request: WireRequest) => Promise<ApplyResult>
  /** The one way out. */
  readonly send: Send
  /** The tool's name, for sentences. */
  readonly label: string
  readonly idempotencyKey?: string | undefined
}

/** How a run ended. */
export interface RunResult {
  readonly outcome: Outcome
  /** A refusal code, or `HTTP_<status>`, or `OK`. */
  readonly code: string
  readonly status: number
  /** Declared outputs only. */
  readonly output: Readonly<Record<string, Json>>
  /** Safe to show a person or a model. Never the vendor's text. */
  readonly sentence: string
  /** For the log only: what the vendor said (truncated). Never shown to a model. */
  readonly detail: string
  readonly pages: number
  /** More pages remained, or a next link pointed somewhere else. */
  readonly truncated: boolean
  /** Whether anything may have reached the other side. */
  readonly sent: boolean
  /** Whether running it again cannot do the thing twice. */
  readonly safeToRepeat: boolean
  readonly callRefs: readonly string[]
  /** When the application asked us to wait (`Retry-After`, in seconds), for the host's call rules. */
  readonly retryAfterSeconds?: number | undefined
  /** The application's own rate-limit headers (`x-ratelimit-*`, `ratelimit-*`), for the host's call rules and log. */
  readonly rateLimit?: Readonly<Record<string, string>> | undefined
}

const SENTENCES: Readonly<Record<Exclude<Outcome, 'refused'>, (label: string) => string>> = {
  ok: (l) => `${l} worked.`,
  not_found: (l) => `${l}: what was asked for could not be found.`,
  conflict: (l) => `${l} clashed with something already there, so nothing changed.`,
  invalid: (l) => `${l} was not accepted: the application said the request was not valid.`,
  forbidden: (l) => `${l} was not allowed by the application. The connection may not have the access it needs.`,
  throttled: (l) => `${l} was turned away because the application is busy. Try again later.`,
  unavailable: (l) => `${l} could not be completed because the application is not answering properly. Try again later.`,
  unknown: (l) => `We don’t know whether ${l} went through. Check before trying again.`,
}

/** The platform sentence for an outcome. */
export function sentenceFor(outcome: Exclude<Outcome, 'refused'>, label: string): string {
  return SENTENCES[outcome](label)
}

function parse(r: Extract<SendResult, { ok: true }>, format: OperationSpec['responseFormat']): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (format === 'file') return { ok: true, value: r.file === undefined ? {} : { $file: r.file } }
  if (format === 'text') return { ok: true, value: r.body }
  const type = (r.headers['content-type'] ?? '').toLowerCase()
  const looksJson = type.includes('json') || /^\s*[[{]/.test(r.body)
  if (r.body.trim() === '') return { ok: true, value: {} }
  if (!looksJson) return { ok: true, value: r.body }
  try { return { ok: true, value: JSON.parse(r.body) as unknown } } catch { return { ok: false } }
}

function outcomeOf(spec: OperationSpec, status: number, body: unknown): Exclude<Outcome, 'refused'> {
  // `refused` means nothing left; an answer that came back is never that.
  const answered = (o: Outcome): Exclude<Outcome, 'refused'> => (o === 'refused' ? 'invalid' : o)
  const success = spec.successStatuses
  if (success !== undefined && success.length > 0 ? success.includes(status) : status >= 200 && status < 300) return 'ok'
  const rules = spec.outcomes ?? []
  const byCode = rules.find((r) => (r.status === undefined || r.status === status) && r.vendorCodePath !== undefined && r.vendorCode !== undefined && String(getAt(body, r.vendorCodePath) ?? '') === r.vendorCode)
  if (byCode !== undefined) return answered(byCode.outcome)
  const byStatus = rules.find((r) => r.status === status && r.vendorCodePath === undefined)
  if (byStatus !== undefined) return answered(byStatus.outcome)
  const fallback = outcomeForStatus(status)
  return fallback === 'ok' ? 'invalid' : answered(fallback)
}

function mapRow(row: ResponseMapping, from: unknown, maps: ChoiceMaps): unknown {
  const raw = getAt(from, row.source)
  const decoded = decodeValue(row.encoding, raw)
  let v = row.transform === undefined || row.transform === 'none' ? decoded : applyTransform(row.transform, decoded, row.transformArg ?? '', maps)
  if ((v === undefined || v === null || v === '') && row.defaultValue !== undefined && row.defaultValue !== '') v = row.defaultValue
  return v
}

const asJson = (v: unknown): Json | undefined => (v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as Json))

function parseLinkNext(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*(.*)/.exec(part.trim())
    if (m !== null && /rel="?next"?/i.test(m[2] ?? '')) return m[1]
  }
  return undefined
}

/** The wait and rate-limit headers an answer carried, for the host's call rules (never shown to a model). */
export function rateHeaders(headers: Readonly<Record<string, string>>): { readonly retryAfterSeconds?: number; readonly rateLimit?: Readonly<Record<string, string>> } {
  const out: { retryAfterSeconds?: number; rateLimit?: Record<string, string> } = {}
  const ra = headers['retry-after']
  if (ra !== undefined && ra.trim() !== '') {
    const secs = /^\d+$/.test(ra.trim()) ? Number(ra.trim()) : Math.ceil((Date.parse(ra) - Date.now()) / 1000)
    if (Number.isFinite(secs) && secs >= 0) out.retryAfterSeconds = Math.min(secs, 86_400)
  }
  const limits = Object.entries(headers).filter(([k]) => k.startsWith('x-ratelimit-') || k.startsWith('ratelimit') || k === 'x-rate-limit-remaining')
  if (limits.length > 0) out.rateLimit = Object.fromEntries(limits)
  return out
}

/** Run one operation. Never throws for anything the outside did. */
export async function runOperation(run: RunInput): Promise<RunResult> {
  const { spec, label } = run
  const maps = run.choiceMaps ?? {}
  const repeatable = safeToRepeat(spec)
  const declared = new Set(run.outputs.map((o) => o.name))
  const callRefs: string[] = []
  let sent = false
  const end = (outcome: Outcome, code: string, status: number, sentence: string, detail = '', extra: Partial<RunResult> = {}): RunResult =>
    ({ outcome, code, status, output: {}, sentence, detail, pages: 0, truncated: false, sent, safeToRepeat: repeatable, callRefs, ...extra })

  const built = buildRequest(spec, run.request, run.input, run.settings, { idempotencyKey: run.idempotencyKey, choiceMaps: maps })
  if (!built.ok) return end('refused', built.code, 0, built.sentence)
  const origin = new URL(built.request.url).origin
  const paging = spec.paging ?? { style: 'none' as const }
  const maxPages = Math.max(1, Math.min(paging.maxPages ?? 50, 1000))
  const items = new Map<string, Json[]>()
  const top: Record<string, Json> = {}
  let pageRequest: WireRequest = built.request
  if (paging.pageSizeParam !== undefined && paging.pageSize !== undefined) pageRequest = withQuery(pageRequest, paging.pageSizeParam, String(paging.pageSize))
  const offsetBase = paging.offsetBase ?? 0
  if (paging.style === 'offset_limit' && paging.offsetParam !== undefined) pageRequest = withQuery(pageRequest, paging.offsetParam, String(offsetBase))
  if (paging.style === 'page_number' && paging.pageParam !== undefined) pageRequest = withQuery(pageRequest, paging.pageParam, '1')
  let offset = 0
  let pageNo = 1
  let pages = 0
  let truncated = false
  let lastStatus = 0
  let lastHeaders: Readonly<Record<string, string>> | undefined
  for (;;) {
    const signed = await run.credential(pageRequest)
    if (!signed.ok) return end('refused', signed.code, 0, signed.sentence, '', { pages })
    const r = await run.send(signed.request)
    if (r.callRef !== undefined) callRefs.push(r.callRef)
    if (!r.ok) {
      if (r.kind === 'refused') return end('refused', r.code, 0, r.sentence, '', { pages })
      sent = true
      if (r.kind === 'too_large') return end('unavailable', r.code, 0, `${label} answered with more than can be read.`, '', { pages })
      return repeatable ? end('unavailable', r.code, 0, sentenceFor('unavailable', label), '', { pages }) : end('unknown', r.code, 0, sentenceFor('unknown', label), '', { pages })
    }
    sent = true
    pages++
    lastStatus = r.status
    lastHeaders = r.headers
    const parsed = parse(r, spec.responseFormat)
    // A failure answer is judged by its status even when its body is not the JSON it claims to be (a gateway's page).
    const outcome = outcomeOf(spec, r.status, parsed.ok ? parsed.value : undefined)
    if (!parsed.ok && outcome === 'ok') return end('invalid', 'NOT_JSON', r.status, sentenceFor('invalid', label), 'the answer was not JSON', { pages })
    if (outcome !== 'ok') return end(outcome, `HTTP_${String(r.status)}`, r.status, sentenceFor(outcome, label), r.body.slice(0, 300), { pages, ...rateHeaders(r.headers) })
    if (spec.responseFormat === 'file' && r.file === undefined) return end('unavailable', 'NO_FILE', r.status, `${label} answered, but the file could not be kept.`, '', { pages })
    const body = parsed.ok ? parsed.value : undefined
    // Top-level outputs come from the first page; list outputs gather from every page.
    if (pages === 1) for (const row of run.response.filter((x) => x.itemOf === undefined || x.itemOf === '')) {
      if (!declared.has(row.target)) continue
      const v = asJson(mapRow(row, body, maps))
      if (v !== undefined) top[row.target] = v
    }
    const listRows = run.response.filter((x) => x.itemOf !== undefined && x.itemOf !== '' && declared.has(x.itemOf))
    const pageItems = spec.itemsPath === undefined || spec.itemsPath === '' ? (Array.isArray(body) ? body : []) : getAt(body, spec.itemsPath)
    const list = Array.isArray(pageItems) ? pageItems : []
    for (const name of new Set(listRows.map((x) => x.itemOf as string))) {
      const rowsFor = listRows.filter((x) => x.itemOf === name)
      const into = items.get(name) ?? []
      for (const item of list) {
        const o: Record<string, unknown> = {}
        for (const row of rowsFor) { const v = mapRow(row, item, maps); if (v !== undefined) setAt(o, row.target, v) }
        into.push(asJson(o) as Json)
      }
      items.set(name, into)
    }
    // Where does it continue?
    let next: WireRequest | undefined
    const atPath = (p: string | undefined): unknown => (p === undefined ? undefined : getAt(body, p))
    switch (paging.style) {
      case 'none': break
      case 'cursor': {
        const c = atPath(paging.cursorPath)
        if ((typeof c === 'string' && c !== '') || typeof c === 'number') next = withQuery(pageRequest, paging.cursorParam ?? 'cursor', String(c))
        break
      }
      case 'token_in_body': {
        const c = atPath(paging.cursorPath)
        if ((typeof c === 'string' && c !== '') || typeof c === 'number') next = withBodyField(pageRequest, paging.cursorParam ?? 'pageToken', String(c))
        break
      }
      case 'offset_limit': {
        offset += list.length
        const total = Number(atPath(paging.totalPath))
        const more = list.length > 0 && (Number.isFinite(total) && paging.totalPath !== undefined ? offset < total : list.length === (paging.pageSize ?? -1))
        if (more) next = withQuery(pageRequest, paging.offsetParam ?? 'offset', String(offset + offsetBase))
        break
      }
      case 'page_number': {
        const last = paging.lastPath === undefined ? list.length < (paging.pageSize ?? Number.MAX_SAFE_INTEGER) : atPath(paging.lastPath) === true
        if (list.length > 0 && !last) { pageNo++; next = withQuery(pageRequest, paging.pageParam ?? 'page', String(pageNo)) }
        break
      }
      case 'link_header':
      case 'next_url_in_body': {
        const link = paging.style === 'link_header' ? parseLinkNext(r.headers['link']) : atPath(paging.cursorPath)
        if (typeof link === 'string' && link !== '') {
          let u: URL | undefined
          try { u = new URL(link, pageRequest.url) } catch { u = undefined }
          if (u === undefined || u.origin !== origin) { truncated = true; break }
          next = { ...pageRequest, url: u.toString() }
        }
        break
      }
    }
    if (next === undefined) break
    if (pages >= maxPages) { truncated = true; break }
    pageRequest = next
  }
  const output: Record<string, Json> = { ...top }
  for (const [name, list] of items) output[name] = list
  return { outcome: 'ok', code: 'OK', status: lastStatus, output, sentence: sentenceFor('ok', label), detail: '', pages, truncated, sent, safeToRepeat: repeatable, callRefs, ...(lastHeaders === undefined ? {} : rateHeaders(lastHeaders)) }
}

function withQuery(r: WireRequest, name: string, value: string): WireRequest {
  const u = new URL(r.url)
  u.searchParams.set(name, value)
  return { ...r, url: u.toString() }
}

function withBodyField(r: WireRequest, name: string, value: string): WireRequest {
  let body: Record<string, unknown> = {}
  try { body = r.body === undefined || r.body === '' ? {} : (JSON.parse(r.body) as Record<string, unknown>) } catch { body = {} }
  setAt(body, name, value)
  return { ...r, body: JSON.stringify(body), headers: { ...r.headers, 'content-type': 'application/json' } }
}
