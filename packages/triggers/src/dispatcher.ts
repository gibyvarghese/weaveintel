/**
 * @weaveintel/triggers — Phase 3 Unified Trigger Dispatcher
 *
 * DB-driven dispatch fabric that wires any source (cron, webhook, contract
 * emission, manual, in-process signal bus, …) to any target (start a
 * workflow run, tick a live agent, post to a mesh, emit a contract, call
 * an outbound webhook).
 *
 * The package owns:
 *   - Trigger contracts (`Trigger`, `TriggerSource`, `TriggerTarget`)
 *   - The dispatcher state machine (`TriggerDispatcher`)
 *   - SourceAdapter / TargetAdapter pluggable interfaces
 *   - In-memory store + tiny JSONLogic-lite filter + dotted-path mapper
 *   - Built-in source adapters: `manual`, `signal_bus`, `cron`
 *   - Built-in target adapter: `webhook_out`
 *
 * Apps own:
 *   - Persistence (DB-backed `TriggerStore` implementation)
 *   - Target adapters that need DB context: `workflow`, `agent_tick`,
 *     `mesh_message`, `contract` (apps inject the dispatch fn).
 *   - `db_change` source adapter (db-specific).
 *
 * This file ships in addition to the legacy
 * `EventTrigger`/`EventTriggerBase` API (which remains available); new
 * code should use this dispatcher path.
 */

// ─── Core kinds ──────────────────────────────────────────────────────────

export type TriggerSourceKind =
  | 'cron'
  | 'webhook'
  | 'filewatch'
  | 'mcp_event'
  | 'db_change'
  | 'contract_emitted'
  | 'workflow_event'
  | 'signal_bus'
  | 'manual';

export type TriggerTargetKind =
  | 'workflow'
  | 'agent_tick'
  | 'mesh_message'
  | 'contract'
  | 'webhook_out';

export interface TriggerSourceRef {
  kind: TriggerSourceKind;
  config: Record<string, unknown>;
}

export interface TriggerTargetRef {
  kind: TriggerTargetKind;
  config: Record<string, unknown>;
}

export interface Trigger {
  id: string;
  key: string;
  enabled: boolean;
  source: TriggerSourceRef;
  /**
   * Optional JSONLogic-lite filter expression evaluated against the
   * incoming `TriggerEvent.payload` (plus `meta`). When the expression
   * evaluates to `true` the trigger fires; otherwise the dispatch is
   * recorded with status `'filtered'`. See `evaluateFilter` for the
   * supported operators.
   */
  filter?: { expression: unknown };
  target: TriggerTargetRef;
  /**
   * Map of `targetInputPath -> sourcePath`. Source paths are dotted
   * lookups into `{ payload, meta }`. When omitted the full payload is
   * forwarded to the target as-is.
   */
  inputMap?: Record<string, string>;
  rateLimit?: { perMinute: number };
  metadata?: Record<string, unknown>;
}

export interface TriggerEvent {
  /** Source kind that produced this event. */
  sourceKind: TriggerSourceKind;
  /** Free-form structured payload (HTTP body, contract row, signal, …). */
  payload: Record<string, unknown>;
  /** Time the event was observed (ms since epoch). */
  observedAt: number;
  /** Optional source identifier (URL, signal name, etc.) for filter use. */
  sourceId?: string;
}

// ─── Adapter contracts ───────────────────────────────────────────────────

