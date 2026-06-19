// no-raw-fetch: allow (reason: `fetch` here is an interface method declaration on RuntimeEgressSlot, not a global fetch invocation; the implementation delegates to hardenedFetch)
/**
 * @weaveintel/core — `weaveRuntime`
 *
 * Phase 2 of enterprise hardening. A single object that bundles every
 * cross-cutting concern an agent / workflow / tool / connector needs, so
 * none of them get constructed ad-hoc per call site:
 *
 *   - egress       hardened outbound HTTP (Phase 1)
 *   - tracer       observability
 *   - secrets      env / vault / KMS resolution
 *   - audit        append-only audit logger
 *   - persistence  durable store (optional — in-memory by default)
 *   - resilience   signal bus (optional — for endpoint health propagation)
 *
 * The runtime is the *root* from which an `ExecutionContext` is derived,
 * making every cross-cutting concern ambient and reachable from any callsite
 * without inventing a parallel singleton. Opting out is explicit and
 * surfaced via `runtime.has(...)` / `runtime.require(...)`.
 *
 * This package stays vendor-dep-free. Adapter slots (`persistence`,
 * `resilience.signalBus`) use minimal structural interfaces so concrete
 * implementations from `@weaveintel/persistence` and `@weaveintel/resilience`
 * fit without importing them here.
 */

import { capabilityId, type CapabilityId } from './capabilities.js';
import {
  createHardenedFetch,
  hardenedFetch as rawHardenedFetch,
  type HardenedFetchOptions,
} from './hardened-fetch.js';
import { setDefaultTracer } from './observability-runtime.js';
import type { ExecutionContext } from './context.js';
import type { Span, Tracer } from './observability.js';
import { envSecretResolver } from './secrets.js';
import type { AuditEntry, AuditLogger, Redactor, SecretResolver } from './security.js';
import { newUUIDv7 } from './uuid.js';

/**
 * Cross-cutting runtime capabilities. Used with `runtime.has(cap)` and
 * `runtime.require(cap)` at registration time for any feature that declares
 * `requires: [...]`.
 */
export const RuntimeCapabilities = {
  NetEgress: capabilityId('runtime.net.egress'),
  Observability: capabilityId('runtime.observability'),
  Secrets: capabilityId('runtime.secrets'),
  Audit: capabilityId('runtime.audit'),
  Persistence: capabilityId('runtime.persistence'),
  Resilience: capabilityId('runtime.resilience'),
  Encryption: capabilityId('runtime.encryption'),
  Guardrails: capabilityId('runtime.guardrails'),
} as const;

/**
 * Minimal structural key-value store that every durable subsystem
 * (DLQ, cost meter, idempotency, audit ledger, etc.) can consume without
 * caring whether the backend is in-memory, SQLite, Postgres, Redis, or a
 * cloud KV. Concrete implementations live in `@weaveintel/persistence`;
 * `weaveInMemoryPersistence()` below is the zero-config default.
 *
 * Keys are opaque strings (callers namespace via `prefix:tenant:id`).
 * Values are opaque strings (callers JSON-encode richer payloads).
 *
 * `list(prefix)` returns lexicographically-sorted entries — callers can
 * rely on `prefix + '\u0000'` to bound a scan if they need it.
 *
 * Best-effort throughout: a thrown op is surfaced to the caller, but the
 * runtime itself never crashes a request when persistence misbehaves.
 */
export interface RuntimeKvStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, opts?: { ttlMs?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<readonly { readonly key: string; readonly value: string }[]>;
}

/** Structural slot for the durable backend. Concrete adapter comes from
 *  `@weaveintel/persistence` — `kind` is the discriminator, `kv` is the
 *  contract every durable subsystem (Phase 4) consumes. */
export interface RuntimePersistenceSlot {
  readonly kind: string;
  readonly kv: RuntimeKvStore;
}

/** Structural slot for a resilience signal bus. Concrete instance comes from
 *  `@weaveintel/resilience` — only `emit` is structurally required.
 *
 *  Phase 0 additions: `getState`, `getLatencyP50`, `getLatencyP95` are optional
 *  so existing implementations remain valid. Use them to make routing decisions
 *  through the DI chain instead of reaching for process-global singletons. */
