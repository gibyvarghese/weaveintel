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
import type { ModelHealth } from './routing.js';
import type { SemanticMemory, WorkingMemory, MemoryStore } from './memory.js';
import type { IdentityContext, DelegationContext, AccessDecision, PermissionDescriptor } from './identity.js';
import type { CacheStore, SemanticCache } from './cache.js';

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
  Routing: capabilityId('runtime.routing'),
  Cost: capabilityId('runtime.cost'),
  Memory: capabilityId('runtime.memory'),
  Compliance: capabilityId('runtime.compliance'),
  Identity: capabilityId('runtime.identity'),
  Cache: capabilityId('runtime.cache'),
} as const;

/**
 * Structural slot for aggregated compliance management (Phase 6).
 *
 * Bundles all GDPR / data-governance primitives into a single ambient slot
 * so every call site can reach them through `ctx.runtime?.compliance` without
 * constructing per-route or per-chat manager instances.
 *
 * Concrete adapters live in `@weaveintel/compliance`;
 * `createRuntimeComplianceAdapter(opts)` builds one from the durable managers.
 *
 * `consent`   — grant / revoke / query per-user consent flags.
 * `residency` — data-flow compliance (which regions are allowed).
 * `deletion`  — GDPR Art. 17 right-to-delete lifecycle.
 * `isAllowed` — convenience consent check (most common call site).
 * `canProcess` — convenience residency check.
 * `requestErasure` — convenience GDPR erasure trigger.
 * `requestExport`  — convenience GDPR export trigger.
 */
export interface RuntimeComplianceSlot {
  /** Consent manager — grant / revoke / query per-user consent flags. */
  readonly consent: {
    isGranted(subjectId: string, purpose: string): Promise<boolean>;
    grant(subjectId: string, purpose: string, source: string, expiresAt?: number): Promise<unknown>;
    revoke(subjectId: string, purpose: string): Promise<boolean>;
    listBySubject(subjectId: string): Promise<readonly unknown[]>;
  };
  /** Residency engine — validate data-flow compliance. */
  readonly residency: {
    isAllowed(dataCategory: string, targetRegion: string): Promise<boolean>;
    getAllowedRegions(dataCategory: string): Promise<readonly string[]>;
  };
  /** Deletion manager — GDPR Art. 17 right-to-delete lifecycle. */
  readonly deletion: {
    create(subjectId: string, requestedBy: string, reason: string, dataCategories: string[]): Promise<{ id: string; status: string }>;
    process(id: string): Promise<unknown>;
    complete(id: string): Promise<unknown>;
    fail(id: string, reason: string): Promise<unknown>;
  };
  /** Audit-export manager — GDPR Art. 20 data portability. */
  readonly auditExport: {
    create(tenantId: string, requestedBy: string, format: string, categories: string[], fromDate: number, toDate: number): Promise<{ id: string; status: string; format: string }>;
    markReady(id: string, recordCount: number, sizeBytes: number): Promise<unknown>;
    markFailed(id: string): Promise<unknown>;
  };
  /**
   * Convenience: check if userId has granted consent for the given purpose.
   * Prefer this over `consent.isGranted` at call sites that don't need the
   * full manager; it is swallowed on error and returns `true` (permit-if-no-record).
   */
  isAllowed(userId: string, purpose: string): Promise<boolean>;
  /**
   * Convenience: check whether data for `dataCategory` can flow to `targetRegion`.
   * Returns `true` when no residency constraint matches (fail-open by default;
   * set `COMPLIANCE_RESIDENCY_DEFAULT_DENY=true` for regulated environments).
   */
  canProcess(tenantId: string, dataCategory: string, targetRegion: string): Promise<boolean>;
  /**
   * Initiate a GDPR Art. 17 erasure request for `userId`.
   * Returns a minimal { id, status } handle so callers can track the request.
   */
  requestErasure(
    userId: string,
    requestedBy?: string,
    reason?: string,
    dataCategories?: string[],
  ): Promise<{ id: string; status: string; dataCategories: readonly string[] }>;
  /**
   * Initiate a GDPR Art. 20 data export for `userId`.
   * Returns a minimal { id, status, format } handle.
   */
  requestExport(
    userId: string,
    tenantId: string,
    format?: string,
  ): Promise<{ id: string; status: string; format: string }>;
}

/**
 * Structural slot for typed identity evaluation (Phase 6).
 *
 * Surfaces the `@weaveintel/identity` RBAC engine through the DI chain so
 * auth middleware, tool guards, and live-agent handlers can evaluate access
 * decisions without importing the identity package directly.
 *
 * `resolve`            — build a typed `IdentityContext` from raw user ids.
 * `evaluate`           — evaluate a resource + action against the RBAC policy.
 * `validateDelegation` — check a delegation chain for cycles and expiry.
 */