export interface SourceAdapter {
  readonly kind: TriggerSourceKind;
  /** Begin emitting events. The dispatcher subscribes once per process. */
  start(emit: (event: TriggerEvent) => Promise<void>): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface TargetDispatchMeta {
  triggerId: string;
  triggerKey: string;
  firedAt: number;
}

export interface TargetAdapter {
  readonly kind: TriggerTargetKind;
  dispatch(target: TriggerTargetRef, input: unknown, meta: TargetDispatchMeta): Promise<TargetDispatchResult>;
}

export interface TargetDispatchResult {
  /** Optional opaque ref (e.g. workflow run id, http response status). */
  ref?: string;
}

// ─── Persistence contract ────────────────────────────────────────────────

export interface TriggerStore {
  list(): Promise<Trigger[]>;
  get(id: string): Promise<Trigger | null>;
  getByKey(key: string): Promise<Trigger | null>;
  save(trigger: Trigger): Promise<void>;
  delete(id: string): Promise<void>;
  /** Append-only audit row writer. */
  recordInvocation(invocation: TriggerInvocation): Promise<void>;
  listInvocations(filter?: ListInvocationsFilter): Promise<TriggerInvocation[]>;
}

export type TriggerInvocationStatus =
  | 'dispatched'
  | 'filtered'
  | 'rate_limited'
  | 'disabled'
  | 'no_target_adapter'
  | 'error';

export interface TriggerInvocation {
  id: string;
  triggerId: string;
  firedAt: number;
  sourceKind: TriggerSourceKind;
  status: TriggerInvocationStatus;
  /** Optional opaque ref returned by the target (workflow run id, …). */
  targetRef?: string;
  errorMessage?: string;
  /** Truncated payload preview for the audit log. */
  sourceEvent?: Record<string, unknown>;
}

export interface ListInvocationsFilter {
  triggerId?: string;
  status?: TriggerInvocationStatus;
  limit?: number;
  offset?: number;
}

export class InMemoryTriggerStore implements TriggerStore {
  private rows = new Map<string, Trigger>();
  private invocations: TriggerInvocation[] = [];

  async list(): Promise<Trigger[]> { return [...this.rows.values()]; }
  async get(id: string): Promise<Trigger | null> { return this.rows.get(id) ?? null; }
  async getByKey(key: string): Promise<Trigger | null> {
    for (const r of this.rows.values()) if (r.key === key) return r;
    return null;
  }
  async save(trigger: Trigger): Promise<void> { this.rows.set(trigger.id, trigger); }
  async delete(id: string): Promise<void> { this.rows.delete(id); }
  async recordInvocation(invocation: TriggerInvocation): Promise<void> {
    this.invocations.push(invocation);
  }
  async listInvocations(filter?: ListInvocationsFilter): Promise<TriggerInvocation[]> {
    let out = [...this.invocations].sort((a, b) => b.firedAt - a.firedAt);
    if (filter?.triggerId) out = out.filter((i) => i.triggerId === filter.triggerId);
    if (filter?.status) out = out.filter((i) => i.status === filter.status);
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? out.length;
    return out.slice(offset, offset + limit);
  }
}

// ─── Filter expression (JSONLogic-lite) ──────────────────────────────────

/**
 * Tiny subset of JSONLogic for trigger filter expressions. Supports:
 *   - literals (strings, numbers, booleans, null)
 *   - { "var": "path.into.data" }
 *   - { "==": [a, b] } / "!=" / ">" / ">=" / "<" / "<="
 *   - { "and": [...] } / { "or": [...] } / { "!": x }
 *   - { "in": [needle, [haystack...]] } / { "in": [needle, "string"] }
 *
 * Returns a truthy/falsy value. Unknown operators evaluate to `false`
 * (fail-closed) so a malformed filter never silently fires the trigger.
 */
export function evaluateFilter(expression: unknown, data: Record<string, unknown>): boolean {
  return Boolean(evalNode(expression, data));
}

function evalNode(node: unknown, data: Record<string, unknown>): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => evalNode(n, data));
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return false;
  const op = keys[0]!;
  const args = obj[op];
  switch (op) {
    case 'var': {
      const path = typeof args === 'string' ? args : '';
      return readDotted(data, path);
    }
    case '==': { const [a, b] = pair(args, data); return a === b; }
    case '!=': { const [a, b] = pair(args, data); return a !== b; }
    case '>': { const [a, b] = pair(args, data); return num(a) > num(b); }
    case '>=': { const [a, b] = pair(args, data); return num(a) >= num(b); }
    case '<': { const [a, b] = pair(args, data); return num(a) < num(b); }
    case '<=': { const [a, b] = pair(args, data); return num(a) <= num(b); }
    case 'and': return list(args, data).every(Boolean);
    case 'or': return list(args, data).some(Boolean);
    case '!': return !evalNode(Array.isArray(args) ? args[0] : args, data);
    case 'in': {
      const [needle, haystack] = pair(args, data);
      if (typeof haystack === 'string') return haystack.includes(String(needle));
      if (Array.isArray(haystack)) return haystack.includes(needle as never);
      return false;
    }
    default:
      return false;
  }
}