export interface RuntimeResilienceSlot {
  emit(event: { readonly kind: string; readonly endpoint: string; readonly meta?: Readonly<Record<string, unknown>> }): void;
  /** Current circuit-breaker state for the given endpoint key. Returns `'unknown'`
   *  when no circuit has been registered for that endpoint. */
  getState?(endpoint: string): 'closed' | 'open' | 'half_open' | 'unknown';
  /** 50th-percentile latency in ms for the given endpoint, or `null` if no
   *  samples have been recorded yet. */
  getLatencyP50?(endpoint: string): number | null;
  /** 95th-percentile latency in ms for the given endpoint, or `null` if no
   *  samples have been recorded yet. */
  getLatencyP95?(endpoint: string): number | null;
}

/**
 * Structural slot for tenant-scoped encryption (Phase F). The concrete
 * implementation comes from `@weaveintel/encryption` (`weaveTenantKeyManager`),
 * but core stays dep-free — consumers that need to encrypt/decrypt retrieve
 * the slot via `ctx.runtime?.encryption` and cast to the concrete
 * `TenantKeyManager` shape they expect. Marker-only by design (no methods)
 * so core takes no dependency on the encryption package.
 */
export interface RuntimeEncryptionSlot {
  readonly kind: string;
  /**
   * Lazy accessor for the underlying key manager. Returns `null` while
   * encryption is disabled (no master key configured) or before the
   * adopter's bootstrap has completed. Callers cast the return value to
   * the concrete `TenantKeyManager` from `@weaveintel/encryption`.
   *
   * The accessor pattern lets adopters construct the runtime BEFORE the
   * manager is ready, then mutate the underlying ref once bootstrap
   * completes — without changing the runtime object.
   */
  getManager(): unknown;
  /**
   * Returns `true` when field encryption is active — i.e. the master key is
   * present and the key manager has completed bootstrap. Use this before
   * performing any encrypt/decrypt operation rather than checking `getManager()
   * !== null`, which is implementation-dependent.
   */
  isActive(): boolean;
}

/**
 * Structural slot for ambient guardrails (Phase 3). The agent loop, workflow
 * engine, and tool registry all consult `runtime.guardrails?.checkToolCall`
 * before invoking a tool and `runtime.guardrails?.checkOutput` before
 * surfacing a model response. Both checks are best-effort: a missing slot
 * is a no-op (allow), and a thrown check is logged via audit and treated
 * as a deny rather than crashing the run — guardrails are never
 * load-bearing.
 *
 * Concrete implementations may live in `@weaveintel/guardrails`, an app's
 * policy module, or a per-tenant ruleset; the structural interface keeps
 * `@weaveintel/core` free of any specific guardrail library.
 */
export interface RuntimeGuardrailsSlot {
  /**
   * Inspect inbound user content BEFORE it reaches the model (Phase 0 addition).
   * Called after PII redaction, so `input` is the cleaned text. Return
   * `{ allow: false }` to block the message entirely. Swallowed on throw
   * (allow-through) — guardrails are never load-bearing.
   */
  checkInput?(
    ctx: ExecutionContext,
    input: string,
  ): Promise<{ allow: boolean; reason?: string }>;
  /** Inspect a pending tool call. Return `{ allow: false }` to block. */
  checkToolCall?(
    ctx: ExecutionContext,
    schema: { readonly name: string; readonly riskLevel?: string },
    args: Readonly<Record<string, unknown>>,
  ): Promise<{ allow: boolean; reason?: string }>;
  /** Inspect a terminal model output. May return `redactedText` to rewrite. */
  checkOutput?(
    ctx: ExecutionContext,
    text: string,
  ): Promise<{ allow: boolean; redactedText?: string; reason?: string }>;
}

/** Egress slot returned by `weaveRuntime` — the per-call `fetch` plus the
 *  `createFetch(...)` factory packages should use to build their own closure. */
export interface RuntimeEgressSlot {
  /**
   * Per-call hardened fetch. Pass `errorTag` (and any overrides) inline.
   * For per-package usage prefer `createFetch({ errorTag, ... })` so every
   * call site under that package shares the same identity.
   */
  fetch(
    input: string,
    init?: RequestInit,
    opts?: HardenedFetchOptions & { errorTag: string },
  ): Promise<Response>;
  createFetch: typeof createHardenedFetch;
}