export interface RuntimeIdentitySlot {
  /**
   * Build a typed `IdentityContext` from a userId and optional tenantId.
   * Assigns effective permissions based on the configured RBAC policy and
   * any caller-supplied role overrides.
   */
  resolve(
    userId: string,
    tenantId: string | null,
    opts?: { roles?: string[]; scopes?: string[]; persona?: string },
  ): IdentityContext;
  /**
   * Evaluate whether the identity has permission for `resource` + `action`.
   * Returns a structured `AccessDecision` — never throws; callers must check
   * `.result === 'allow'` before proceeding.
   */
  evaluate(
    ctx: IdentityContext,
    resource: string,
    action: string,
    conditions?: Record<string, unknown>,
  ): AccessDecision;
  /**
   * Validate a delegation chain for cycles, expiry, and scope validity.
   * Returns `{ valid: true }` or `{ valid: false, reason }`.
   */
  validateDelegation(delegation: DelegationContext): { valid: boolean; reason?: string };
}

/**
 * Structural slot for shared response caching (Phase 7).
 *
 * A single shared `CacheStore` wired via `weaveRuntime` so the chat path,
 * live-agent handlers, and tools all share the same cache without each
 * constructing a private `weaveInMemoryCacheStore()` instance. In-process
 * caches from different subsystems never benefit each other; sharing through
 * the DI chain means a warm response in the chat path can serve a live-agent
 * tool that asks the same question in the same process.
 *
 * `get` / `set` / `invalidate` mirror the `CacheStore` interface with the
 * minimal surface that call sites need. The raw `store` accessor is provided
 * for consumers that need the full `CacheStore` API (e.g. `has`, `clear`).
 *
 * `semanticGet` is optional — present only when a `SemanticCache` is wired.
 * It returns a cached response for the most semantically-similar past query
 * above `threshold`; useful for deduplicating near-identical LLM calls.
 *
 * Concrete adapter: `createRuntimeCacheAdapter(store, semanticCache?)` from
 * `@weaveintel/cache`.
 */
export interface RuntimeCacheSlot {
  /** Retrieve a cached value by exact key. Returns `null` on miss or expiry. */
  get(key: string): Promise<unknown>;
  /** Store a value under `key` with an optional TTL in milliseconds. */
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  /** Delete a single cache entry by key. */
  invalidate(key: string): Promise<void>;
  /**
   * Semantic similarity lookup. When a `SemanticCache` is wired, returns the
   * cached response whose stored query embedding is within `threshold` cosine
   * similarity of `embedding`. Returns `null` when no match exceeds the
   * threshold or when no semantic cache is configured.
   */
  semanticGet?(embedding: number[], threshold?: number): Promise<unknown>;
  /** Raw `CacheStore` for consumers that need the full API (`has`, `clear`, `size`). */
  readonly store: CacheStore;
  /** Raw `SemanticCache` for consumers that need `store` / `invalidate` control. */
  readonly semanticStore?: SemanticCache;
}

/**
 * Structural slot for cross-cutting agent memory (Phase 5).
 *
 * A single shared slot that every agent, tool, and live-agent handler can
 * access via `ctx.runtime?.memory` without instantiating private memory
 * objects per call site. Concrete adapters live in `@weaveintel/memory`;
 * `createRuntimeMemoryAdapter(opts)` builds one from any `MemoryStore`
 * backend (SQLite, pgvector, Postgres, Redis, …).
 *
 * `semantic`  — embedding-based vector recall. Requires an embedding model.
 * `working`   — per-agent scratch state (patch / checkpoint / restore).
 * `store`     — raw `MemoryStore` for lower-level multi-type queries (useful
 *               for `fusedMemorySearch` across semantic + episodic + entity).
 * `consolidate` — trigger the cold-path pipeline that distils episodic entries
 *               into durable semantic facts for a given user.
 */
export interface RuntimeMemorySlot {
  readonly semantic: SemanticMemory;
  readonly working: WorkingMemory;
  readonly store: MemoryStore;
  consolidate(userId: string): Promise<void>;
}

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

/**
 * Structural slot for shared model-health tracking (Phase 2 — Shared Routing Slot).
 *
 * A single shared `ModelHealthTracker` is wired via `weaveRuntime` so the
 * chat path and the live-agent supervisor both observe and react to the same
 * real-time health state. Outcomes recorded from one subsystem are immediately
 * visible to routing in the other — no more per-instance tracker drift.
 *
 * Concrete implementation: `@weaveintel/routing` `createRuntimeRoutingAdapter(tracker)`.
 */
