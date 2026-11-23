/**
 * JSON-RPC 2.0 over the caller's door, for MCP (Streamable HTTP) and A2A. One request, one answer: a JSON body, or a
 * server-sent-events body read to its end (the door returns the whole body), from which the answer with our id is
 * taken. No sockets, no retries, no state: the host's door, call rules and log apply as for any operation.
 */
import { randomUUID } from 'node:crypto'
import type { ApplyResult } from '../credentials/apply.js'
import type { Send, WireRequest } from '../types.js'

/** A JSON-RPC error object. */
export interface RpcError { readonly code: number; readonly message: string; readonly data?: unknown }

/** How one JSON-RPC call ended. */
export type RpcResult =
  | { readonly ok: true; readonly result: unknown; readonly headers: Readonly<Record<string, string>>; readonly status: number; readonly callRef?: string | undefined }
  | { readonly ok: false; readonly kind: 'refused' | 'transport' | 'http' | 'rpc' | 'bad_answer'; readonly code: string; readonly sentence: string; readonly status?: number | undefined; readonly error?: RpcError | undefined; readonly headers?: Readonly<Record<string, string>> | undefined; readonly sent: boolean }

/** What a call needs. */
export interface RpcCall {
  readonly url: string
  readonly method: string
  readonly params?: unknown
  /** Extra headers (an MCP session id, a protocol version). */
  readonly headers?: Readonly<Record<string, string>> | undefined
  /** A notification has no id and expects no answer. */
  readonly notification?: boolean | undefined
  readonly credential: (request: WireRequest) => Promise<ApplyResult>
  readonly send: Send
}

/** Read the events of a server-sent-events body: each event's `data` lines joined. */
export function readSseEvents(body: string): readonly string[] {
  const out: string[] = []
  for (const block of body.replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''))
    if (data.length > 0) out.push(data.join('\n'))
  }
  return out
}

/** Every JSON-RPC message in an answer body (one JSON object, a batch, or an event stream). */
export function rpcMessages(body: string, contentType: string): readonly Record<string, unknown>[] {
  const texts = contentType.toLowerCase().includes('text/event-stream') ? readSseEvents(body) : [body]
  const out: Record<string, unknown>[] = []
  for (const t of texts) {
    if (t.trim() === '') continue
    try {
      const v = JSON.parse(t) as unknown
      for (const m of Array.isArray(v) ? v : [v]) if (m !== null && typeof m === 'object') out.push(m as Record<string, unknown>)
    } catch { /* a keep-alive or a non-JSON event: skipped */ }
  }
  return out
}

/** Send one JSON-RPC request (or notification) and read its answer. Never throws for anything the outside did. */
export async function rpc(call: RpcCall): Promise<RpcResult> {
  const id = call.notification === true ? undefined : randomUUID()
  const request: WireRequest = {
    method: 'POST',
    url: call.url,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...call.headers },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method: call.method, ...(call.params === undefined ? {} : { params: call.params }) }),
  }
  const signed = await call.credential(request)
  if (!signed.ok) return { ok: false, kind: 'refused', code: signed.code, sentence: signed.sentence, sent: false }
  const r = await call.send(signed.request)
  if (!r.ok) return { ok: false, kind: r.kind === 'refused' ? 'refused' : 'transport', code: r.code, sentence: r.sentence, sent: r.kind !== 'refused' }
  if (r.status < 200 || r.status >= 300) {
    const msgs = rpcMessages(r.body, r.headers['content-type'] ?? '')
    const err = msgs.find((m) => m['error'] !== undefined)?.['error'] as RpcError | undefined
    return { ok: false, kind: 'http', code: `HTTP_${String(r.status)}`, sentence: '', status: r.status, ...(err === undefined ? {} : { error: err }), headers: r.headers, sent: true }
  }
  if (id === undefined) return { ok: true, result: undefined, headers: r.headers, status: r.status, callRef: r.callRef }
  // One HTTP request carries one JSON-RPC request, so every answer in its body is for it: an A2A stream sends several
  // (the task's updates), an MCP stream may send progress notifications first (they have a method; skipped). An answer
  // carrying a different id than ours is still preferred last, so a well-behaved server is read exactly.
  const answers = rpcMessages(r.body, r.headers['content-type'] ?? '').filter((m) => m['method'] === undefined && ('result' in m || 'error' in m))
  const mine = answers.some((m) => m['id'] === id) ? answers.filter((m) => m['id'] === id) : answers
  const failed = mine.find((m) => m['error'] !== undefined)
  if (failed !== undefined) return { ok: false, kind: 'rpc', code: `RPC_${String((failed['error'] as RpcError).code)}`, sentence: '', status: r.status, error: failed['error'] as RpcError, headers: r.headers, sent: true }
  if (mine.length === 0) return { ok: false, kind: 'bad_answer', code: 'NO_ANSWER', sentence: '', status: r.status, sent: true }
  return { ok: true, result: mine.length > 1 ? mine.map((m) => m['result']) : mine[0]?.['result'], headers: r.headers, status: r.status, callRef: r.callRef }
}