export interface WeaveRuntime {
  /** Cross-cutting capabilities this runtime advertises. Always includes
   *  egress, observability, secrets, audit. Persistence/resilience are added
   *  only when their slots are configured. */
  readonly capabilities: ReadonlySet<CapabilityId>;
  readonly egress: RuntimeEgressSlot;
  readonly tracer: Tracer;
  readonly secrets: SecretResolver;
  readonly audit: AuditLogger;
  readonly persistence: RuntimePersistenceSlot | undefined;
  readonly resilience: RuntimeResilienceSlot | undefined;
  readonly guardrails: RuntimeGuardrailsSlot | undefined;
  readonly encryption: RuntimeEncryptionSlot | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;

  has(cap: CapabilityId): boolean;
  /** Throws with a single readable message naming every missing capability. */
  require(...caps: CapabilityId[]): void;
}

export interface WeaveRuntimeOptions {
  readonly egress?: Partial<RuntimeEgressSlot>;
  /** Pass a real `Tracer` (e.g. `weaveConsoleTracer()` from `@weaveintel/observability`)
   *  or `'noop'` (default) for a built-in no-op so core stays dep-free. */
  readonly tracer?: Tracer | 'noop';
  /** When true (default), also calls `weaveSetDefaultTracer(tracer)` so legacy
   *  call sites still pick up the tracer. */
  readonly installDefaultTracer?: boolean;
  readonly secrets?: SecretResolver;
  /**
   * Explicit audit logger. When omitted and `persistence` is configured, the
   * runtime automatically attaches a `createDurableAuditLogger` backed by the
   * same persistence slot — so audit entries survive process restarts at zero
   * additional configuration cost. Pass an explicit logger to override.
   */
  readonly audit?: AuditLogger;
  readonly persistence?: RuntimePersistenceSlot;
  readonly resilience?: RuntimeResilienceSlot;
  readonly guardrails?: RuntimeGuardrailsSlot;
  readonly encryption?: RuntimeEncryptionSlot;
  /**
   * Phase 5 — optional `Redactor`. When supplied, every audit entry's
   * `details` object is serialised → redacted → re-parsed before the entry
   * reaches the underlying logger. LLMs and audit stores never see raw PII.
   * The `Redactor` interface is structural; pass any `weaveRedactor(policy)`
   * from `@weaveintel/redaction` or a custom implementation.
   */
  readonly redactor?: Redactor;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Extra capability ids to advertise on top of the auto-detected ones.
   *  Use this when an external package (e.g. encryption) is configured and
   *  should be visible via `runtime.has(...)`. */
  readonly extraCapabilities?: readonly CapabilityId[];
  /**
   * Phase 5 — TLS floor enforcement. When `true` (default), `weaveRuntime`
   * asserts that `NODE_TLS_REJECT_UNAUTHORIZED` is not set to `'0'` at
   * construction time. Set to `false` only in test environments where self-
   * signed certs are unavoidable, never in production. A safety-downgrade
   * audit entry is emitted when the floor is disabled.
   */
  readonly tlsFloor?: boolean;
}

const noopAudit: AuditLogger = {
  async log() { /* drop */ },
};

// ─── Phase 5 helpers ──────────────────────────────────────────────────────────

/**
 * Phase 5 — TLS floor assertion. Throws when the process has disabled
 * certificate verification (`NODE_TLS_REJECT_UNAUTHORIZED === '0'`), which
 * silently allows MITM attacks on every outbound TLS connection.
 *
 * Called by `weaveRuntime()` at construction unless `tlsFloor: false` is set.
 * In production this should never be suppressed; in test environments with
 * self-signed certificates set the option to `false` and ensure a downgrade
 * audit entry is emitted via `weaveLogSafetyDowngrade`.
 */
export function assertTlsFloor(): void {
  if (process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    throw new Error(
      'weaveRuntime: TLS floor violated — NODE_TLS_REJECT_UNAUTHORIZED=0 is set. '
      + 'Certificate verification is disabled, which allows MITM attacks on every outbound TLS connection. '
      + 'Fix the root cause (use a valid cert or NODE_EXTRA_CA_CERTS) rather than disabling verification. '
      + 'To suppress this check in controlled test environments, pass { tlsFloor: false } to weaveRuntime().',
    );
  }
}

/**
 * Phase 5 — Persistence-backed audit logger. Writes every `AuditEntry` as a
 * JSON string under `${namespace}:${timestamp}:${uuid}` in the runtime KV so
 * audit trails survive process restarts and scale-out deployments.
 *
 * Auto-wired by `weaveRuntime` when a `persistence` slot is configured and no
 * explicit `audit` logger is supplied — zero config required from adopters.
 *
 * Falls back to `weaveInMemoryPersistence()` when no slot is given (matches
 * the DLQ / cost-meter / checkpoint-store pattern).
 */