export interface RuntimeRoutingSlot {
  /** Record the latency and success/failure of one model call for health tracking. */
  recordOutcome(modelId: string, providerId: string, latencyMs: number, success: boolean): void;
  /** Block an entire provider for a window (rate-limit or degradation events). */
  blockProvider(providerId: string, durationMs?: number): void;
  /** Return the current health snapshot for all tracked model+provider pairs. */
  listHealth(): ModelHealth[];
  /** Return the set of providers currently under an active (un-expired) block. */
  getBlockedProviders(): Set<string>;
  /**
   * Phase 7 — Multi-modal capability check. Returns `true` when at least one
   * healthy model in the routing pool supports vision / image input. Call this
   * before routing an `ImageContent` or `AudioContent` part so handlers can
   * skip or warn rather than fail silently.
   */
  supportsMultiModal?(): boolean;
}

/**
 * Structural slot for per-user/tenant budget enforcement (Phase 3 — Shared Cost Slot).
 *
 * A single shared cost ledger is wired via `weaveRuntime` so the chat path and
 * the live-agent supervisor both check and record against the same runtime
 * spend counter. This prevents a user from exhausting their budget via one
 * surface while the other surface remains unaware.
 *
 * Concrete implementation: `@weaveintel/cost-governor` `createRuntimeCostAdapter(opts)`.
 */
export interface RuntimeCostSlot {
  /**
   * Pre-flight budget check. Returns `{ allowed: false, reason }` when the
   * entity (user or tenant) has exceeded their spending limit. Fail-open:
   * a thrown check is treated as `{ allowed: true }` — cost gates are
   * never load-bearing.
   */
  gate(opts: {
    userId: string;
    tenantId: string | null;
    estimatedCostUsd?: number;
  }): Promise<{ allowed: boolean; reason?: string }>;

  /**
   * Append an observed model cost to the running ledger. Best-effort —
   * KV write failures are swallowed and never crash the hot path.
   */
  record(opts: {
    userId: string;
    tenantId: string | null;
    model: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  }): Promise<void>;

  /**
   * Return the current spend and limit for the given entity id.
   * `period` describes the accumulation window (e.g. `'lifetime'`, `'30d'`).
   */
  getBudgetStatus(entityId: string): Promise<{
    used: number;
    limit: number | null;
    period: string;
  }>;
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
  readonly routing: RuntimeRoutingSlot | undefined;
  readonly cost: RuntimeCostSlot | undefined;
  readonly memory: RuntimeMemorySlot | undefined;
  readonly compliance: RuntimeComplianceSlot | undefined;
  readonly identity: RuntimeIdentitySlot | undefined;
  readonly cache: RuntimeCacheSlot | undefined;
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
  readonly routing?: RuntimeRoutingSlot;
  readonly cost?: RuntimeCostSlot;
  /**
   * Phase 5 — unified memory slot (semantic, working, store, consolidate).
   * Pass a `createRuntimeMemoryAdapter(opts)` instance from `@weaveintel/memory`.
   * When present, `RuntimeCapabilities.Memory` is advertised automatically.
   */
  readonly memory?: RuntimeMemorySlot;
  /**
   * Phase 6 — compliance slot (consent, residency, deletion, GDPR helpers).
   * Pass a `createRuntimeComplianceAdapter(opts)` instance from `@weaveintel/compliance`.
   * When present, `RuntimeCapabilities.Compliance` is advertised automatically.
   */
  readonly compliance?: RuntimeComplianceSlot;
  /**
   * Phase 6 — identity slot (resolve, evaluate, validateDelegation).
   * Pass a `createRuntimeIdentityAdapter(opts)` instance from `@weaveintel/identity`.
   * When present, `RuntimeCapabilities.Identity` is advertised automatically.
   */
  readonly identity?: RuntimeIdentitySlot;
  /**
   * Phase 7 — shared response cache (get, set, invalidate, optional semanticGet).
   * Pass a `createRuntimeCacheAdapter(store, semanticCache?)` instance from
   * `@weaveintel/cache`. When present, `RuntimeCapabilities.Cache` is advertised
   * automatically. Wiring a shared cache here means chat, live-agents, and tools
   * all benefit from the same warm cache within the same process.
   */
  readonly cache?: RuntimeCacheSlot;
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
  if (opts.routing) caps.add(RuntimeCapabilities.Routing);
  if (opts.cost) caps.add(RuntimeCapabilities.Cost);
  if (opts.memory) caps.add(RuntimeCapabilities.Memory);
  if (opts.compliance) caps.add(RuntimeCapabilities.Compliance);
  if (opts.identity) caps.add(RuntimeCapabilities.Identity);
  if (opts.cache) caps.add(RuntimeCapabilities.Cache);
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
    routing: opts.routing,
    cost: opts.cost,
    memory: opts.memory,
    compliance: opts.compliance,
    identity: opts.identity,
    cache: opts.cache,
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
