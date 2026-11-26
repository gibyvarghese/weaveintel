/**
 * Calling one tool on a remote MCP server (Streamable HTTP) as a governed connector operation.
 *
 * WHY THIS IS NOT THE MCP CLIENT
 * `@weaveintel/mcp-client` is a full, session-oriented client (the MCP SDK underneath) for agents that hold a server
 * open. A connector tool is different: one pinned tool, called through the host's door like any REST operation,
 * recorded and replayed in tests, with declared outputs only. So this speaks the small part of MCP that needs:
 * `initialize`, `notifications/initialized`, `tools/list` and `tools/call`, over the caller's `send`.
 *
 * PINNING
 * A remote tool is never trusted live. {@link fingerprintTool} hashes what a model would read and what the server
 * would accept (name, description, input schema, annotations). The pack pins that hash; {@link listRemoteTools} at
 * install and on the host's schedule shows what changed, and a changed tool is a proposal for a person, never a silent
 * change.
 */
import { createHash } from 'node:crypto'
import type { ApplyResult } from '../credentials/apply.js'
import type { Json, Outcome, Send, WireRequest } from '../types.js'
import { outcomeForStatus } from '../types.js'
import { sentenceFor } from '../runner/run.js'
import type { DeclaredOutput, OutcomeRule, RequestMapping, ResponseMapping } from '../runner/spec.js'
import type { ChoiceMaps } from '../runner/transforms.js'
import { mapIntoArguments, mapOutputs } from './mapping.js'
import { rpc, type RpcResult } from './jsonrpc.js'

/** The MCP protocol versions this module speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const

/** What a server says about one tool. */
export interface RemoteToolDescriptor {
  readonly name: string
  readonly description?: string | undefined
  readonly inputSchema?: unknown
  readonly outputSchema?: unknown
  readonly annotations?: unknown
}

/** An open session: reuse it for later calls to the same server until it is refused. */
export interface McpSession {
  readonly id?: string | undefined
  readonly protocolVersion: string
}

/** The connection to one MCP server. */
export interface McpEndpoint {
  /** The server's MCP address (https). */
  readonly url: string
  readonly credential: (request: WireRequest) => Promise<ApplyResult>
  readonly send: Send
  /** What the client calls itself in `initialize`. */
  readonly clientName?: string | undefined
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
  return v
}