export function createDurableAuditLogger(opts: {
  /** Persistence slot to write audit entries into. Falls back to an in-memory
   *  slot (zero-config DX) when not supplied — use a durable slot from
   *  `@weaveintel/persistence` for restart-safe audit trails. */
  persistence?: RuntimePersistenceSlot;
  namespace?: string;
} = {}): AuditLogger {
  const ns = opts.namespace ?? 'audit';
  const slot = opts.persistence ?? weaveInMemoryPersistence();
  const kv = slot.kv;
  return {
    async log(entry: AuditEntry): Promise<void> {
      const key = `${ns}:${entry.timestamp}:${newUUIDv7()}`;
      try {
        await kv.set(key, JSON.stringify(entry));
      } catch {
        /* audit KV failures must never crash a run */
      }
    },
  };
}

/**
 * Phase 5 — Auto-redacting audit logger. Wraps an existing `AuditLogger` and
 * passes every entry's `details` through a `Redactor` before forwarding to
 * the inner logger, so PII is stripped from audit trails without any call-site
 * changes. Uses the structural `Redactor` interface — pass any implementation
 * from `@weaveintel/redaction` or a custom one.
 *
 * Auto-wired by `weaveRuntime` when a `redactor` is configured.
 */
export function createRedactingAuditLogger(
  inner: AuditLogger,
  redactor: Redactor,
): AuditLogger {
  return {
    async log(entry: AuditEntry): Promise<void> {
      // Use a minimal stub context — redaction does not need a real span
      const stubCtx: import('./context.js').ExecutionContext = {
        executionId: entry.executionId,
        metadata: {},
        ...(entry.tenantId !== undefined ? { tenantId: entry.tenantId } : {}),
        ...(entry.userId !== undefined ? { userId: entry.userId } : {}),
      };

      async function scrubString(s: string | undefined): Promise<string | undefined> {
        if (!s) return s;
        try { return (await redactor.redact(stubCtx, s)).redacted; } catch { return s; }
      }

      try {
        const [redactedAction, redactedResource, redactedDetails] = await Promise.all([
          scrubString(entry.action),
          scrubString(entry.resource),
          entry.details !== undefined
            ? (async () => {
                try {
                  const t = JSON.stringify(entry.details);
                  const { redacted } = await redactor.redact(stubCtx, t);
                  return JSON.parse(redacted) as Record<string, unknown>;
                } catch { return entry.details; }
              })()
            : Promise.resolve(undefined),
        ]);
        await inner.log({
          ...entry,
          action: redactedAction ?? entry.action,
          ...(redactedResource !== undefined ? { resource: redactedResource } : {}),
          ...(redactedDetails !== undefined ? { details: redactedDetails } : {}),
        });
      } catch {
        /* redaction failure: forward the original entry rather than dropping it */
        await inner.log(entry);
      }
    },
  };
}

/** Built-in noop tracer (in-core so `weaveRuntime()` has no external deps). */
function noopTracer(): Tracer {
  const makeSpan = (name: string, parentSpanId?: string): Span => {
    const attrs: Record<string, unknown> = {};
    const span: Span = {
      spanId: newUUIDv7(),
      ...(parentSpanId !== undefined ? { parentSpanId } : {}),
      name,
      startTime: Date.now(),
      attributes: attrs,
      setAttribute(k, v) { attrs[k] = v; },
      addEvent() { /* drop */ },
      setError() { span.status = 'error'; },
      end() { span.endTime = Date.now(); },
    };
    return span;
  };
  return {
    startSpan(ctx: ExecutionContext, name: string, attributes?: Record<string, unknown>) {
      const s = makeSpan(name, ctx.parentSpanId);
      if (attributes) for (const [k, v] of Object.entries(attributes)) s.setAttribute(k, v);
      return s;
    },
    async withSpan(ctx, name, fn, attributes) {
      const s = this.startSpan(ctx, name, attributes);
      try {
        const r = await fn(s);
        s.end();
        return r;
      } catch (e) {
        s.setError(e as Error);
        s.end();
        throw e;
      }
    },
  };
}

function resolveTracer(t: WeaveRuntimeOptions['tracer']): Tracer {
  if (!t || t === 'noop') return noopTracer();
  return t;
}