function pair(args: unknown, data: Record<string, unknown>): [unknown, unknown] {
  if (!Array.isArray(args) || args.length < 2) return [undefined, undefined];
  return [evalNode(args[0], data), evalNode(args[1], data)];
}
function list(args: unknown, data: Record<string, unknown>): unknown[] {
  if (!Array.isArray(args)) return [];
  return args.map((a) => evalNode(a, data));
}
function num(x: unknown): number {
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : NaN;
}

// ─── Dotted path / inputMap projection ───────────────────────────────────

export function readDotted(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function writeDotted(target: Record<string, unknown>, path: string, value: unknown): void {
  if (!path) return;
  const parts = path.split('.');
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (next === undefined || next === null || typeof next !== 'object') {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export function projectInput(inputMap: Record<string, string> | undefined, data: Record<string, unknown>): unknown {
  if (!inputMap || Object.keys(inputMap).length === 0) return data['payload'] ?? data;
  const out: Record<string, unknown> = {};
  for (const [target, srcPath] of Object.entries(inputMap)) {
    writeDotted(out, target, readDotted(data, srcPath));
  }
  return out;
}

// ─── Built-in source adapters ────────────────────────────────────────────

/** Programmatic source — call `emit({...})` to fire a manual event. */
export class ManualSourceAdapter implements SourceAdapter {
  readonly kind: TriggerSourceKind = 'manual';
  private emitter: ((event: TriggerEvent) => Promise<void>) | null = null;
  start(emit: (event: TriggerEvent) => Promise<void>): void { this.emitter = emit; }
  stop(): void { this.emitter = null; }
  async emit(payload: Record<string, unknown>, sourceId?: string): Promise<void> {
    if (!this.emitter) return;
    const event: TriggerEvent = {
      sourceKind: this.kind,
      payload,
      observedAt: Date.now(),
      ...(sourceId !== undefined ? { sourceId } : {}),
    };
    await this.emitter(event);
  }
}

/** In-process bus source — wraps any EventEmitter-shaped object. */
export interface MinimalEventBus {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

export class SignalBusSourceAdapter implements SourceAdapter {
  readonly kind: TriggerSourceKind = 'signal_bus';
  private listener: ((...args: unknown[]) => void) | null = null;
  constructor(private bus: MinimalEventBus, private eventName: string = 'signal') {}
  start(emit: (event: TriggerEvent) => Promise<void>): void {
    this.listener = (...args: unknown[]) => {
      const [first] = args;
      const payload =
        first && typeof first === 'object' && !Array.isArray(first)
          ? (first as Record<string, unknown>)
          : { value: first };
      void emit({ sourceKind: this.kind, payload, observedAt: Date.now(), sourceId: this.eventName });
    };
    this.bus.on(this.eventName, this.listener);
  }
  stop(): void {
    if (this.listener) { this.bus.off(this.eventName, this.listener); this.listener = null; }
  }
}

/**
 * Mesh contract source — bridges `ContractEmitter` emissions (from
 * `@weaveintel/workflows`) onto the trigger dispatcher as
 * `sourceKind: 'contract_emitted'` events.
 *
 * Wire by passing a Node `EventEmitter` (or any `MinimalEventBus`) that
 * the app's `DbContractEmitter` writes to after persisting the contract.
 * The payload shape mirrors `EmittedContract`:
 *   `{ kind, body, evidence?, meta: { workflowDefinitionId, workflowRunId, meshId?, emittedAt }, contractId? }`
 *
 * Use `filter.expression` on the trigger row to scope by contract `kind`,
 * mesh, or body fields.
 */
export class MeshContractSourceAdapter implements SourceAdapter {
  readonly kind: TriggerSourceKind = 'contract_emitted';
  private listener: ((...args: unknown[]) => void) | null = null;
  constructor(private bus: MinimalEventBus, private eventName: string = 'contract_emitted') {}
  start(emit: (event: TriggerEvent) => Promise<void>): void {
    this.listener = (...args: unknown[]) => {
      const [first] = args;
      const payload =
        first && typeof first === 'object' && !Array.isArray(first)
          ? (first as Record<string, unknown>)
          : { value: first };
      const sourceId =
        typeof (payload as Record<string, unknown>)['kind'] === 'string'
          ? ((payload as Record<string, unknown>)['kind'] as string)
          : this.eventName;
      void emit({ sourceKind: this.kind, payload, observedAt: Date.now(), sourceId });
    };
    this.bus.on(this.eventName, this.listener);
  }
  stop(): void {
    if (this.listener) { this.bus.off(this.eventName, this.listener); this.listener = null; }
  }
}

/** Cron source — fires a payload `{ scheduledAt }` every N ms. */
export class CronSourceAdapter implements SourceAdapter {
  readonly kind: TriggerSourceKind = 'cron';
  private timer: ReturnType<typeof setInterval> | null = null;
  /** intervalMs MUST be > 0. The dispatcher passes a per-trigger config
   *  by registering one CronSourceAdapter per cron trigger — the
   *  `start()` loop fires one bus event per tick that the dispatcher
   *  routes back through itself. */
  constructor(private intervalMs: number, private cronExpression?: string) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`CronSourceAdapter requires positive intervalMs (got ${intervalMs})`);
    }
  }
  start(emit: (event: TriggerEvent) => Promise<void>): void {
    this.timer = setInterval(() => {
      const payload: Record<string, unknown> = { scheduledAt: Date.now() };
      if (this.cronExpression) payload['cronExpression'] = this.cronExpression;
      void emit({ sourceKind: this.kind, payload, observedAt: Date.now() });
    }, this.intervalMs);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

// ─── Built-in target adapter: webhook_out ────────────────────────────────

export interface WebhookOutTargetOptions {
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

/** Calls an outbound HTTP endpoint defined by `target.config.url`. */
export class WebhookOutTargetAdapter implements TargetAdapter {
  readonly kind: TriggerTargetKind = 'webhook_out';
  private fetchImpl: typeof fetch;
  private defaultTimeoutMs: number;
  constructor(opts: WebhookOutTargetOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
  }
  async dispatch(target: TriggerTargetRef, input: unknown, _meta: TargetDispatchMeta): Promise<TargetDispatchResult> {
    const url = typeof target.config['url'] === 'string' ? (target.config['url'] as string) : '';
    if (!url) throw new Error('webhook_out target requires config.url');
    const method = typeof target.config['method'] === 'string' ? (target.config['method'] as string) : 'POST';
    const headers = (target.config['headers'] as Record<string, string> | undefined) ?? {};
    const timeoutMs = typeof target.config['timeoutMs'] === 'number' ? (target.config['timeoutMs'] as number) : this.defaultTimeoutMs;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(input),
        signal: ac.signal,
      });
      return { ref: `http:${res.status}` };
    } finally {
      clearTimeout(t);
    }
  }
}

// ─── Generic callback target (apps inject DB-aware dispatchers) ──────────

export type DispatchCallback = (target: TriggerTargetRef, input: unknown, meta: TargetDispatchMeta) => Promise<TargetDispatchResult | void>;

export class CallbackTargetAdapter implements TargetAdapter {
  constructor(public readonly kind: TriggerTargetKind, private cb: DispatchCallback) {}
  async dispatch(target: TriggerTargetRef, input: unknown, meta: TargetDispatchMeta): Promise<TargetDispatchResult> {
    const out = await this.cb(target, input, meta);
    return out ?? {};
  }
}

// ─── Rate limiter (per-trigger 1-min tumbling window, in-process) ────────

class RateLimiter {
  private windows = new Map<string, { startedAt: number; count: number }>();
  /** Returns true if dispatch is allowed; false if over budget. */
  check(triggerId: string, perMinute: number): boolean {
    if (!Number.isFinite(perMinute) || perMinute <= 0) return true;
    const now = Date.now();
    const cur = this.windows.get(triggerId);
    if (!cur || now - cur.startedAt >= 60_000) {
      this.windows.set(triggerId, { startedAt: now, count: 1 });
      return true;
    }
    if (cur.count >= perMinute) return false;
    cur.count += 1;
    return true;
  }
}

// ─── Dispatcher ──────────────────────────────────────────────────────────

export interface TriggerDispatcherOptions {
  store: TriggerStore;
  /** Source adapters wired by source kind. The dispatcher subscribes
   *  to each adapter at `start()` time. Cron triggers do NOT use a
   *  shared adapter — the dispatcher constructs one CronSourceAdapter
   *  per cron-source trigger in `start()`. */
  sourceAdapters?: SourceAdapter[];
  /** Target adapters wired by target kind. */
  targetAdapters: TargetAdapter[];
  /** Optional id generator for invocation rows. Defaults to crypto.randomUUID. */
  newId?: () => string;
  /** Optional logger; defaults to console.warn for failures. */
  logger?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

export interface TriggerDispatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Manually inject an event without going through a SourceAdapter.
   *  Useful for webhook handlers and tests. */
  dispatch(event: TriggerEvent, opts?: { onlyTriggerId?: string }): Promise<TriggerInvocation[]>;
  /** Reload trigger definitions from the store (e.g. after admin edit). */
  reload(): Promise<void>;
}

export function createTriggerDispatcher(opts: TriggerDispatcherOptions): TriggerDispatcher {
  const store = opts.store;
  const sourceAdapters = new Map<TriggerSourceKind, SourceAdapter>();
  for (const a of opts.sourceAdapters ?? []) sourceAdapters.set(a.kind, a);
  const targetAdapters = new Map<TriggerTargetKind, TargetAdapter>();
  for (const a of opts.targetAdapters) targetAdapters.set(a.kind, a);
  const newId = opts.newId ?? ((): string => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `trg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  });
  const logger = opts.logger ?? { warn: (...a: unknown[]) => console.warn('[triggers]', ...a) };
  const limiter = new RateLimiter();
  let triggers: Trigger[] = [];
  const cronAdapters: CronSourceAdapter[] = [];
  let started = false;

  async function reload(): Promise<void> {
    triggers = await store.list();
  }

  async function emit(event: TriggerEvent): Promise<void> {
    await dispatch(event);
  }

  async function dispatch(event: TriggerEvent, runOpts?: { onlyTriggerId?: string }): Promise<TriggerInvocation[]> {
    const out: TriggerInvocation[] = [];
    const candidates = triggers.filter((t) => t.source.kind === event.sourceKind && (!runOpts?.onlyTriggerId || t.id === runOpts.onlyTriggerId));
    for (const trg of candidates) {
      const inv = await dispatchOne(trg, event);
      out.push(inv);
    }
    return out;
  }

  async function dispatchOne(trg: Trigger, event: TriggerEvent): Promise<TriggerInvocation> {
    const firedAt = Date.now();
    const meta: TargetDispatchMeta = { triggerId: trg.id, triggerKey: trg.key, firedAt };
    const sourceEvent = truncatePreview(event.payload);
    const baseInv: TriggerInvocation = {
      id: newId(),
      triggerId: trg.id,
      firedAt,
      sourceKind: event.sourceKind,
      status: 'dispatched',
      ...(sourceEvent !== undefined ? { sourceEvent } : {}),
    };
    if (!trg.enabled) return record({ ...baseInv, status: 'disabled' });
    if (trg.filter?.expression !== undefined) {
      const ok = evaluateFilter(trg.filter.expression, { payload: event.payload, meta: { sourceId: event.sourceId, observedAt: event.observedAt } });
      if (!ok) return record({ ...baseInv, status: 'filtered' });
    }
    if (trg.rateLimit && !limiter.check(trg.id, trg.rateLimit.perMinute)) {
      return record({ ...baseInv, status: 'rate_limited' });
    }
    const adapter = targetAdapters.get(trg.target.kind);
    if (!adapter) return record({ ...baseInv, status: 'no_target_adapter', errorMessage: `no adapter for target kind '${trg.target.kind}'` });
    const input = projectInput(trg.inputMap, { payload: event.payload, meta: { sourceId: event.sourceId, observedAt: event.observedAt } });
    try {
      const result = await adapter.dispatch(trg.target, input, meta);
      return record({ ...baseInv, status: 'dispatched', ...(result.ref !== undefined ? { targetRef: result.ref } : {}) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`trigger ${trg.key} dispatch failed:`, msg);
      return record({ ...baseInv, status: 'error', errorMessage: msg });
    }
  }

  async function record(inv: TriggerInvocation): Promise<TriggerInvocation> {
    try { await store.recordInvocation(inv); } catch (err) { logger.warn('failed to record invocation:', err); }
    return inv;
  }

  async function start(): Promise<void> {
    if (started) return;
    await reload();
    for (const adapter of sourceAdapters.values()) {
      try { await adapter.start(emit); } catch (err) { logger.warn(`source adapter ${adapter.kind} failed to start:`, err); }
    }
    // Per-trigger cron adapters
    for (const trg of triggers) {
      if (trg.source.kind !== 'cron' || !trg.enabled) continue;
      const intervalMs = readCronIntervalMs(trg.source.config);
      if (!intervalMs) continue;
      const cronExpression = typeof trg.source.config['expression'] === 'string'
        ? (trg.source.config['expression'] as string)
        : undefined;
      const adapter = new CronSourceAdapter(intervalMs, cronExpression);
      const triggerId = trg.id;
      adapter.start((ev) => dispatch({ ...ev, sourceId: trg.key }, { onlyTriggerId: triggerId }).then(() => undefined));
      cronAdapters.push(adapter);
    }
    started = true;
  }

  async function stop(): Promise<void> {
    if (!started) return;
    for (const a of sourceAdapters.values()) {
      try { await a.stop(); } catch { /* ignore */ }
    }
    for (const a of cronAdapters) { try { a.stop(); } catch { /* ignore */ } }
    cronAdapters.length = 0;
    started = false;
  }

  return { start, stop, dispatch: (e, o) => dispatch(e, o), reload };
}

function truncatePreview(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const json = JSON.stringify(payload);
    if (json.length <= 4096) return payload;
    return { _truncated: true, preview: json.slice(0, 4096) };
  } catch {
    return { _serialization_error: true };
  }
}

/**
 * Parse the cron source config. Supports two shapes:
 *   { intervalMs: number }                          ← preferred
 *   { expression: 'STAR/N STAR STAR STAR STAR' }     ← classic cron-ish
 *
 * The expression parser accepts the common 'STAR/N' first-field shorthand
 * (5-field minute granularity, 6-field second granularity) and falls
 * back to 60_000 ms otherwise — same behaviour as the legacy
 * CronTrigger. Apps that need full cron semantics should pre-compute
 * intervalMs and store it directly.
 */
export function readCronIntervalMs(config: Record<string, unknown>): number | null {
  const direct = config['intervalMs'];
  if (typeof direct === 'number' && direct > 0 && Number.isFinite(direct)) return direct;
  const expr = config['expression'];
  if (typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  const first = parts[0] ?? '';
  const m = /^\*\/(\d+)$/.exec(first);
  if (m) {
    const n = parseInt(m[1]!, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return parts.length >= 6 ? n * 1000 : n * 60_000;
  }
  return 60_000;
}