/** The pin of a tool: sha256 over its canonical name, description, input and output schemas and annotations. */
export function fingerprintTool(t: RemoteToolDescriptor): string {
  const text = JSON.stringify(canonical({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? null, outputSchema: t.outputSchema ?? null, annotations: t.annotations ?? null }))
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

const headersFor = (s: McpSession | undefined): Record<string, string> => (s === undefined ? {} : { 'mcp-protocol-version': s.protocolVersion, ...(s.id === undefined ? {} : { 'mcp-session-id': s.id }) })

/** Open a session (`initialize` then `notifications/initialized`). */
export async function openMcpSession(endpoint: McpEndpoint): Promise<{ readonly ok: true; readonly session: McpSession; readonly serverName?: string | undefined } | Extract<RpcResult, { ok: false }>> {
  const init = await rpc({
    url: endpoint.url, method: 'initialize', credential: endpoint.credential, send: endpoint.send,
    params: { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: endpoint.clientName ?? 'connector', version: '1' } },
  })
  if (!init.ok) return init
  const result = (init.result ?? {}) as Record<string, unknown>
  const version = typeof result['protocolVersion'] === 'string' ? result['protocolVersion'] : MCP_PROTOCOL_VERSIONS[0]
  if (!(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return { ok: false, kind: 'bad_answer', code: 'MCP_VERSION', sentence: '', sent: true }
  const session: McpSession = { protocolVersion: version, ...(init.headers['mcp-session-id'] === undefined ? {} : { id: init.headers['mcp-session-id'] }) }
  const ack = await rpc({ url: endpoint.url, method: 'notifications/initialized', notification: true, headers: headersFor(session), credential: endpoint.credential, send: endpoint.send })
  if (!ack.ok) return ack
  const info = result['serverInfo'] as Record<string, unknown> | undefined
  return { ok: true, session, ...(typeof info?.['name'] === 'string' ? { serverName: info['name'] } : {}) }
}

/** Every tool the server offers (following `nextCursor`, at most `maxPages` pages). */
export async function listRemoteTools(endpoint: McpEndpoint, options: { readonly session?: McpSession | undefined; readonly maxPages?: number | undefined } = {}): Promise<{ readonly ok: true; readonly tools: readonly (RemoteToolDescriptor & { readonly fingerprint: string })[]; readonly session: McpSession } | Extract<RpcResult, { ok: false }>> {
  let session = options.session
  if (session === undefined) {
    const opened = await openMcpSession(endpoint)
    if (!opened.ok) return opened
    session = opened.session
  }
  const tools: (RemoteToolDescriptor & { fingerprint: string })[] = []
  let cursor: string | undefined
  for (let page = 0; page < (options.maxPages ?? 20); page++) {
    const r = await rpc({ url: endpoint.url, method: 'tools/list', params: cursor === undefined ? {} : { cursor }, headers: headersFor(session), credential: endpoint.credential, send: endpoint.send })
    if (!r.ok) return r
    const res = (r.result ?? {}) as Record<string, unknown>
    for (const t of Array.isArray(res['tools']) ? (res['tools'] as Record<string, unknown>[]) : []) {
      if (typeof t['name'] !== 'string') continue
      const d: RemoteToolDescriptor = { name: t['name'], ...(typeof t['description'] === 'string' ? { description: t['description'] } : {}), inputSchema: t['inputSchema'], outputSchema: t['outputSchema'], annotations: t['annotations'] }
      tools.push({ ...d, fingerprint: fingerprintTool(d) })
    }
    cursor = typeof res['nextCursor'] === 'string' && res['nextCursor'] !== '' ? res['nextCursor'] : undefined
    if (cursor === undefined) break
  }
  return { ok: true, tools, session }
}

/** How pinned tools compare with what a server offers now. */
export interface PinDrift {
  readonly unchanged: readonly string[]
  /** Pinned, still offered, but its fingerprint differs: a proposal for a person. */
  readonly changed: readonly { readonly name: string; readonly pinned: string; readonly now: string }[]
  /** Pinned but no longer offered. */
  readonly gone: readonly string[]
  /** Offered but not pinned: never offered to a model until a person pins it. */
  readonly added: readonly string[]
}

/** Compare pins with a fresh listing. Pure. */
export function comparePins(pins: Readonly<Record<string, string>>, offered: readonly { readonly name: string; readonly fingerprint: string }[]): PinDrift {
  const now = new Map(offered.map((t) => [t.name, t.fingerprint]))
  const unchanged: string[] = []
  const changed: { name: string; pinned: string; now: string }[] = []
  const gone: string[] = []
  for (const [name, pinned] of Object.entries(pins)) {
    const f = now.get(name)
    if (f === undefined) gone.push(name)
    else if (f === pinned) unchanged.push(name)
    else changed.push({ name, pinned, now: f })
  }
  return { unchanged, changed, gone, added: offered.map((t) => t.name).filter((n) => pins[n] === undefined) }
}

/** One pinned remote tool, as a pack's rows describe it. */
export interface RemoteToolSpec {
  readonly key: string
  /** The tool's name on the server. */
  readonly remoteName: string
  /** The pin. When `verifyPin` is set, a call first lists the tools and refuses on any difference. */
  readonly fingerprint: string
  readonly verifyPin?: boolean | undefined
  /** Refuse before sending a call whose request is longer than this. */
  readonly maxRequestBytes?: number | undefined
  /** JSON-RPC error codes (`vendorCodePath: 'error.code'`) or HTTP statuses → outcomes. */
  readonly outcomes?: readonly OutcomeRule[] | undefined
}

/** Everything one remote tool call needs. */
export interface RemoteRunInput {
  readonly spec: RemoteToolSpec
  readonly endpoint: McpEndpoint
  /** `arguments.x` targets. */
  readonly request: readonly RequestMapping[]
  /** Paths into the result: `structuredContent.x`, `content.0.text`, `$text` (all text content joined). */
  readonly response: readonly ResponseMapping[]
  readonly outputs: readonly DeclaredOutput[]
  readonly input: Readonly<Record<string, unknown>>
  readonly settings: Readonly<Record<string, string>>
  readonly choiceMaps?: ChoiceMaps | undefined
  readonly label: string
  readonly session?: McpSession | undefined
}

/** How a remote call ended (the same shape a host already handles for operations, plus the session to reuse). */
export interface RemoteRunResult {
  readonly outcome: Outcome
  readonly code: string
  readonly output: Readonly<Record<string, Json>>
  readonly sentence: string
  readonly detail: string
  readonly sent: boolean
  readonly session?: McpSession | undefined
  readonly callRefs: readonly string[]
}

function outcomeOfFailure(f: Extract<RpcResult, { ok: false }>, rules: readonly OutcomeRule[]): Exclude<Outcome, 'refused'> {
  const code = f.error === undefined ? undefined : String(f.error.code)
  const byCode = rules.find((r) => r.vendorCodePath === 'error.code' && r.vendorCode === code && (r.status === undefined || r.status === f.status))
  if (byCode !== undefined) return byCode.outcome === 'refused' ? 'invalid' : byCode.outcome
  const byStatus = rules.find((r) => r.status !== undefined && r.status === f.status && r.vendorCodePath === undefined)
  if (byStatus !== undefined) return byStatus.outcome === 'refused' ? 'invalid' : byStatus.outcome
  if (f.kind === 'http' && f.status !== undefined) { const o = outcomeForStatus(f.status); return o === 'ok' || o === 'refused' ? 'invalid' : o }
  if (f.kind === 'rpc') return code === '-32601' ? 'not_found' : code === '-32602' ? 'invalid' : 'unavailable'
  return 'unavailable'
}

/** Call one pinned remote tool. Never throws for anything the outside did. */
export async function runRemoteTool(run: RemoteRunInput): Promise<RemoteRunResult> {
  const { spec, endpoint, label } = run
  const end = (outcome: Outcome, code: string, sentence: string, extra: Partial<RemoteRunResult> = {}): RemoteRunResult => ({ outcome, code, output: {}, sentence, detail: '', sent: false, callRefs: [], ...extra })
  const args = mapIntoArguments(run.request, run.input, run.settings, run.choiceMaps ?? {}, 'arguments')
  if (!args.ok) return end('refused', args.code, args.sentence)
  const payload = { name: spec.remoteName, arguments: args.value }
  if (spec.maxRequestBytes !== undefined && Buffer.byteLength(JSON.stringify(payload), 'utf8') > spec.maxRequestBytes) return end('refused', 'TOO_LARGE', `This is longer than the application accepts (${String(spec.maxRequestBytes)} bytes), so it was not sent.`)
  let session = run.session
  if (session === undefined || spec.verifyPin === true) {
    const listed = await listRemoteTools(endpoint, { session })
    if (!listed.ok) return end(listed.kind === 'refused' ? 'refused' : outcomeOfFailure(listed, spec.outcomes ?? []), listed.code, listed.kind === 'refused' ? listed.sentence : sentenceFor('unavailable', label), { sent: listed.sent })
    session = listed.session
    const offered = listed.tools.find((t) => t.name === spec.remoteName)
    if (offered === undefined) return end('refused', 'REMOTE_TOOL_GONE', `${label} is no longer offered by the application, so nothing was sent.`, { session })
    if (offered.fingerprint !== spec.fingerprint) return end('refused', 'REMOTE_TOOL_CHANGED', `${label} has changed at the application since it was approved, so nothing was sent. An administrator needs to review the change.`, { session })
  }
  const r = await rpc({ url: endpoint.url, method: 'tools/call', params: payload, headers: headersFor(session), credential: endpoint.credential, send: endpoint.send })
  const callRefs = r.ok && r.callRef !== undefined ? [r.callRef] : []
  if (!r.ok) {
    if (r.kind === 'refused') return end('refused', r.code, r.sentence, { session })
    // An expired session is answered 404 by the server: the host drops it and the next call opens a new one.
    const o = outcomeOfFailure(r, spec.outcomes ?? [])
    return end(o, r.code, sentenceFor(o, label), { sent: r.sent, detail: r.error?.message.slice(0, 300) ?? '', ...(r.status === 404 ? {} : { session }) })
  }
  const result = (r.result ?? {}) as Record<string, unknown>
  if (result['isError'] === true) {
    const rule = (spec.outcomes ?? []).find((x) => x.vendorCodePath === 'isError')
    const o = rule === undefined || rule.outcome === 'refused' ? 'invalid' : rule.outcome
    return end(o, 'TOOL_ERROR', sentenceFor(o === 'ok' ? 'invalid' : o, label), { sent: true, session, callRefs })
  }
  const content = Array.isArray(result['content']) ? (result['content'] as Record<string, unknown>[]) : []
  const view = { ...result, $text: content.filter((c) => c['type'] === 'text' && typeof c['text'] === 'string').map((c) => c['text'] as string).join('\n') }
  return { outcome: 'ok', code: 'OK', output: mapOutputs(run.response, run.outputs, view, run.choiceMaps ?? {}), sentence: sentenceFor('ok', label), detail: '', sent: true, session, callRefs }
}
