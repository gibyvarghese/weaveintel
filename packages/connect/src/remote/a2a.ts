/**
 * Asking a remote A2A agent to do one skill, as a governed connector operation.
 *
 * VERSIONS
 * The card says which protocol the agent speaks. A2A 0.3 (ServiceNow AI agents, Atlassian Rovo at the time of
 * writing) uses `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, parts with `kind`, and lower-case task
 * states. A2A 1.0 uses `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `ROLE_USER` and `TASK_STATE_*`.
 * This module writes the one the card names and reads both, and hands the host one closed list of task states.
 *
 * PINNING
 * The card is pinned like a remote tool: {@link fingerprintCard} over the parts a caller relies on (endpoint, version,
 * skills, security). A changed card is a proposal for a person. A skill is chosen from the pinned card's skills only.
 *
 * Why not `@weaveintel/a2a`'s client: that client serves agents (sessions, streaming to a UI, the platform's own
 * hardened fetch). A connector call goes through the host's door, is recorded and replayed in tests, and keeps
 * declared outputs only. Both read the same card shape.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ApplyResult } from '../credentials/apply.js'
import type { Json, Outcome, Send, WireRequest } from '../types.js'
import { outcomeForStatus } from '../types.js'
import { sentenceFor } from '../runner/run.js'
import type { DeclaredOutput, OutcomeRule, RequestMapping, ResponseMapping } from '../runner/spec.js'
import type { ChoiceMaps } from '../runner/transforms.js'
import { mapIntoArguments, mapOutputs } from './mapping.js'
import { rpc, type RpcResult } from './jsonrpc.js'

/** The task states, one closed list across versions. */
export const AGENT_TASK_STATES = ['submitted', 'working', 'input_required', 'auth_required', 'completed', 'failed', 'canceled', 'rejected', 'unknown'] as const
/** One task state. */
export type AgentTaskState = (typeof AGENT_TASK_STATES)[number]

/** The protocol families this module writes. */
export type A2AVersion = '0.3' | '1.0'

/** What a caller relies on in a card. */
export interface AgentCardSummary {
  readonly name: string
  readonly endpoint: string
  readonly version: A2AVersion
  readonly protocolVersion: string
  readonly streaming: boolean
  readonly skills: readonly { readonly id: string; readonly name: string; readonly description?: string | undefined }[]
  readonly fingerprint: string
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
  return v
}

const str = (o: Record<string, unknown> | undefined, k: string): string => (o !== undefined && typeof o[k] === 'string' ? (o[k] as string) : '')