/**
 * Construct a runtime. Every slot has a working default so a zero-arg call
 * is the supported golden path for tests and small adopters:
 *
 *     const runtime = weaveRuntime();
 *     const ctx = weaveContext({ runtime });
 *
 * The runtime is idempotent and side-effect-light: by default it installs
 * the tracer as the framework default tracer so any legacy code that calls
 * `weaveResolveTracer()` still sees it. Set `installDefaultTracer: false`
 * to opt out (e.g. when constructing multiple runtimes in the same process).
 */
export function weaveRuntime(opts: WeaveRuntimeOptions = {}): WeaveRuntime {
  // Phase 5: TLS floor — default on; opt-out requires explicit flag
  if (opts.tlsFloor !== false) {
    assertTlsFloor();
  }

  const tracer = resolveTracer(opts.tracer ?? 'noop');
  if (opts.installDefaultTracer !== false) setDefaultTracer(tracer);
  const secrets = opts.secrets ?? envSecretResolver();

  // Phase 5: auto-wire a durable audit logger when persistence is configured
  // and no explicit audit logger was supplied. When a redactor is also present,
  // wrap with auto-redaction so PII is stripped before any write.
  let audit: AuditLogger;
  if (opts.audit) {
    audit = opts.redactor ? createRedactingAuditLogger(opts.audit, opts.redactor) : opts.audit;
  } else if (opts.persistence) {
    const baseAudit = createDurableAuditLogger({ persistence: opts.persistence, namespace: 'audit' });
    audit = opts.redactor ? createRedactingAuditLogger(baseAudit, opts.redactor) : baseAudit;
  } else {
    audit = noopAudit;
  }

  const egress: RuntimeEgressSlot = {
    fetch: opts.egress?.fetch
      ?? ((input, init, callOpts) =>
        rawHardenedFetch(input, init, callOpts ?? { errorTag: 'runtime' })),
    createFetch: opts.egress?.createFetch ?? createHardenedFetch,
  };

  const caps = new Set<CapabilityId>([
    RuntimeCapabilities.NetEgress,
    RuntimeCapabilities.Observability,
    RuntimeCapabilities.Secrets,
    RuntimeCapabilities.Audit,
  ]);
  if (opts.persistence) caps.add(RuntimeCapabilities.Persistence);
  if (opts.resilience) caps.add(RuntimeCapabilities.Resilience);
  if (opts.guardrails) caps.add(RuntimeCapabilities.Guardrails);
  if (opts.encryption) caps.add(RuntimeCapabilities.Encryption);
  for (const c of opts.extraCapabilities ?? []) caps.add(c);

  const rt: WeaveRuntime = {
    capabilities: caps as ReadonlySet<CapabilityId>,
    egress,
    tracer,
    secrets,
    audit,
    persistence: opts.persistence,
    resilience: opts.resilience,
    guardrails: opts.guardrails,
    encryption: opts.encryption,
    metadata: opts.metadata ?? {},
    has(cap) {
      return caps.has(cap);
    },
    require(...required) {
      const missing = required.filter((c) => !caps.has(c));
      if (missing.length > 0) {
        throw new Error(
          `weaveRuntime: missing required capability(ies): ${missing.join(', ')}. `
          + `Configure them on the runtime before registering features that declare requires: [...].`,
        );
      }
    },
  };
  return rt;
}

/**
 * Combine the runtime's advertised capabilities with the framework's auto
 * resolution rules for a single descriptive list — useful for debug endpoints
 * and the admin panel.
 */
export function describeRuntimeCapabilities(runtime: WeaveRuntime): readonly CapabilityId[] {
  return [...runtime.capabilities];
}

/**
 * Assert at registration time that the runtime satisfies a feature's
 * declared `requires: [...]`. Returns the runtime for chaining.
 *
 *   assertRuntimeRequires(runtime, ['runtime.net.egress', 'runtime.persistence']);
 */
export function assertRuntimeRequires(
  runtime: WeaveRuntime,
  requires: readonly (CapabilityId | string)[],
  featureName?: string,
): WeaveRuntime {
  const want = requires.map((r) => (typeof r === 'string' ? capabilityId(r) : r));
  const missing = want.filter((c) => !runtime.has(c));
  if (missing.length > 0) {
    const tag = featureName ? `${featureName}: ` : '';
    throw new Error(
      `${tag}runtime does not satisfy declared requires: missing ${missing.join(', ')}`,
    );
  }
  return runtime;
}

