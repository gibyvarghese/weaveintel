/**
 * Recording a sandbox exchange set (BUILD-PLAN 5, tier T1; F-L4). The recorder sits in front of a live Send and keeps
 * each request and answer, scrubbed, so a pack's `test/<name>.recording.json` can be replayed by `createReplaySend`
 * with no network at all.
 *
 * It is off unless the environment says `CONNECT_RECORD=1`: recording talks to a real (sandbox) system, so a test
 * run never does it by accident. What it writes:
 * - only allowlisted headers (`content-type`, `accept`, paging and throttling headers, the repeat key, …). The
 *   authorisation and cookie headers are dropped whatever the allowlist says;
 * - every url, header value and body passed through the scrubber (tokens, keys, emails, account-like numbers);
 * - the source marked `{ kind: 'sandbox', scrubbed: true }`, with the time from the injected clock.
 * Before writing, it checks the whole file with `findSecrets`; if anything still looks like a secret or personal
 * data it writes nothing and says what.
 *
 * Deterministic: with the fixed run reference (`REPLAY_RUN_REF`, so the derived repeat key is the same every time)
 * and an injected clock, recording the same exchanges twice writes the same bytes.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Send, SendResult, WireRequest } from '../types.js'
import { deriveIdempotencyKey } from '../runner/build.js'
import { checkRecording, findSecrets, scrub as scrubText, type Exchange, type RecordedRequest, type Recording } from './replay.js'

/** The run reference a recorded or replayed run uses, so its derived repeat key never changes. */
export const REPLAY_RUN_REF = 'replay'

/** The repeat key a recorded or replayed run sends for one tool (the runner's own derivation, fixed run reference). */
export function replayIdempotencyKey(toolKey: string, runRef: string = REPLAY_RUN_REF): string {
  return deriveIdempotencyKey(runRef, toolKey)
}

/** Headers a recording keeps by default (lower case). Anything else is dropped. */
export const RECORDED_HEADERS: readonly string[] = ['content-type', 'accept', 'idempotency-key', 'retry-after', 'link', 'location', 'etag', 'x-total-count', 'x-ratelimit-remaining', 'x-ratelimit-reset']

/** Never written, even when an allowlist names them. */
const NEVER = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key'])

/** Is recording switched on (`CONNECT_RECORD=1`)? */
export function recordingEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env['CONNECT_RECORD'] === '1'
}

/** How to record. */
export interface RecordingOptions {
  /** The connector pack's folder; the file goes to `<pack>/test/<name>.recording.json`. */
  readonly pack: string
  /** The recording's name (letters, digits, `-`, `_`). */
  readonly name: string
  /** Where it came from, in words ("Example sandbox, 2026-11-23"). */
  readonly ref: string
  /** Headers to keep, besides none (default `RECORDED_HEADERS`). Authorisation and cookies are never kept. */
  readonly headers?: readonly string[] | undefined
  /** The scrubber (default the kit's own). A caller may add its own replacements on top. */
  readonly scrub?: ((text: string) => string) | undefined
  /** The clock (default the real one). */
  readonly now?: (() => Date) | undefined
  /** The environment (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

/** What saving says. */
export type SaveResult = { readonly ok: true; readonly file: string } | { readonly ok: false; readonly problems: readonly string[] }

/** A recording Send. */
export interface RecordingSend {
  readonly send: Send
  /** The recording so far, scrubbed. */
  recording(): Recording & { readonly source: Recording['source'] & { readonly recordedAt: string } }
  /** Write it, unless anything in it still looks like a secret. */
  save(): SaveResult
}

const NAME = /^[A-Za-z0-9_-]{1,80}$/

/**
 * Put a recorder in front of a live Send.
 * @throws when recording is not switched on (`CONNECT_RECORD=1`), or the name is not a plain file name.
 */
export function createRecordingSend(live: Send, options: RecordingOptions): RecordingSend {
  if (!recordingEnabled(options.env)) throw new Error('Recording talks to a live sandbox: set CONNECT_RECORD=1 to allow it.')
  if (!NAME.test(options.name)) throw new Error('A recording name may only use letters, digits, "-" and "_".')
  const clean = options.scrub ?? scrubText
  const keep = new Set((options.headers ?? RECORDED_HEADERS).map((h) => h.toLowerCase()).filter((h) => !NEVER.has(h)))
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const exchanges: Exchange[] = []

  const headersOf = (h: Readonly<Record<string, string>>): Record<string, string> | undefined => {
    const out: Record<string, string> = {}
    for (const k of Object.keys(h).sort()) if (keep.has(k.toLowerCase())) out[k.toLowerCase()] = clean(h[k] ?? '')
    return Object.keys(out).length > 0 ? out : undefined
  }
  const requestOf = (r: WireRequest): RecordedRequest => {
    const headers = headersOf(r.headers)
    const body = r.body ?? ''
    let json: unknown
    if (body !== '') {
      try { json = JSON.parse(clean(body)) } catch { json = undefined }
    }
    return {
      method: r.method.toUpperCase(),
      url: clean(r.url),
      ...(headers === undefined ? {} : { headers }),
      ...(json !== undefined ? { json } : body !== '' ? { bodyIncludes: clean(body).slice(0, 200) } : {}),
    }
  }
  const nameOf = (r: WireRequest): string => `${r.method.toUpperCase()} ${new URL(r.url).pathname} ${String(exchanges.length + 1)}`

  const send: Send = async (r) => {
    const answer: SendResult = await live(r)
    const name = nameOf(r)
    const request = requestOf(r)
    if (answer.ok) {
      const headers = headersOf(answer.headers)
      exchanges.push({ name, request, response: { status: answer.status, ...(headers === undefined ? {} : { headers }), body: clean(answer.body) } })
    } else {
      exchanges.push({ name, request, failure: { kind: answer.kind, code: answer.code, sentence: clean(answer.sentence) } })
    }
    return answer
  }

  const recording = (): ReturnType<RecordingSend['recording']> => ({ source: { kind: 'sandbox', ref: options.ref, scrubbed: true, recordedAt: startedAt }, exchanges: [...exchanges] })

  return {
    send,
    recording,
    save() {
      const rec = recording()
      const text = `${JSON.stringify(rec, null, 2)}\n`
      const problems = [...checkRecording(rec), ...findSecrets(text).map((kind) => `The recording still contains something that looks like a ${kind}.`)]
      if (problems.length > 0) return { ok: false, problems: [...new Set(problems)] }
      const dir = join(options.pack, 'test')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${options.name}.recording.json`)
      writeFileSync(file, text)
      return { ok: true, file }
    },
  }
}
