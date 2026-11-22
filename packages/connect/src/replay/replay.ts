/**
 * Record-and-replay for connector tests (BUILD-PLAN 5, tier T1). A recording is a list of request and answer pairs,
 * built from vendor documentation examples (hand-made, and it says so) or recorded from a sandbox and scrubbed.
 * The replay `Send` answers only what was recorded: a request that is not in the recording throws, so a test that
 * sends something unexpected fails.
 */
import type { Send, SendResult, WireRequest } from '../types.js'

/** One recorded request, as precise as the test needs. */
export interface RecordedRequest {
  readonly method: string
  /** Compared with query parameters in any order. */
  readonly url: string
  /** Headers that must be present with these values (names lower case). Others are ignored. */
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** The body must parse to this JSON. */
  readonly json?: unknown
  /** The body must contain this text. */
  readonly bodyIncludes?: string | undefined
}

/** One exchange: the answer, or a failure as the door reports it. */
export type Exchange =
  | { readonly name: string; readonly request: RecordedRequest; readonly response: { readonly status: number; readonly headers?: Readonly<Record<string, string>> | undefined; readonly body: string }; readonly repeat?: boolean | undefined }
  | { readonly name: string; readonly request: RecordedRequest; readonly failure: { readonly kind: 'timeout' | 'unreachable' | 'refused' | 'too_large'; readonly code: string; readonly sentence?: string | undefined }; readonly repeat?: boolean | undefined }

/** A recording file. */
export interface Recording {
  readonly source: { readonly kind: 'documentation' | 'sandbox'; readonly ref: string; readonly scrubbed: boolean }
  readonly exchanges: readonly Exchange[]
}

const norm = (url: string): string => {
  const u = new URL(url)
  const q = [...u.searchParams.entries()].sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b)))
  return `${u.origin}${u.pathname}?${new URLSearchParams(q).toString()}`
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]))
  return v
}

function matches(rec: RecordedRequest, r: WireRequest): boolean {
  if (rec.method.toUpperCase() !== r.method.toUpperCase()) return false
  if (norm(rec.url) !== norm(r.url)) return false
  for (const [k, v] of Object.entries(rec.headers ?? {})) if ((r.headers[k.toLowerCase()] ?? '') !== v) return false
  if (rec.json !== undefined) {
    try { if (!deepEqual(JSON.parse(r.body ?? ''), rec.json)) return false } catch { return false }
  }
  if (rec.bodyIncludes !== undefined && !(r.body ?? '').includes(rec.bodyIncludes)) return false
  return true
}

/** A replaying Send and what it was asked. */
export interface ReplaySend {
  readonly send: Send
  /** The names of the exchanges used, in order. */
  used(): readonly string[]
  /** Every request it was sent, in order. */
  requests(): readonly WireRequest[]
}

/**
 * Build a Send that answers from a recording. Each exchange answers once unless it says `repeat`.
 * @throws (from `send`) for a request that is not in the recording.
 */
export function createReplaySend(recording: Recording): ReplaySend {
  const spent = new Set<number>()
  const used: string[] = []
  const seen: WireRequest[] = []
  const send: Send = async (r) => {
    seen.push(r)
    const i = recording.exchanges.findIndex((x, n) => (x.repeat === true || !spent.has(n)) && matches(x.request, r))
    if (i < 0) throw new Error(`${r.method} ${r.url} is not in the recording`)
    spent.add(i)
    const x = recording.exchanges[i] as Exchange
    used.push(x.name)
    if ('failure' in x) return { ok: false, kind: x.failure.kind, code: x.failure.code, sentence: x.failure.sentence ?? x.failure.code } satisfies SendResult
    const headers = Object.fromEntries(Object.entries(x.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return { ok: true, status: x.response.status, headers: { 'content-type': 'application/json', ...headers }, body: x.response.body } satisfies SendResult
  }
  return { send, used: () => [...used], requests: () => [...seen] }
}

const PATTERNS: readonly { readonly name: string; readonly re: RegExp; readonly put: string }[] = [
  { name: 'JSON web token', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, put: '<token>' },
  { name: 'bearer token', re: /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, put: '$1<token>' },
  { name: 'secret key', re: /\b(sk|pk|rk)[-_](live|test)?[-_]?[A-Za-z0-9]{12,}\b/g, put: '<token>' },
  { name: 'cloud access key', re: /\bAKIA[0-9A-Z]{16}\b/g, put: '<token>' },
  { name: 'source host token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, put: '<token>' },
  { name: 'chat token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, put: '<token>' },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, put: '<private key>' },
  { name: 'email address', re: /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, put: '<email>' },
  { name: 'long number', re: /\b\d{9,19}\b/g, put: '<number>' },
]

/** Replace tokens, keys, emails (other than example.com/org/net) and account-like numbers with placeholders. */
export function scrub(text: string): string {
  return PATTERNS.reduce((t, p) => t.replace(p.re, p.put), text)
}

/** What in a text looks like a secret or personal data (each a kind, not the value). */
export function findSecrets(text: string): readonly string[] {
  return PATTERNS.filter((p) => new RegExp(p.re.source, p.re.flags).test(text)).map((p) => p.name)
}

/**
 * Check a recording before it is committed: it says where it came from, says it was scrubbed, and contains nothing
 * that looks like a secret or personal data.
 * @returns the problems in plain words (empty when it is fine).
 */
export function checkRecording(recording: Recording): readonly string[] {
  const out: string[] = []
  if (recording.source.ref.trim() === '') out.push('A recording must say where it came from (source.ref).')
  if (!recording.source.scrubbed) out.push('A recording must be scrubbed before it is committed.')
  for (const x of recording.exchanges) {
    const text = JSON.stringify(x)
    for (const kind of findSecrets(text)) out.push(`Exchange “${x.name}” contains something that looks like a ${kind}.`)
  }
  return out
}