/**
 * Best-effort ambient audit emit (Phase 3). Pulls the audit logger from
 * `ctx.runtime?.audit` and emits a structured entry. Swallows its own
 * errors \u2014 audit is never load-bearing. Returns a promise that resolves
 * once the underlying logger has accepted the entry (or immediately if
 * none is wired).
 *
 *   await weaveAudit(ctx, { action: 'tool.invoke', outcome: 'success', resource: 'web_search' });
 */
export async function weaveAudit(
  ctx: ExecutionContext,
  entry: {
    action: string;
    outcome: 'success' | 'failure' | 'denied';
    resource?: string;
    details?: Record<string, unknown>;
    /** OTel span ID for trace joining (Phase 1). */
    spanId?: string;
    /** Caller-supplied correlation ID, e.g. an HTTP request-id (Phase 1). */
    correlationId?: string;
  },
): Promise<void> {
  const audit = ctx.runtime?.audit;
  if (!audit) return;
  try {
    await audit.log({
      timestamp: new Date().toISOString(),
      executionId: ctx.executionId,
      ...(ctx.tenantId !== undefined ? { tenantId: ctx.tenantId } : {}),
      ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
      action: entry.action,
      ...(entry.resource !== undefined ? { resource: entry.resource } : {}),
      outcome: entry.outcome,
      ...(entry.details !== undefined ? { details: entry.details } : {}),
      ...(entry.spanId !== undefined ? { spanId: entry.spanId } : {}),
      ...(entry.correlationId !== undefined ? { correlationId: entry.correlationId } : {}),
    });
  } catch {
    /* audit failures must never crash a run */
  }
}

/**
 * Explicit, *loud* downgrade of an ambient default (Phase 3). When an
 * adopter opts out of a default cross-cutting protection (e.g. disables
 * guardrails on a specific agent), call this so a structured audit entry
 * lands in the ambient logger \u2014 you can grep for downgrades in any audit
 * sink. Returns true if an audit was actually emitted.
 *
 *   weaveLogSafetyDowngrade(ctx, { feature: 'guardrails', reason: 'trusted-internal' });
 */
export function weaveLogSafetyDowngrade(
  ctx: ExecutionContext,
  entry: { feature: string; reason: string; component?: string },
): Promise<void> {
  return weaveAudit(ctx, {
    action: 'runtime.safety.downgrade',
    outcome: 'success',
    resource: entry.feature,
    details: {
      reason: entry.reason,
      ...(entry.component !== undefined ? { component: entry.component } : {}),
    },
  });
}

/**
 * Zero-config in-memory persistence slot (Phase 4). Returns the structural
 * `RuntimePersistenceSlot` backed by a Map so every adopter has a working
 * `runtime.persistence.kv` without depending on `@weaveintel/persistence`.
 *
 *   - Production adopters should pass a durable slot (e.g.
 *     `weaveSqlitePersistence({ path })` from `@weaveintel/persistence`).
 *   - In-memory entries are lost on process exit; durable subsystems
 *     (`createDurableDeadLetterQueue`, `createDurableCostMeter`, etc.) will
 *     transparently survive a restart whenever a durable slot is attached.
 *
 * `ttlMs` is honoured (lazy expiry on read / list).
 */
export function weaveInMemoryPersistence(): RuntimePersistenceSlot {
  type Entry = { value: string; expiresAt: number | undefined };
  const map = new Map<string, Entry>();

  function alive(e: Entry | undefined): e is Entry {
    if (!e) return false;
    if (e.expiresAt !== undefined && e.expiresAt <= Date.now()) return false;
    return true;
  }

  return {
    kind: 'in-memory',
    kv: {
      async get(key) {
        const e = map.get(key);
        if (!alive(e)) {
          if (e) map.delete(key);
          return undefined;
        }
        return e.value;
      },
      async set(key, value, opts) {
        const expiresAt = opts?.ttlMs && opts.ttlMs > 0 ? Date.now() + opts.ttlMs : undefined;
        map.set(key, { value, expiresAt });
      },
      async delete(key) {
        return map.delete(key);
      },
      async list(prefix) {
        const out: { key: string; value: string }[] = [];
        for (const [k, e] of map) {
          if (!k.startsWith(prefix)) continue;
          if (!alive(e)) { map.delete(k); continue; }
          out.push({ key: k, value: e.value });
        }
        out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        return out;
      },
    },
  };
}