/** The pin of a card: sha256 over its endpoint, version, capabilities, skills and security. */
export function fingerprintCard(card: Record<string, unknown>): string {
  const pinned = { url: card['url'] ?? null, supportedInterfaces: card['supportedInterfaces'] ?? null, protocolVersion: card['protocolVersion'] ?? null, capabilities: card['capabilities'] ?? null, skills: card['skills'] ?? null, securitySchemes: card['securitySchemes'] ?? null, security: card['security'] ?? null }
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(pinned))).digest('hex')}`
}

/** Read a card into what a caller relies on. Pure. */
export function summariseCard(card: Record<string, unknown>): AgentCardSummary | undefined {
  const interfaces = Array.isArray(card['supportedInterfaces']) ? (card['supportedInterfaces'] as Record<string, unknown>[]) : []
  const jsonrpc = interfaces.find((i) => /json-?rpc/i.test(str(i, 'protocolBinding') || str(i, 'transport')))
  const endpoint = str(card, 'url') || str(jsonrpc, 'url')
  let u: URL
  try { u = new URL(endpoint) } catch { return undefined }
  if (u.protocol !== 'https:') return undefined
  const pv = str(card, 'protocolVersion') || str(jsonrpc, 'protocolVersion') || (interfaces.length > 0 ? '1.0' : '0.3.0')
  const version: A2AVersion = /^0\./.test(pv) ? '0.3' : '1.0'
  const caps = (card['capabilities'] ?? {}) as Record<string, unknown>
  const skills = (Array.isArray(card['skills']) ? (card['skills'] as Record<string, unknown>[]) : [])
    .filter((s) => str(s, 'id') !== '')
    .map((s) => ({ id: str(s, 'id'), name: str(s, 'name') || str(s, 'id'), ...(str(s, 'description') === '' ? {} : { description: str(s, 'description') }) }))
  return { name: str(card, 'name'), endpoint: u.toString(), version, protocolVersion: pv, streaming: caps['streaming'] === true, skills, fingerprint: fingerprintCard(card) }
}

/**
 * Fetch and read a card.
 * @param cardUrl The card's full address (`/.well-known/agent-card.json`, `/.well-known/agent.json`, or a vendor path).
 */
export async function resolveAgentCard(cardUrl: string, context: { readonly send: Send; readonly credential?: ((r: WireRequest) => Promise<ApplyResult>) | undefined }): Promise<{ readonly ok: true; readonly card: AgentCardSummary; readonly raw: Record<string, unknown> } | { readonly ok: false; readonly code: string; readonly sentence: string }> {
  let u: URL
  try { u = new URL(cardUrl) } catch { return { ok: false, code: 'NOT_AN_ADDRESS', sentence: 'The agent card’s address is not a web address.' } }
  if (u.protocol !== 'https:') return { ok: false, code: 'NOT_HTTPS', sentence: 'Only secure (https) addresses can be reached.' }
  let request: WireRequest = { method: 'GET', url: u.toString(), headers: { accept: 'application/json' } }
  if (context.credential !== undefined) {
    const signed = await context.credential(request)
    if (!signed.ok) return { ok: false, code: signed.code, sentence: signed.sentence }
    request = signed.request
  }
  const r = await context.send(request)
  if (!r.ok) return { ok: false, code: r.code, sentence: r.sentence }
  if (r.status < 200 || r.status >= 300) return { ok: false, code: `HTTP_${String(r.status)}`, sentence: 'The agent card could not be read.' }
  let raw: unknown
  try { raw = JSON.parse(r.body) } catch { return { ok: false, code: 'NOT_JSON', sentence: 'The agent card is not JSON.' } }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'NOT_A_CARD', sentence: 'That is not an agent card.' }
  const card = summariseCard(raw as Record<string, unknown>)
  if (card === undefined) return { ok: false, code: 'NOT_A_CARD', sentence: 'The agent card has no secure (https) address to call.' }
  // The endpoint must be on the card's own host: a card cannot send our calls somewhere else.
  if (new URL(card.endpoint).host !== u.host) return { ok: false, code: 'OUTSIDE_REACH', sentence: 'The agent card names an address on another host, so it was not used.' }
  return { ok: true, card, raw: raw as Record<string, unknown> }
}

/** Read a task (or a direct message answer) from either version into one shape. Pure. */
export function readTask(result: unknown): { readonly taskId?: string | undefined; readonly contextId?: string | undefined; readonly state: AgentTaskState; readonly text: string; readonly data: readonly unknown[]; readonly artifacts: readonly Record<string, unknown>[] } {
  // A stream answers a list of events: the last task or status wins; artifact events add up.
  const events = Array.isArray(result) ? (result as unknown[]) : [result]
  let task: Record<string, unknown> | undefined
  let state: AgentTaskState = 'unknown'
  const texts: string[] = []
  const data: unknown[] = []
  const artifacts: Record<string, unknown>[] = []
  const takeParts = (parts: unknown): void => {
    for (const p of Array.isArray(parts) ? (parts as Record<string, unknown>[]) : []) {
      if (typeof p['text'] === 'string') texts.push(p['text'])
      else if (p['data'] !== undefined) data.push(p['data'])
    }
  }
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue
    // 1.0 wraps answers: { task }, { message }, { statusUpdate }, { artifactUpdate }.
    const e = raw as Record<string, unknown>
    const inner = (e['task'] ?? e['message'] ?? e['statusUpdate'] ?? e['artifactUpdate'] ?? e) as Record<string, unknown>
    const kind = str(inner, 'kind')
    if (inner['parts'] !== undefined && inner['status'] === undefined && kind !== 'artifact-update') { takeParts(inner['parts']); if (state === 'unknown') state = 'completed'; continue }
    if (inner['artifact'] !== undefined) { const a = inner['artifact'] as Record<string, unknown>; artifacts.push(a); takeParts(a['parts']); continue }
    if (inner['status'] !== undefined) {
      task = inner['id'] !== undefined ? inner : task
      state = normaliseState(str(inner['status'] as Record<string, unknown>, 'state'))
      for (const a of Array.isArray(inner['artifacts']) ? (inner['artifacts'] as Record<string, unknown>[]) : []) { artifacts.push(a); takeParts(a['parts']) }
      const msg = (inner['status'] as Record<string, unknown>)['message'] as Record<string, unknown> | undefined
      if (msg !== undefined && (state === 'input_required' || state === 'failed' || state === 'rejected' || state === 'auth_required')) takeParts(msg['parts'])
      if (task === undefined && typeof inner['taskId'] === 'string') task = { id: inner['taskId'], contextId: inner['contextId'] }
    }
  }
  return { ...(task === undefined ? {} : { taskId: str(task, 'id') || undefined, contextId: str(task, 'contextId') || undefined }), state, text: texts.join('\n'), data, artifacts }
}

/** One closed list of states from either version's spelling. */
export function normaliseState(raw: string): AgentTaskState {
  const s = raw.toLowerCase().replace(/^task_state_/, '').replace(/-/g, '_')
  if (s === 'cancelled') return 'canceled'
  return (AGENT_TASK_STATES as readonly string[]).includes(s) ? (s as AgentTaskState) : 'unknown'
}

/** One pinned agent skill, as a pack's rows describe it. */
export interface AgentSkillSpec {
  readonly key: string
  readonly skillId: string
  /** The pinned card fingerprint; a different card is refused. */
  readonly cardFingerprint: string
  /** Ask for streaming (`message/stream`), for agents whose synchronous answer is cut short. */
  readonly stream?: boolean | undefined
  readonly outcomes?: readonly OutcomeRule[] | undefined
}

/** Everything one agent call needs. */
export interface AgentRunInput {
  readonly spec: AgentSkillSpec
  readonly card: AgentCardSummary
  readonly credential: (request: WireRequest) => Promise<ApplyResult>
  readonly send: Send
  /** `text` targets (the message's text part) and `data:x` targets (one data part). */
  readonly request: readonly RequestMapping[]
  /** Paths into `{ state, taskId, contextId, text, data, artifacts }`. */
  readonly response: readonly ResponseMapping[]
  readonly outputs: readonly DeclaredOutput[]
  readonly input: Readonly<Record<string, unknown>>
  readonly settings: Readonly<Record<string, string>>
  readonly choiceMaps?: ChoiceMaps | undefined
  readonly label: string
  /** Continue an earlier task (an answer to `input_required`). */
  readonly taskId?: string | undefined
  readonly contextId?: string | undefined
}

/** How an agent call ended: the run result plus the task, so the host can follow a long task. */
export interface AgentRunResult {
  readonly outcome: Outcome
  readonly code: string
  readonly output: Readonly<Record<string, Json>>
  readonly sentence: string
  readonly detail: string
  readonly sent: boolean
  readonly state: AgentTaskState
  readonly taskId?: string | undefined
  readonly contextId?: string | undefined
}

const METHODS: Readonly<Record<A2AVersion, { readonly send: string; readonly stream: string; readonly get: string; readonly cancel: string }>> = {
  '0.3': { send: 'message/send', stream: 'message/stream', get: 'tasks/get', cancel: 'tasks/cancel' },
  '1.0': { send: 'SendMessage', stream: 'SendStreamingMessage', get: 'GetTask', cancel: 'CancelTask' },
}

function failureOutcome(f: Extract<RpcResult, { ok: false }>, rules: readonly OutcomeRule[]): Exclude<Outcome, 'refused'> {
  const code = f.error === undefined ? undefined : String(f.error.code)
  const rule = rules.find((r) => (r.vendorCodePath === 'error.code' && r.vendorCode === code) || (r.vendorCodePath === undefined && r.status !== undefined && r.status === f.status))
  if (rule !== undefined) return rule.outcome === 'refused' ? 'invalid' : rule.outcome
  if (f.kind === 'http' && f.status !== undefined) { const o = outcomeForStatus(f.status); return o === 'ok' || o === 'refused' ? 'invalid' : o }
  // A2A: -32001 task not found, -32002 not cancelable, -32004 unsupported, -32005 incompatible content.
  if (code === '-32001') return 'not_found'
  if (code === '-32002') return 'conflict'
  if (code === '-32602' || code === '-32004' || code === '-32005') return 'invalid'
  return 'unavailable'
}

const STATE_OUTCOME: Readonly<Record<AgentTaskState, Exclude<Outcome, 'refused'>>> = {
  submitted: 'ok', working: 'ok', input_required: 'ok', auth_required: 'forbidden', completed: 'ok', failed: 'unavailable', canceled: 'conflict', rejected: 'invalid', unknown: 'unknown',
}

/** Ask the agent to do the pinned skill. Never throws for anything the outside did. */
export async function sendAgentMessage(run: AgentRunInput): Promise<AgentRunResult> {
  const { spec, card, label } = run
  const end = (outcome: Outcome, code: string, sentence: string, extra: Partial<AgentRunResult> = {}): AgentRunResult => ({ outcome, code, output: {}, sentence, detail: '', sent: false, state: 'unknown', ...extra })
  if (card.fingerprint !== spec.cardFingerprint) return end('refused', 'AGENT_CARD_CHANGED', `${label}: the agent has changed since it was approved, so nothing was sent. An administrator needs to review the change.`)
  if (!card.skills.some((s) => s.id === spec.skillId)) return end('refused', 'AGENT_SKILL_GONE', `${label} is no longer offered by the agent, so nothing was sent.`)
  // Rows write `message:text` and `message:data.x`.
  const mapped = mapIntoArguments(run.request, run.input, run.settings, run.choiceMaps ?? {}, 'message')
  if (!mapped.ok) return end('refused', mapped.code, mapped.sentence)
  const text = typeof mapped.value['text'] === 'string' ? mapped.value['text'] : undefined
  const dataPart = mapped.value['data'] as Record<string, unknown> | undefined
  if (text === undefined && dataPart === undefined) return end('refused', 'BAD_INPUT', 'Something to ask the agent is needed.')
  const v03 = card.version === '0.3'
  const parts = [
    ...(text === undefined ? [] : [v03 ? { kind: 'text', text } : { text }]),
    ...(dataPart === undefined ? [] : [v03 ? { kind: 'data', data: dataPart } : { data: dataPart }]),
  ]
  const message = {
    ...(v03 ? { kind: 'message', role: 'user' } : { role: 'ROLE_USER' }),
    messageId: randomUUID(),
    parts,
    ...(run.taskId === undefined ? {} : { taskId: run.taskId }),
    ...(run.contextId === undefined ? {} : { contextId: run.contextId }),
    metadata: { skillId: spec.skillId },
  }
  const stream = spec.stream === true && card.streaming
  const method = stream ? METHODS[card.version].stream : METHODS[card.version].send
  const params = v03 ? { message, ...(stream ? {} : { configuration: { blocking: true } }) } : { message, ...(stream ? {} : { configuration: { blocking: true } }) }
  const r = await rpc({ url: card.endpoint, method, params, headers: v03 ? {} : { 'a2a-version': '1.0' }, credential: run.credential, send: run.send })
  if (!r.ok) {
    if (r.kind === 'refused') return end('refused', r.code, r.sentence)
    const o = failureOutcome(r, spec.outcomes ?? [])
    return end(o, r.code, sentenceFor(o, label), { sent: r.sent, detail: r.error?.message.slice(0, 300) ?? '' })
  }
  const t = readTask(r.result)
  const o = STATE_OUTCOME[t.state]
  const view = { state: t.state, taskId: t.taskId ?? '', contextId: t.contextId ?? '', text: t.text, data: t.data, artifacts: t.artifacts }
  return {
    outcome: o, code: o === 'ok' ? 'OK' : `TASK_${t.state.toUpperCase()}`,
    output: o === 'ok' ? mapOutputs(run.response, run.outputs, view, run.choiceMaps ?? {}) : {},
    sentence: o === 'ok' ? (t.state === 'completed' ? sentenceFor('ok', label) : `${label} was accepted; the agent is still working on it.`) : sentenceFor(o, label),
    detail: '', sent: true, state: t.state, ...(t.taskId === undefined ? {} : { taskId: t.taskId }), ...(t.contextId === undefined ? {} : { contextId: t.contextId }),
  }
}

/** Read a task's current state (`tasks/get` / `GetTask`). */
export async function getAgentTask(card: AgentCardSummary, taskId: string, context: { readonly credential: (r: WireRequest) => Promise<ApplyResult>; readonly send: Send }): Promise<{ readonly ok: true; readonly state: AgentTaskState; readonly text: string } | { readonly ok: false; readonly code: string; readonly outcome: Outcome }> {
  const r = await rpc({ url: card.endpoint, method: METHODS[card.version].get, params: { id: taskId }, headers: card.version === '1.0' ? { 'a2a-version': '1.0' } : {}, credential: context.credential, send: context.send })
  if (!r.ok) return { ok: false, code: r.code, outcome: r.kind === 'refused' ? 'refused' : failureOutcome(r, []) }
  const t = readTask(r.result)
  return { ok: true, state: t.state, text: t.text }
}

/** Ask the agent to stop a task (`tasks/cancel` / `CancelTask`). */
export async function cancelAgentTask(card: AgentCardSummary, taskId: string, context: { readonly credential: (r: WireRequest) => Promise<ApplyResult>; readonly send: Send }): Promise<{ readonly ok: true; readonly state: AgentTaskState } | { readonly ok: false; readonly code: string; readonly outcome: Outcome }> {
  const r = await rpc({ url: card.endpoint, method: METHODS[card.version].cancel, params: { id: taskId }, headers: card.version === '1.0' ? { 'a2a-version': '1.0' } : {}, credential: context.credential, send: context.send })
  if (!r.ok) return { ok: false, code: r.code, outcome: r.kind === 'refused' ? 'refused' : failureOutcome(r, []) }
  return { ok: true, state: readTask(r.result).state }
}
