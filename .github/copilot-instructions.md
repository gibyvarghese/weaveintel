# Copilot Instructions

## How to use this file

This file is **permanent law**. Everything here applies to *every* new change unless a
rule explicitly says it is superseded. It is intentionally free of build narrative.

- **Forward-looking rules** (how to build) live here.
- **Build history** (what was built, phase-by-phase, with assertion counts and debug
  notes) lives in [`docs/PHASE_LOG.md`](docs/PHASE_LOG.md). Do not add "Phase N complete"
  sections to this file.
- **Durable contract facts** (table names, type names, route paths, hard invariants) are
  condensed in the [Contract Reference](#contract-reference) at the bottom. When a phase
  supersedes an earlier one, fold the durable facts forward here and drop the narrative
  from the log.

When the two ever conflict, this file wins.

---

## Definition of Done (read before writing any new capability)

A new capability is not done until **all** of these hold. This is the single answer to
"what must I consider when building new code."

1. **One change set, end-to-end.** A DB-backed capability lands schema + adapter + admin
   CRUD + runtime resolution in the *same* change. Never ship a schema without its
   adapter, or an adapter without its runtime consumer.
2. **DB-driven, not hardcoded.** Behaviour lives in database rows (catalogs, policies,
   strategies, recipes), never in app-only conditionals. Selection comes from metadata +
   admin-managed records.
3. **Shared package first.** Implement reusable logic in the owning shared package and
   keep apps (esp. GeneWeave) as consumers. Extend existing capability slots; never
   duplicate. See [Reusability & Package Boundaries](#reusability--package-boundaries).
4. **Model-facing descriptions preserved.** Any prompt, skill, tool, agent, workflow
   handler, or capability record that an LLM can discover or route on carries an explicit,
   structured, model-facing description — never a generic label.
5. **Observability + eval hooks wired by default.** Emit the shared trace shape; do not
   create app-only telemetry paths.
6. **Reusability invariant respected.** The package imports only its declared
   dependencies. No DB types, no app types, no `fetch`, no host imports leak into a
   reusable package.
7. **Graceful by construction.** New cross-cutting machinery is *never load-bearing* — see
   [Graceful Degradation](#graceful-degradation). Failures degrade to a safe default, they
   do not crash a request or a tick.
8. **Idempotency on writes.** Every POST route that creates or modifies state uses an
   `Idempotency-Key` header via `@weaveintel/reliability`.
9. **The test quartet.** Ship: package unit tests, a GeneWeave DB-level test, a canonical
   `examples/NN-*.ts` (in-process, no DB / no LLM / no external services), and a
   `scripts/e2e-*.mjs` verified against a running server.
10. **Examples and docs updated** so end-to-end usage stays discoverable.

---

## Architecture Priorities

- Prefer reusable package-level capabilities over app-local implementations when a feature
  belongs to the shared platform.
- **Every adopter constructs exactly one `weaveRuntime` at boot, and every
  `ExecutionContext` is derived from it.** Egress, tracer, secrets, audit, persistence,
  and resilience are pulled from `ctx.runtime?.…` — never reconstructed per call site
  and never read from process-wide singletons when a runtime is reachable. See
  [Hardening Phase 2](#hardening-phase-2-complete--ambient-cross-cutting-concerns-via-weaveruntime).
- **Every agent / tool / connector inherits observability + audit + guardrails
  automatically from `ctx.runtime` (Phase 3).** The agent loop emits ambient audit at
  run + tool boundaries and consults `runtime.guardrails?.checkToolCall` before any
  tool invocation. Opt-out is explicit and must be logged via
  `weaveLogSafetyDowngrade(ctx, ...)` — there is no silent way to be unaudited or
  unobserved.
- **Durable cross-cutting state flows through `runtime.persistence` (Phase 4).**
  Every durable subsystem (DLQ, cost meter, future idempotency / audit ledger /
  endpoint state) consumes `runtime.persistence.kv` ambient. Default is
  `weaveInMemoryPersistence()` (zero-config, lost on exit); pass
  `weaveSqlitePersistence({ path })` (or any other slot factory from
  `@weaveintel/persistence`) to make every consumer restart-safe at once. There is
  no per-call-site KV wiring and no module-level singleton. See
  [Hardening Phase 4](#hardening-phase-4-complete--durable-cross-cutting-state-via-runtimepersistence).
- Keep GeneWeave database-driven for prompts, skills, agents, policies, and related
  configurable capabilities.
- Route prompt parsing, rendering, and version normalization through `@weaveintel/prompts`
  instead of duplicating prompt logic in apps.
- Keep the operator tool catalog (`tool_catalog`, `/api/admin/tool-catalog`) as the single
  source of truth for runtime tool enablement. Never hardcode tool enablement.
- Favor modular changes that reduce pressure on large files (`chat.ts`, `ui.ts`,
  `server.ts`, `server-admin.ts`). Extract by capability domain and re-compose from index
  modules rather than appending new blocks.
- For local runtime, `./geneweave.db` is the canonical SQLite database (`DATABASE_PATH`
  from `.env`). Do not apply data fixes against `./apps/geneweave/geneweave.db` or
  `./data/geneweave.db` unless runtime config is intentionally changed.

---

## Hardening (egress + SSRF)

The framework has a **single hardened egress path** for every server-side HTTP call.
Bypassing it is a review-blocking bug. Every new server-side fetch goes through it.

### Hardening Phase 0 (complete — SSRF chokepoint in `@weaveintel/core`)

- `@weaveintel/core/net-guard` is the single source of truth for outbound URL validation:
  `assertSafeOutboundUrl(url, policy)` and `followRedirectsSafely(resp, init, signal, policy)`.
- Blocks cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`, Azure
  IMDS), RFC1918 / loopback / link-local IPv4+IPv6 literals, DNS rebinding, and
  non-loopback `http://`. Re-validates every redirect hop (max 5).
- `OutboundUrlPolicy` carries a required `errorTag` so package identity surfaces in any
  thrown message.
- Never re-implement SSRF / metadata blocking inline. Always call `assertSafeOutboundUrl`
  (or, preferably, route through `hardenedFetch` below which calls it for you).

### Hardening Phase 1 (complete — one egress chokepoint, lint-enforced)

- **All server-side HTTP goes through `@weaveintel/core` hardened fetch.** Either the raw
  function `hardenedFetch(input, init?, opts)` or, preferred for per-package usage, a
  closure built by `createHardenedFetch({ errorTag, timeoutMs?, maxBytes?, policy? })`
  which returns `{ fetch, fetchStream, assertSafe }`.
- The pipeline composes the five outbound-safety primitives once: SSRF guard → redirect
  re-validation → HTTPS floor → outer `AbortSignal.timeout` (composed with caller signal)
  → streaming response-size cap.
- Defaults: `timeoutMs = 60_000`, `maxBytes = 50 MiB`. Each lever disables on `0`.
  `errorTag` is REQUIRED and prefixes every thrown message.
- `fetchStream(input, init)` is the canonical SSE / NDJSON / chunked-download path:
  SSRF + redirect re-validation still apply; the outer timeout + size cap do not.
  Internally it calls `hardenedFetch` with `{ timeoutMs: 0, maxBytes: 0 }`.
- `enforceHttps: false` is reserved for genuinely non-public hosts (operator-supplied
  IMAP proxies, in-app testing, local browser-fetcher CLIs) where the package layer
  already validates upstream with `validateOutboundUrl`. Default is `true`.
- The 13 per-package `_fetch.ts` adapters (provider-openai/anthropic/google/llamacpp/
  ollama, a2a, oauth, sandbox/cse, tools-enterprise/marketdata/news/search/social) are
  now thin closures over `createHardenedFetch`. Add new packages the same way —
  **never re-implement the pipeline, never call `fetch` directly from package code**.
- Encryption KMS providers route their default `fetchImpl` through `hardenedFetch` while
  preserving an injectable `opts.fetchImpl` test seam.
- The lint rule `npm run check:no-raw-fetch` (script `scripts/check-no-raw-fetch.mjs`)
  scans all `.ts`/`.tsx` under `packages/**/src/**` and `apps/**/src/**` and fails on any
  raw `fetch(` call. Exempt: `_fetch.ts`, `hardened-fetch.ts`, `net-guard.ts`, tests
  (`*.test.ts` / `*.e2e.ts`), browser-side code (`ui-client.ts`, `ui/api.ts`,
  `*-view.ts`, `views/`), `legacy/`, and the standalone live-agents-demo app. Per-file
  escape: `// no-raw-fetch: allow (reason: ...)` comment within the first 20 lines.
  Use sparingly and only for genuine non-global `fetch` symbols (closure params, DB
  cursor callbacks, etc.).
- Test coverage: `packages/core/src/hardened-fetch.test.ts` (17 tests) exercises the
  SSRF gate, redirect re-validation, redirect cap, Content-Length precheck, streaming
  size cap, outer timeout, the `timeoutMs:0` / `maxBytes:0` escape hatches, and the
  factory.

### Hardening Phase 2 (complete — ambient cross-cutting concerns via `weaveRuntime`)

- **`weaveRuntime` is the single ambient root** for cross-cutting concerns. Every
  adopter (app, agent host, worker) constructs **exactly one** at boot and every
  `ExecutionContext` is derived from it. Never construct a parallel runtime, never
  re-wrap egress/tracer/secrets/audit per call site, never reach for a process-wide
  singleton when a runtime is reachable through `ctx.runtime`.
- The runtime bundles, in one object: hardened **egress** (Phase 1 chokepoint),
  **tracer** (observability), **secrets** (env / vault / KMS resolver), **audit**
  logger, optional **persistence** slot, optional **resilience** signal-bus slot.
  Persistence + resilience are structural (`{ kind }` / `{ emit(...) }`) so concrete
  instances from `@weaveintel/persistence` and `@weaveintel/resilience` plug in
  without `@weaveintel/core` taking a dependency on them.
- **`RuntimeCapabilities`** namespace (all `CapabilityId`s):
  `runtime.net.egress`, `runtime.observability`, `runtime.secrets`, `runtime.audit`,
  `runtime.persistence`, `runtime.resilience`, `runtime.encryption`,
  `runtime.guardrails`. Baseline four are always advertised; persistence/resilience
  flip on only when configured; encryption/guardrails are advertised via
  `extraCapabilities`.
- **Capability-declared requirements.** `defineTool({ requires: [...] })` and the
  `ToolSchema.requires` field let any tool name the runtime capabilities it needs.
  At invocation, if `ctx.runtime` is present, the tool asserts those capabilities
  before executing (`runtime.require(...)`); no-runtime contexts preserve the
  zero-config DX. Use `assertRuntimeRequires(runtime, requires, featureName)` from
  feature-registration paths (workflow handlers, connectors, schedulers) to fail
  fast at *registration*, not first-call.
- **Secrets MUST flow through `runtime.secrets`** in adopter code, not
  `process.env.X` reads. The default `envSecretResolver()` reads `process.env`;
  vault / KMS / per-tenant override resolvers compose via `chainSecretResolvers`.
  Use `requireSecret(resolver, key)` when the value is mandatory.
- **`createGeneWeave`** constructs one `weaveRuntime` at boot and exposes it as
  `GeneWeaveApp.runtime`. The same tracer instance is installed as the process-wide
  default (`weaveSetDefaultTracer`) so packages that read the global never disagree
  with the runtime.
- **`ExecutionContext.runtime`** is the propagation channel. `weaveContext({ runtime })`
  adopts the runtime's tracer when no explicit tracer was passed; `childContext`
  inherits the runtime by default. Features pull egress / secrets / audit from
  `ctx.runtime?.…` rather than module-level singletons.
- **One implementation per concern** — packages MUST NOT re-implement retry / backoff
  / circuit-breaker / token-bucket / idempotency / dead-letter locally. Consume
  `@weaveintel/resilience` (token bucket, circuit breaker, concurrency limiter,
  retry policy, resilient callable) and `@weaveintel/reliability` (idempotency keys,
  retry budgets, dead-letter, concurrency, backpressure, health). The lint rule
  `npm run check:no-adhoc-resilience` (script `scripts/check-no-adhoc-resilience.mjs`)
  fails on suspect file basenames (`retry.ts`, `backoff.ts`, `circuit-breaker.ts`,
  `token-bucket.ts`, `concurrency-limiter.ts`, `dead-letter.ts`, `idempotency.ts`,
  `resilience.ts`) outside `packages/resilience/` and `packages/reliability/`.
  Per-file escape: `// no-adhoc-resilience: allow (reason: ...)` within the first
  20 lines. Three legacy files are currently grandfathered with documented reasons
  (kaggle/marketdata per-symbol breakers, workflows per-handler-kind breaker
  registry) — consolidation onto `@weaveintel/resilience` is Phase 2.x deferred.
- **Durable by default, switchable.** The runtime defaults are in-memory / noop /
  env so a fresh `weaveRuntime()` works for tests and tiny adopters. Production
  adopters pass durable backends (Postgres/Redis/Sqlite/etc. via the persistence
  slot; real bus via the resilience slot; vault chain via the secret resolver) —
  one swap, zero call-site changes.
- **Graceful by construction.** Missing optional slots never crash a call — they
  surface as a single `runtime.has(cap)` returning `false`, and `require(...)` /
  `assertRuntimeRequires(...)` throw one readable error naming every missing
  capability. Egress / tracer / secrets / audit are always present, so the
  zero-config path cannot fault on baseline capabilities.
- Test coverage: `packages/core/src/runtime.test.ts` (13 tests),
  `packages/core/src/secrets.test.ts` (9 tests), `packages/core/src/tool-requires.test.ts`
  (5 tests). Golden-path example: `examples/123-runtime-golden-path.ts` exercises
  observability + safe egress + secret resolution + capability gating with no DB,
  no LLM, no external service.
- **Phase 2.x deferred work** (call out, don't block sign-off): migrate every
  remaining `process.env.X_API_KEY` read in `apps/geneweave` and adapter packages
  to `runtime.secrets.resolve(...)`; refactor the three grandfathered local breakers
  onto `@weaveintel/resilience` `createCircuitBreaker`; add `requires: [...]` to
  every shipped tool definition so registration-time assertion replaces invocation-
  time assertion; wire `apps/live-agents-demo` to consume a `weaveRuntime`.

### Hardening Phase 3 (complete — ambient runtime in the agent loop, tool registry, guardrails, audit)

- **Every agent, tool, and connector inherits observability + audit + guardrails
  automatically from `ctx.runtime`.** There is no silent way to be unaudited or
  unobserved. Explicit opt-out is permitted but must be logged via
  `weaveLogSafetyDowngrade(ctx, { feature, reason, component? })` — a documented
  hole, never a hidden one.
- **`RuntimeGuardrailsSlot` is a structural interface** with two optional methods:
  `checkToolCall(ctx, schema, args)` and `checkOutput(ctx, text)`. The agent loop
  consults `runtime.guardrails?.checkToolCall` ambient before invoking a tool;
  a thrown check is treated as **fail-closed** (deny + audit). Missing slot =
  unset capability = allow-all (graceful by construction).
- **`weaveAudit(ctx, AuditEntry)`** is the ambient audit helper. It pulls
  `audit` from `ctx.runtime?.audit`, logs the entry, and swallows logger errors.
  No-op when no runtime is attached. The agent loop emits `agent.run.start`,
  `agent.tool.invoke` (`success`/`failure`/`denied`), and `agent.run.end` at the
  natural boundaries — no call-site wiring required.
- **`createToolRegistry({ runtime })`** asserts each tool's
  `schema.requires` at `register()` time via `assertRuntimeRequires`. Misconfig
  surfaces at boot, not on the first invocation hours later. The zero-config
  constructor (`createToolRegistry()`) still works and defers to the invocation-
  time check from Phase 2.
- **`@weaveintel/weaveintel`** is the curated meta-package — the one import most
  adopters need. Re-exports `weaveRuntime`, `RuntimeCapabilities`, `weaveAgent`,
  `weaveTool`/`weaveToolRegistry`, `weaveContext`, `hardenedFetch`,
  `envSecretResolver`, audit helpers, and the two concrete tracers
  (`weaveConsoleTracer`, `weaveInMemoryTracer`). No hidden behavior — pure
  re-exports.
- **Golden-path example**: `examples/124-ambient-agent.ts`. Sub-100 lines, no DB,
  no LLM, no external service. Constructs one `weaveRuntime`, registers one tool,
  runs a stub-backed `weaveAgent`, and asserts ambient audit + tracer fired. Also
  exercises the guardrails-deny path.
- **Test coverage**: `packages/core/src/runtime.test.ts` (18 tests, +5 for
  guardrails / audit / downgrade), `packages/core/src/tool-requires.test.ts`
  (8 tests, +3 for registry registration-time check), `packages/agents/src/
  agent.ambient.test.ts` (2 tests: ambient layers end-to-end + guardrails deny
  audited). Total 88 core/agents tests green.
- **Phase 3.x deferred work** (do not block sign-off): migrate the workflow
  engine and live-agents tick loop onto the same ambient pattern (currently they
  observe via `withObservedSpan` but do not emit ambient audit at run/tool
  boundaries); annotate every shipped tool definition with `requires: [...]` so
  the registration-time assertion replaces the invocation-time one; expand the
  guardrails slot consumers to also call `checkOutput(ctx, text)` on final agent
  responses (the slot exists but no built-in caller wires it yet).

### Hardening Phase 5 (complete — security depth, simplification, and durability consolidation)

These rules apply to **every** new file, regardless of whether Phase 5 is mentioned. They
are permanent law, not phase-specific guidance.

#### No raw network
- **Never call `fetch`, `http.request`, or `https.request` directly in `packages/**` or
  `apps/**`.** All outbound HTTP goes through the single hardened egress client from
  `@weaveintel/core` (`hardenedFetch` / `createHardenedFetch`), which enforces SSRF
  blocking (cloud-metadata + private hosts), redirect re-validation per hop, HTTPS floor,
  outer `AbortSignal.timeout`, and response-size cap. The lint rule
  `npm run check:no-raw-fetch` blocks violations at CI.
- New tools that need outbound network **must** declare `requires: ['runtime.net.egress']`
  in their schema and receive the client through the runtime's egress slot — they cannot
  construct their own fetch closure or bypass the guard.

#### Ambient cross-cutting concerns
- **Observability, resilience, guardrails, and audit are resolved from `ctx.runtime`, never
  constructed ad-hoc per call site.** Any new agent / workflow / tool / connector inherits
  them automatically. There is no way to be unobserved or unguarded by omission.
- Opting out is explicit and logged via `weaveLogSafetyDowngrade(ctx, { feature, reason })`
  — a structured audit entry that shows up in every audit sink.

#### One implementation per concern
- **Retry/backoff → `@weaveintel/resilience` + `core/error-classifier`.**
- **Circuit breaker / bulkhead / concurrency → `@weaveintel/resilience`.**
- **Durability (idempotency, DLQ, health, backpressure) → `@weaveintel/durability`**
  (`@weaveintel/reliability` is the implementation; import from `@weaveintel/durability`).
- **Storage → `@weaveintel/persistence`.**
- Do **not** add package-local `resilience.ts`, `_fetch.ts`, or bespoke `new Map()` stores
  for these concerns in new code. The lint rule `check:no-adhoc-resilience` blocks new
  local re-implementations.

#### Durable by default-switchable
- Any stateful capability keeps an **in-memory adapter for zero-config DX** but must accept
  a persistence backend via the runtime. Never hardcode `new Map()` as the only store for
  data that must survive a restart.
- The canonical pattern: `opts.runtime?.persistence ?? weaveInMemoryPersistence()` —
  already used by DLQ, cost meter, checkpoint store, endpoint registry, memory store, and
  the durable audit logger.

#### Capability-declared requirements
- Features declare the cross-cutting capabilities they need via `schema.requires: [...]`
  (tools) or `assertRuntimeRequires(runtime, requires, featureName)` (registration-time
  check for workflows, connectors, schedulers). The runtime asserts and injects them at
  registration. A missing capability surfaces at boot, not on the first invocation hours
  later.

#### Packages first, apps as consumers
- **Framework capabilities live in `packages/`** so every adopter benefits. `apps/` only
  holds app-specific glue: configuration, DB schema, admin UI, deployment wiring.
- When a package gains new behavior, update apps to *consume* it rather than keeping
  parallel logic.
- If a behavior is in an app but belongs to the platform, lift it into a package as part
  of the same change.

#### End-to-end tests are mandatory
- Every phase ships with an end-to-end test that exercises the *wired* path, not just the
  unit. Prove: a metadata/private-IP URL is rejected; an agent run emits ambient spans and
  audit without manual setup; a workflow survives a simulated restart with a durable
  backend; a DLQ entry persists across process restart.
- Run the full example suite (`npm run test:examples`) after each phase and fix breakage
  immediately — examples are the adopter's first contract.

#### Phase 5 specific changes (complete)
- **`assertTlsFloor()`** in `@weaveintel/core` — called by `weaveRuntime()` by default.
  Throws if `NODE_TLS_REJECT_UNAUTHORIZED === '0'` (silent MITM vector). Suppress with
  `{ tlsFloor: false }` in test environments only; downgrade entry is encouraged. Never
  disable in production.
- **`createDurableAuditLogger({ persistence?, namespace? })`** in `@weaveintel/core` —
  writes every `AuditEntry` to `runtime.persistence.kv` under
  `${namespace}:${timestamp}:${uuid}`. **Auto-wired by `weaveRuntime`** when a `persistence`
  slot is configured and no explicit `audit` logger is supplied — zero config required from
  adopters. Falls back to `weaveInMemoryPersistence()` when called standalone.
- **`createRedactingAuditLogger(inner, redactor)`** in `@weaveintel/core` — wraps any
  `AuditLogger` and passes every entry's `details` through a `Redactor` before forwarding,
  so PII is stripped from audit trails at the write path. **Auto-wired by `weaveRuntime`**
  when a `redactor` is configured via `WeaveRuntimeOptions.redactor`. The `Redactor`
  interface is structural — pass any `weaveRedactor(policy)` from `@weaveintel/redaction`.
- **`WeaveRuntimeOptions.redactor?: Redactor`** — when supplied, wraps the audit logger
  (whether explicit or auto-wired durable) with `createRedactingAuditLogger`.
- **`guardrails.checkOutput` is now called** on every terminal agent response in both
  `run()` and `runStream()`. A `{ allow: false }` is fail-closed + audited as
  `agent.output.denied`; a `{ redactedText }` replacement is surfaced to the caller and
  saved to memory instead of the raw text.
- **Sandbox egress allowlist** — `CSEConfig.networkAllowlist?: string[]` and
  `ExecutionRequest.networkAllowlist?: string[]` are now required to open the Docker bridge.
  `networkAccess: true` alone keeps network mode `none`. Full per-host filtering requires
  CNI-based egress (road-mapped); the allowlist today gates whether any bridge opens.
- **`@weaveintel/durability`** — new canonical package (re-exports `@weaveintel/reliability`).
  New code MUST import durability primitives from `@weaveintel/durability`. The
  `@weaveintel/reliability` package remains for backward compatibility.
  Architectural boundary:
    - `@weaveintel/resilience`  — live per-call guard pipeline (token bucket, circuit
      breaker, concurrency limiter, retry policy).
    - `@weaveintel/durability`  — operational durability (idempotency, DLQ, retry budget,
      health, backpressure) that consumes resilience for its internals.
- **Two sandbox subsystems** — `sandbox/src/cse/providers/*` (cloud-provider sessions:
  local Docker, ACI, AKS, GKE, Cloud Run) and `sandbox/src/executors/container/*`
  (DockerRuntime + image-policy for ephemeral exec). The `cse` path is the **canonical**
  provider for new work; `executors/container` handles ephemeral single-exec without a
  session and is not deprecated but should not be extended.
- **Two persistence subsystems** — `@weaveintel/persistence` (8-adapter CRUD layer for
  live-agents state, phase7/8 benchmarks) and `runtime.persistence` (the structural KV
  slot used by DLQ / cost-meter / audit / checkpoint / endpoint-registry / memory store).
  Use `@weaveintel/persistence` factories (`weaveSqlitePersistence`, etc.) to populate the
  `runtime.persistence` slot; the CRUD adapters serve the live-agents state-store surface.
  There is intentionally one implementation of each; they serve different contracts.
- **Test coverage** — `examples/127-phase5-security.ts` (5 assertions):
  TLS floor assertion, durable audit auto-wired and KV-verified, auto-redaction strips
  PII before KV write, `checkOutput` deny + redact paths, sandbox network-mode gate.
  All assertions pass with no LLM, no external service, no DB beyond a tmp SQLite file.
- **Phase 5.x deferred** (do not block sign-off): migrate `apps/geneweave` to construct
  `weaveRuntime` with `redactor: weaveRedactor(DEFAULT_REDACTION_POLICY)` and verify the
  auto-redacting audit logger picks it up; add `requires: ['runtime.net.egress']` to every
  shipped tool that calls outbound HTTP; wire `apps/live-agents-demo` onto the same runtime
  entry point; add a `weaveRedisPersistence` / `weaveMongoPersistence` slot factory for
  multi-node deployments.

### Hardening Phase 4 (complete — durable cross-cutting state via `runtime.persistence`)

- **Durable by default, switchable.** Every adopter constructs one
  `weaveRuntime` at boot and **passes a single `persistence` slot**. Every
  durable subsystem (DLQ, cost meter, future idempotency / audit ledger /
  endpoint state) consumes `runtime.persistence.kv` ambient. Swap the slot →
  every consumer becomes restart-safe at once. There is no per-call-site KV
  wiring and no module-level singleton.
- **`RuntimePersistenceSlot` now carries real operations.** Phase 2 shipped a
  `{ kind }` marker; Phase 4 promotes it to a structural contract: `{ kind,
  kv: RuntimeKvStore }` where `RuntimeKvStore` exposes the four-method KV
  surface (`get`, `set`, `delete`, `list(prefix)`) every durable subsystem
  needs. Values are opaque strings (callers JSON-encode); `list(prefix)`
  returns lex-sorted entries; `set(key, value, { ttlMs })` is honoured lazily
  on read / list. Best-effort throughout — a thrown KV op never crashes the
  runtime itself.
- **`weaveInMemoryPersistence()`** is the zero-config default in
  `@weaveintel/core` (Map-backed, TTL-aware). Use it directly when you want a
  process-local durable seam in tests / examples without depending on
  `@weaveintel/persistence`.
- **`weaveSqlitePersistence({ path, table? })`** is the canonical durable
  factory in `@weaveintel/persistence`. Lazy-loads `better-sqlite3` via
  `createRequire(import.meta.url)` so the persistence package does not force
  the dep on adopters that pick a different backend. Schema is
  `(k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at INTEGER)` — created on
  first use; safe to share a path across processes (SQLite serialises writes).
  Postgres / Redis / Mongo / Cosmos slot factories follow the same shape and
  land alongside their existing persistence-package adapters as adopters
  request them.
- **`createDurableDeadLetterQueue({ runtime?, namespace? })`** in
  `@weaveintel/reliability` is the runtime-aware DLQ. Records serialised under
  `${namespace}:${id}` (default namespace `'dlq'`). When `runtime?.persistence`
  is missing it falls back to `weaveInMemoryPersistence()` so the
  zero-config DX matches `createDeadLetterQueue()`. Returns the
  `AsyncDeadLetterQueue` interface — every method is `Promise`-returning so
  the same surface works against any backend. The legacy sync
  `createDeadLetterQueue()` stays for back-compat (example 19) but new code
  should pick the durable variant.
- **`createDurableCostMeter({ runtime?, namespace? })`** in
  `@weaveintel/workflows` is the runtime-aware cost meter. Totals stored as
  integer cents (`Math.round(costUsd * 100)`) under `${namespace}:${runId}`
  to avoid float drift. Same fall-back rules as the durable DLQ. The legacy
  `InMemoryCostMeter` remains for back-compat.
- **Workflows already had multi-backend stores.** The persistence
  matrix (sqlite/postgres/redis/mongodb/dynamodb × checkpoint-store /
  run-repository / run-queue / idempotency-store / payload / audit /
  rate-limiter / sleep / step-lock) is in place; Phase 4 does not duplicate
  it. The path forward for new geneweave wiring is to construct those stores
  from the same `runtime.persistence` config the rest of the framework uses,
  but that consolidation is incremental.
- **`@weaveintel/memory` already delegates to `@weaveintel/persistence`** via
  `createConfiguredMemoryStore` — no parallel DB-driver imports inside
  `packages/memory/src`. Treat memory as already-consolidated; do not
  re-implement memory backends.
- **Test coverage**: `packages/reliability/src/dead-letter.restart.test.ts`
  (2 tests — restart survival via SQLite-backed slot, plus the no-runtime
  fallback). Golden-path example: `examples/125-durable-runtime.ts` constructs
  one runtime with `weaveSqlitePersistence`, enqueues a DLQ record + records
  cost via the durable meter, disposes the runtime, reconstructs a fresh
  runtime on the same path, and asserts both records survive. Sub-100 lines,
  no DB beyond a tmp SQLite file, no LLM, no external service.
- **Lint + meta-package re-exports.** `weaveInMemoryPersistence`,
  `RuntimeKvStore`, `weaveSqlitePersistence`, `createDurableDeadLetterQueue`,
  `createDurableCostMeter` are re-exported from `@weaveintel/weaveintel` so
  the curated meta-package stays the one import most adopters need.
  `check-no-raw-fetch` and `check-no-adhoc-resilience` remain green.
- **Phase 4.x deferred work** (do not block sign-off): wire `apps/geneweave`
  to construct `weaveRuntime({ persistence: weaveSqlitePersistenceSlot(
  DATABASE_PATH) })` and migrate every existing in-process DLQ / cost-meter
  / endpoint-state consumer onto the durable variants; ship
  `weavePostgresPersistence`, `weaveRedisPersistence`, `weaveMongoPersistence`,
  `weaveCosmosPersistence` slot factories alongside the existing high-level
  adapters; refactor `packages/resilience/src/endpoint-registry.ts` from a
  module-level `Map` to a `runtime.persistence`-backed registry so endpoint
  state survives process restart and coordinates across nodes (this is a
  significant architecture change — quota counters need atomic `incr` /
  windowing semantics that the current KV contract does not yet expose);
  collapse the workflows persistence matrix onto the same `runtime.persistence`
  config the rest of the framework consumes.

- **Phase 4.x complete subsystems (durable variants shipped).** Each one
  follows the canonical DLQ/cost-meter pattern — `createDurable*({ runtime?,
  namespace? })`, falls back to `weaveInMemoryPersistence()` when no slot is
  supplied, and exposes a Promise-returning interface alongside the existing
  sync API. Adopters opt in by passing a `weaveSqlitePersistence({ path })`
  (or any other slot factory) on `weaveRuntime` and constructing the durable
  variant instead of the legacy in-memory one. Restart-survival tests live
  in `packages/compliance/src/durable.restart.test.ts` and
  `packages/oauth/src/durable.restart.test.ts`; the cross-subsystem
  golden-path is `examples/126-durable-subsystems.ts`.
  - **OAuth flow state** — [packages/oauth/src/durable.ts](packages/oauth/src/durable.ts)
    (`createDurableOAuthStateStore`, ns `oauth-flow`, TTL via `expiresAt`).
  - **Trigger rate-limit windows** — [packages/triggers/src/durable-rate-limit.ts](packages/triggers/src/durable-rate-limit.ts)
    (`createDurableTriggerRateLimiter`, ns `trigger-rate`, 60s tumbling).
  - **Human-tasks pending approvals** — [packages/human-tasks/src/durable.ts](packages/human-tasks/src/durable.ts)
    (`createDurableHumanTaskRepository`, ns `human-tasks`, priority-ordered).
  - **Cost-governor ledgers** — [packages/cost-governor/src/durable-ledger.ts](packages/cost-governor/src/durable-ledger.ts)
    (`createDurableCostLedger` ns `cost-ledger` with padded ordinal keys for
    sortable replay; `createDurableRunCostStateTracker` ns `cost-runstate`).
  - **Tenancy budget usage** — [packages/tenancy/src/durable-budget.ts](packages/tenancy/src/durable-budget.ts)
    (`createDurableBudgetEnforcer`, ns `tenant-budget`; usage stored as
    integer microUSD to avoid float drift across cumulative writes).
  - **Compliance (six stores)** — [packages/compliance/src/durable.ts](packages/compliance/src/durable.ts):
    `createDurableLegalHoldManager` (`legal-hold`),
    `createDurableConsentManager` (`consent`, compound key
    `${subjectId}::${purpose}`), `createDurableResidencyEngine`
    (`residency`), `createDurableRetentionEngine` (`retention`),
    `createDurableAuditExportManager` (`audit-export`),
    `createDurableDeletionManager` (`deletion`).
  - **Collaboration (three stores)** — [packages/collaboration/src/durable.ts](packages/collaboration/src/durable.ts):
    `createDurableHandoffManager` (`handoff`),
    `createDurableSharedSessionManager` (`collab-session`, single record
    with embedded participants array), `createDurableRunSubscriptionManager`
    (`run-sub`, compound key `${runId}::${subscriberId}`).
  - **Browser MCP-auth pending handoffs** — [packages/tools-browser/src/durable-handoff.ts](packages/tools-browser/src/durable-handoff.ts)
    (`createDurableBrowserHandoffStore`, ns `browser-handoff`).
  - **Per-host HTTP rate buckets** — [packages/tools-http/src/durable-rate.ts](packages/tools-http/src/durable-rate.ts)
    (`createDurableHttpRateBucketStore`, ns `http-rate`, throws on
    over-budget to match existing in-memory semantics).

- **Phase 4.x still deferred** — `packages/resilience/src/endpoint-registry.ts`
  needs the atomic-counter + windowing extension to the `RuntimeKvStore`
  contract before its module-level `Map` can move to durable storage. The
  9-subsystem batch above did not require any contract changes.

---

## Prompt / Skill / Tool / Policy Boundary

Pick the right primitive for the requirement:

- **Prompts** — templateable model instructions, reusable system/user structures, few-shot
  exemplars, routing/judging/optimizer assets, and model-facing text variants that benefit
  from versioning and experimentation.
- **Skills** — reusable behavior packs combining instructions, tool activation, and
  execution guidance.
- **Tools / workers** — capabilities that perform actions or fetch data, not just shape
  model text.
- **Runtime policies** — orchestration rules, hard execution constraints, guardrails, and
  non-optional workflow behavior.

A prompt is a prompt asset only when it is genuinely model-authored instructions or a
reusable composition. Behavior bundles, operational policies, and tool-activation logic
belong in skills/tools/contracts/runtime policies — not prompt text. Preserve strong
descriptions and structured metadata on anything callable by an LLM.

---

## Durable Cross-Cutting Principles

These govern the whole framework. Every new contribution follows them.

- **Every DB row uses a UUID primary key.** SQLite: `TEXT` with UUID v7 via `newUUIDv7()`
  from `@weaveintel/core`. Never `INTEGER PRIMARY KEY AUTOINCREMENT` for new tables. For
  short ids use `newUUIDv7().slice(-N)` (the *tail* is random; the first 8 hex chars are a
  timestamp prefix that collides within the same ms). The OAuth nonce deliberately uses
  `randomUUID()` (spec-required full entropy, not a sortable id).
- **The evidence ledger is always `@weaveintel/contracts`.** Never invent a parallel
  ledger table.
- **Reproducibility is always `@weaveintel/replay`.** Never invent a bespoke bundle format.
- **Sandboxed compute for native code / subprocesses / non-trivial memory.** The
  in-process executor is insufficient for SymPy, SciPy, R, RDKit, OpenMM, Biopython, etc.
  Use `ContainerExecutor` in `@weaveintel/sandbox`.
- **Tool invocations flow through `@weaveintel/tools` with risk tags.** No ad-hoc
  subprocess spawning. Every tool is a versioned registration with risk classification and
  health tracking; guardrails enforce the risk policy.
- **Multi-agent dialogue flows through `@weaveintel/a2a`.** In-process bus locally, HTTP
  transport distributed. Never pass messages between agents via shared module state.
- **Model selection flows through `@weaveintel/routing`.** Agents declare a capability
  requirement; routing decides. Never hard-code a model id.
- **Redaction happens before the model call.** `@weaveintel/redaction` with reversible
  tokenisation sits as middleware on the model client. LLMs never see raw PII.
- **Observability is wired at the entrypoint.** Tracer initialised in `createGeneWeave()`
  via `weaveSetDefaultTracer`. Step-level cost attribution / budget enforcement is an
  in-progress target.
- **Idempotency on writes.** `@weaveintel/reliability` idempotency keys on every
  state-mutating POST.

---

## Grounding Reality Guardrails

- Treat prompt text as guidance, not guaranteed execution. Anything that must *always*
  happen (tool call, policy check, verification pass, formatting guarantee) belongs in
  code-level orchestration and shared runtime hooks.
- Keep execution strategies DB-driven and traceable: strategy selection comes from prompt
  metadata (`executionDefaults.strategy`) plus admin-managed strategy records, not app-only
  conditionals.
- Runtime metadata must capture which strategy, contracts, and evaluations were used so
  audits can explain model behavior after the fact.
- Prefer shared helpers in `@weaveintel/prompts` for prompt execution and strategy
  overlays; GeneWeave consumes them, never duplicates.
- Optimization prompts are hypotheses: verify candidate quality with deterministic
  evaluation passes before promotion. Promotion decisions are code-level and data-backed,
  never instruction-only.

---

## Reusability & Package Boundaries

A reusable package imports **only** its declared dependencies. These boundaries are hard;
violating one is a review-blocking bug.

| Package | May import | Must NOT import |
|---|---|---|
| `@weaveintel/cost-governor` | `@weaveintel/core`, `@weaveintel/tools` | geneweave, any DB adapter, `@weaveintel/core` capability-binding helpers |
| `@weaveintel/encryption` | `@weaveintel/core`, `node:crypto` | DB, `fetch`, cloud SDKs (lazy-`import()` inside providers only), any third-party dep |
| `@weaveintel/triggers` | interfaces + built-ins | DB types (persistence wired by host via `TriggerStore`) |
| `@weaveintel/live-agents` | capability slots | DB types |
| `@weaveintel/live-agents-runtime` | structural `LiveAgentsDb` interface | concrete geneweave types (`DatabaseAdapter` satisfies the interface structurally) |
| `@weaveintel/live-agents-trace-tools` | `@weaveintel/core`, `@weaveintel/tools` | geneweave, DB, `crypto` |

The "DB-driven" property of any feature is a property of the **GeneWeave reference impl**,
not the package. Consumers always supply their own store / resolver / adapter
implementations and pass them in.

DB hydration for live-agents goes through `@weaveintel/live-agents-runtime`
(`weaveLiveMeshFromDb`, `weaveLiveAgentFromDb`) — never re-implemented in apps, never a
new `bootXxxMesh()` wrapper.

---

## Naming Conventions

- `weave*` — user-facing constructor that returns a runnable thing (agent, mesh, store,
  resolver, model adapter, policy). New user-facing constructors MUST use this prefix.
- `create*` — internal factory returning infrastructure plumbing (registry, dispatcher,
  scheduler, supervisor handle).
- Types use `PascalCase` nouns.
- Deprecated aliases are kept for one minor release cycle, then removed.

---

## Build & Test Environment Invariants

These apply to **every** change. They are stated once here; do not re-derive them per
feature.

### Dist staleness (the #1 time-waster)
`apps/geneweave/package.json` declares `"main": "./dist/index.js"`. Anything importing
`@weaveintel/geneweave` via `tsx` (examples, e2e scripts) loads the **compiled dist**, not
the source. **After every edit under `apps/geneweave/src/**` you MUST run
`npx tsc -b apps/geneweave` before restarting the server/example**, or the change has zero
runtime effect.

### TypeScript strictness
- `exactOptionalPropertyTypes` is on. Never assign `undefined` to an optional field — use
  conditional spreads: `...(x !== undefined ? { x } : {})`.
- `noPropertyAccessFromIndexSignature` is on. Use bracket notation for index-signature
  result properties (`result['ok']`, not `result.ok`).
- `noUnusedLocals` is on. Use rest-destructure drops (`const { __drop: _d, ...rest } = x`)
  when intentionally discarding keys.

### Known import aliases (these bite repeatedly)
- `createExecutionContext` is re-exported from `@weaveintel/core` **only** as alias
  `weaveContext`. Importing the original name fails (TS2724).
- Bare `createToolRegistry` / `defineTool` are **not** exported from `@weaveintel/core`.
  Use `weaveToolRegistry as createToolRegistry`, `weaveTool as defineTool`.
- `BUILTIN_TOOLS` lives in `apps/geneweave/src/tools.ts` (re-exported from
  `apps/geneweave/src/index.ts`), NOT in `@weaveintel/tools`. External packages never
  import it.
- A `ToolRegistry` stores tools by `tool.schema.name`, not a top-level `name` field.

### SQLite quirks
- `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP` has **1-second precision**. Any
  `ORDER BY created_at` that needs determinism MUST add `, rowid ASC` (or matching `DESC`)
  for tie-breaking within the same second.
- Migrations live in TS template literals — **never put backticks in SQL comments** inside
  a migration string (it breaks parsing). Use plain text.
- Encryption *key* tables use ms-epoch `INTEGER` timestamps; `tenant_encryption_policy`
  uses TEXT `datetime('now')`. Do not mix conventions per table.

### Router
The router exposes `del`, not `delete`. Bind it locally:
`const delMethod = router.del.bind(router); delMethod('/path', ...)`. There is no fallback.

### Admin route helpers
Operator-only routes (cost policies, cost ledger, encryption) use a local minimal
`{ json, readBody }` helper type, NOT `AdminHelpers`. `AdminHelpers` carries
`requireDetailedDescription`, which is only meaningful for LLM-callable entity routes.

### E2E auth quartet (validated, reusable)
- `set +H` in zsh (or avoid `!`) when passwords contain `!` (history expansion).
- The admin-role column is **`persona`**, not `role`. Promote:
  `sqlite3 ./geneweave.db "UPDATE users SET persona='tenant_admin' WHERE email='X';"`.
- The CSRF token is returned in the **login response body** as `csrfToken`. There is no
  `/api/csrf` endpoint. Send it as the `X-CSRF-Token` header on every mutation.
- For zsh launch scripts, prefer a `/tmp/start-*.sh` file (`set -a; source .env; set +a;
  export …`) over inline `nohup … &` with `$(...)` + multiple `&&` (triggers `dquote>`).

---

## Graceful Degradation

Cross-cutting machinery is **never load-bearing**. This is a project-wide invariant, not a
per-feature decision.

- Resolvers fall back: `resolver → pinned → throw` only as a last resort with a clear
  message naming both slots.
- Cost-governor levers (model cascade, tool subset, intel gate, caching, budget gate) all
  pass through on any error, missing config, or missing context. A malformed binding must
  never crash a tick.
- Audit emitters are best-effort: they swallow their own errors and never throw into the
  caller.
- Bus publishes inside contract emitters are best-effort and swallowed.
- Encryption is opt-in per tenant: missing manager / missing policy / missing `tenant_id`
  → write plaintext, do not crash. Lazy-upgrade tolerant: legacy plaintext rows remain
  readable.
- `tool_search` / connector lookups returning nothing → respond normally, do not assert
  unavailability.

If you find yourself adding a throwing branch to a resolver, filter, gate, or emitter,
stop — it almost certainly belongs as a degraded pass-through instead.

---

## Observability & LLM-Callable Metadata

- Add new observability schemas in shared packages first (`@weaveintel/core` contracts,
  `@weaveintel/observability` helpers) so prompts, skills, agents, and tools emit one
  comparable trace shape.
- Capability telemetry is grounded in code: runtime metadata is emitted from runtime hooks
  and stored in DB-backed traces, never inferred from prompt text.
- Capability descriptions in traces stay model-facing and explicit enough to support future
  routing, audits, and replay review.
- Enforce detailed model-facing descriptions for prompts/skills/tools/agents through shared
  validation helpers in `@weaveintel/core`.
- Capture prompt resolution metadata (`source`, `resolvedVersion`, `selectedBy`,
  experiment metadata) in runtime message metadata.

---

## Live-Agents: When to Use & Capability Parity

**Use live-agents** when agents run continuously (hours/days), accumulate learnings in
contracts, run in parallel needing distributed coordination, respond to external events
continuously, or need mesh isolation / cross-mesh bridges.

**Use `@weaveintel/agents`** for single request/response, stateless tool-calling chains, or
a bounded-depth ReAct loop.

Capability parity is the rule: live-agents is a *temporal extension* of `weaveAgent`, not a
parallel implementation. If `weaveAgent` accepts a capability slot (`model`, `tools`,
`memory`, `policy`, `bus`, `workers`), `weaveLiveAgent` accepts the same type — reuse or
extend with a per-tick variant, never duplicate.

- Per-tick capability resolution (model, tools, prompt, policy gates) is first-class:
  anything that may change between ticks is resolvable per invocation via a resolver
  interface, not pinned at construction. Pinned values stay supported for tests and
  short-lived agents.
- New user-facing constructor → `weaveLiveXxx`. New boot path → `weaveLiveMeshFromDb`. New
  per-tick concern → inject as a resolver, not a static value.
- Every model resolution, tool resolution, policy decision, and contract change emits a
  `live_run_events` row. The **package** emits these; the app does not. Add new kinds via
  PR review, never silently.

Account binding (hard invariant): only humans bind accounts to agents; binding includes a
capabilities array; revocation is immediate (next tick sees it). MCP credentials live in
environment variables, never in the DB.

---

## Contract Reference

Condensed durable facts per platform. Full build history → `docs/PHASE_LOG.md`.

### Tool platform
- Tables: `tool_catalog` (registry; `tool_key` unique, `version`, `side_effects`, `tags`,
  `source` ∈ `builtin|custom|mcp|plugin`, `credential_id`, `config`), `tool_policies`
  (UUID PK; seeded `default|strict_external|destructive_gate|read_only`),
  `tool_rate_limit_buckets` (1-min tumbling), `tool_audit_events`,
  `tool_health_snapshots`, `tool_approval_requests`, `tool_credentials`.
- Risk levels: `read-only | write | destructive | privileged | financial |
  external-side-effect` (old `low/medium/high` retired).
- Admin paths: `/api/admin/tool-catalog`, `/api/admin/tool-policies`,
  `/api/admin/tool-audit`, `/api/admin/tool-health`, `/api/admin/tool-credentials`,
  `/api/admin/tool-approval-requests`, `/api/admin/tool-simulation`.
- Canonical types from `@weaveintel/geneweave`: `ToolCatalogRow` (deprecated alias
  `ToolConfigRow`), `ToolPolicyRow`, `ToolAuditEventRow`, `ToolHealthSnapshotRow`,
  `ToolCredentialRow`.
- `createToolRegistry()` is **async** — all call sites `await` it. When a `policyResolver`
  is supplied it returns a policy-enforced registry automatically (enabled → circuit
  breaker → risk gate → approval gate → rate limit → timed execute → audit emit).
- `EffectiveToolPolicy.source`: `default | global_policy | skill_override |
  persona_override`. Skill overrides via `skillPolicyKey` in `PolicyResolutionContext`.
- **Secrets never in DB** — `tool_credentials` stores `env_var_name` only.
- Startup order in `index.ts`: `seedDefaultData()` → `syncToolCatalog(db)` →
  `startToolHealthJob(db)` → workflow engine → HTTP listen.

### Prompts platform (`@weaveintel/prompts`)
- Tables: `prompt_fragments`, `prompt_frameworks`, `prompt_versions`,
  `prompt_experiments`, `prompt_strategies` (+ eval datasets / runs / optimizers /
  optimization runs).
- Fragments: `{{>key}}` syntax, `resolveFragments(template, registry)`; circular refs
  detected (max depth 5) and left unexpanded. Frameworks: ordered named sections; only
  keys in `SYSTEM_SECTIONS` (`'role'`) map to the system message.
- Unified render: `renderWithOptions(template, variables, values, options?)` → fragment
  expand → optional lint → interpolation. Returns `RenderResult` (`.text`, `.lintResults`,
  `.expandedTemplate`). Prefer over `resolveFragments` + `createTemplate().render()`.
- Adapters: `openAIAdapter`, `anthropicAdapter`, `textAdapter`, `systemAsUserAdapter`;
  select via `resolveAdapter(provider)`.
- Runtime selection: `resolvePromptRecordForExecution()` order is requested override →
  active experiment weighted variant → active published version → latest published → base
  prompt fallback. Empty/unavailable version/experiment tables fall back without failing.
- Execution: `executePromptRecord(record, variables, options?)` (render + strategy +
  evaluation hooks). Strategy order: explicit `strategyKey` → `executionDefaults.strategy`
  → fallback.

### Workflows platform (`@weaveintel/workflows`)
- Tables: `workflow_defs`, `workflow_handler_kinds` (catalog; `INSERT … ON CONFLICT DO
  UPDATE` preserves operator-edited `enabled`), `workflow_runs` (+ `cost_total`),
  `workflow_checkpoints`.
- `DefaultWorkflowEngine` (`startRun` synchronous to terminal; `tickRun` for paused).
  `HandlerResolverRegistry` maps `kind` (`noop|script|tool|prompt|agent|mcp|subworkflow`)
  to a runnable. Built-ins wired in geneweave: `noop`, `script`, `tool`. Others reserved.
- `WorkflowStep`: required `id`, `name`, `type`. `handler` forms: bare key / prefixed
  (`tool:`, `script:`) / omitted (falls back to `id`). Ordering via `next` (string |
  string[]); **there is no `nextSteps` field**. `inputMap` reads `state.variables` (no
  `variables.` prefix); `outputMap` writes to `variables` (`"$"`/`""` = whole result).
  `script:` body has `variables` + `config` and **must `return`**.
- Governance (Phase 5): `validateWorkflowInput` (ajv-free JSON-schema-lite) rejects bad
  input before any step runs; `WorkflowPolicy.costCeiling` → run fails + emits
  `workflow:cost_exceeded`; replay is **ordinal-strict** (keyed by ordinal, not stepId);
  `CheckpointStore` / `WorkflowRunRepository` persistence.
- Output binding: `WorkflowOutputContract` packs/unpacks via reserved key
  `metadata.__outputContract` (no dedicated column). `ContractEmitter` emits **after**
  successful terminal state, best-effort.
- Admin: `POST /api/admin/workflows/:id/run` (503 if engine unwired, 400 bad JSON, 201
  `{ runId, run }`). Admin body shape is **flat snake_case**; POST auto-generates
  `'wf-'+randomUUID().slice(0,8)`; returns `{ workflow }`.

### Triggers platform (`@weaveintel/triggers`)
- Tables: `triggers`, `trigger_invocations` (both UUID PK, FK CASCADE).
- `Trigger` uses **nested refs**: `source:{kind,config}`, `target:{kind,config}`,
  `filter:{expression}`, `rateLimit:{perMinute}` — never flat snake_case inside the
  package. Source kinds: `cron|webhook|filewatch|mcp_event|db_change|contract_emitted|
  workflow_event|signal_bus|manual`. Target kinds: `workflow|agent_tick|mesh_message|
  contract|webhook_out` (only `workflow` + `webhook_out` wired; others record
  `no_target_adapter`). Invocation status: `dispatched|filtered|rate_limited|disabled|
  no_target_adapter|error`.
- `TriggerStore`: `list`/`save`/`recordInvocation` (store swallows its own failures).
  After **every** CRUD write the host calls `dispatcher.reload()`. Invocation ids minted
  by the dispatcher (`crypto.randomUUID()`).
- Filter language: JSONLogic-lite, fail-closed on unknown ops. `MeshContractSourceAdapter`
  consumes a Node `EventEmitter` for `contract_emitted` triggers — one bus per process,
  shared by `DbContractEmitter` (publisher) and the adapter (consumer); never module-level
  state.
- Admin body shape is **snake_case** (route translates to nested `Trigger`). Manual fire
  matches only `source.kind === 'manual'`.

### Capability bindings, packs, cost
- `capability_policy_bindings` (UUID PK): `binding_kind` ∈ `agent|mesh|workflow|tenant`,
  `policy_kind` ∈ `tool_policy|rate_limit|approval|cost_policy`, `precedence`, `enabled`.
  **Precedence: agent=100 > mesh=50 > workflow=10 > tenant=5 > package_default.** Resolve
  with `resolveCapabilityBinding(...)`. Kaggle workflow id convention is `'kaggle'`.
- `capability_packs` / `_installations` / `_experiments`: manifest key is
  `lower.dotted.snake_case` (**no hyphens**), version is semver. `installPack` is atomic
  (no rows written if preconditions unmet → 412); `uninstallPack` deletes exactly the
  ledger rows (re-uninstall → 409). 6 supported buckets: `workflow_defs`, `triggers`,
  `prompts`, `prompt_fragments`, `tool_policies`, `capability_policy_bindings`.
- `cost_policies` (UUID PK, `key` unique, `tier`, `levers_json`). `CostTier` ∈
  `economy|balanced|performance|max|custom`; `DEFAULT_COST_TIER = 'balanced'`.
  **Cost governor is default-on**: `resolveCostGovernorBundle` never returns null — no
  binding → `package_default` (`balanced`). `DbCostPolicyResolver` walks agent → mesh →
  workflow → tenant → null. `tier: 'custom'` skips preset merge (supply every lever).
  Levers L1–L9: model cascade, prompt caching, tool subset (`all|phase|intent-rag`),
  intel gating, history compaction, maxStepsCap, reasoningEffort, output truncation,
  budget gate. All resolvers are **never load-bearing**.

### Scientific Validation (`sv:`)
- Tables (UUID PK): `sv_hypothesis`, `sv_sub_claim`, `sv_verdict`, `sv_evidence_event`
  (no `tenant_id`), `sv_agent_turn`.
- `SvHypothesisStatus`: `queued|running|verdict|abandoned` (terminal set:
  `{verdict, abandoned}`). `SvClaimType`: `mechanism|epidemiological|mathematical|
  dose_response|causal|other` (never `empirical`). Verdicts: `supported|refuted|
  inconclusive|needs_revision`.
- `SVWorkflowRunner` instantiated once at startup; model factories are **async**. 18 SV
  tools are SV-agent-only (not in `tool_catalog`, not operator-policy-managed). Routes
  under `/api/sv/...`; `Idempotency-Key` required on submit + reproduce. SSE via
  `pollRows`, keepalive every 15s, max stream 5 min.

### Live-agents runtime
- DB column `live_agents.prepare_config_json` (declarative `prepare()` recipe). Recipe
  `tools`: `'$auto'` | `{ auto?, traceTools?: '$auto' }`. Caller-supplied `prepare`
  always wins. `live_run_events` kinds: `model.resolved`, `tool.resolved`,
  `policy.decision`, `contract.changed`, `tick.started`, `tick.completed`, `tick.errored`.
- Six state-store backends ship (`weaveInMemory/Sqlite/Postgres/Redis/MongoDb/DynamoDb
  StateStore`). Entry points: `weaveLiveMeshFromDb`, `weaveLiveAgentFromDb`,
  `weaveLiveAgent`, `weaveLiveAgentPolicy`, `weaveModelResolver`, `weaveDbModelResolver`.
- Admin response keys are kebab-case: list `{ 'live-meshes': [...] }` / `{ 'live-agents':
  [...] }`; single `{ 'live-mesh': {...} }` / `{ 'live-agent': {...} }`.

### Tenant encryption (`@weaveintel/encryption`)
- Tables: `tenant_encryption_policy` (TEXT timestamps), `tenant_keks`/`tenant_deks`/
  `tenant_biks` (ms-epoch INTEGER, UUID PK), `encryption_audit`,
  `encryption_rewrite_progress`, `tenant_deletion_requests`, `tenant_byok_config`,
  `tenant_break_glass_request`, `tenant_attestation_log`,
  `system_attestation_signing_key`, `tenant_encryption_alert_config`.
- Sentinel: `enc:v1:<epoch>:<iv_b64>:<ct_b64>`. AAD: `tenant|table|column|rowId|epoch`
  (mismatch → `EncryptionContextMismatchError`). `KeyStatus`: `active|previous|revoked`
  (**never `'rotated'`**) — rotation: active→previous; shred: all→revoked. Decrypt looks
  up DEK by `(tenantId, epoch)`, so `previous` DEKs stay readable.
- Engine: `weaveTenantKeyManager`; KMS via `KmsProviderRegistry` (5 built-ins:
  `local|aws-kms|azure-kv|gcp-kms|vault`); per-tenant routing via cached resolver
  (cache key includes a config hash). **`WrappedKey` is Buffer-based (KMS internals);
  `SerializedWrappedKey` is string-based (records)** — do not call
  serialize/deserialize at the DB boundary.
- Multi-table proxy: `weaveTenantEncryptedProxy({ db, getManager, specs })` /
  `withTenantEncryptedDb` (canonical). `withTenantEncryptedMessages` is a back-compat
  alias — **prefer `withTenantEncryptedDb`**. `getManager` is a live-binding getter
  closure (ESM live binding; never capture the manager directly).
- Blind indexes: companion `<column>_bidx` = `HMAC-SHA-256(BIK, "table|column|value")`
  truncated to 24 hex. Equality-only. Cross-tenant equality (login by email) uses the
  reserved `__system__` tenant. After `rotate-bik` you **must** `rebuild-bidx`.
- Schedulers: rotation (strict `>` age boundary, `'manual'` skipped, actor
  `system:rotation-scheduler`), purge (strict `<=` boundary, actor
  `system:purge-scheduler`). **Audit emission is package-side only — schedulers must not
  double-emit.** Audit column is `event_kind` (snake_case at DB/REST; camelCase
  `eventKind` in package types).
- Observability: `MetricsEmitter.record()` is **synchronous, fire-and-forget**; bounded
  `InMemoryMetricsEmitter`; pure `evaluateAlerts()`; alert config is DB-driven (fleet rule
  `tenant_id IS NULL` + per-tenant override coexist). Keep labels low-cardinality
  (`tenantId/table/column/provider/kind/cache`).
- BYOK/HYOK: RSA-4096 minimum (enforced at package boundary → 400). HYOK secrets never in
  DB (store env var *name* only). Break-glass dual approval is non-bypassable, window
  capped at 24h. Attestation uses canonical JSON (recursively sorted keys) → SHA-256
  `payload_hash` → Ed25519 signature; audit chain is append-only and tip-anchored.
- Boot is idempotent and non-fatal: missing `WEAVE_ENCRYPTION_MASTER_KEY` → manager stays
  null, encryption is opt-in. **DELETE policy returns 409 if live keys exist — shred
  first, then delete.**

---

## Security & Auth Patterns (permanent law)

These decisions were made during a security audit. Do not regress them.

### First-user admin assignment
Never pre-assign `tenant_admin` at registration time based on a user-count check — that pattern has a TOCTOU race. Instead:
- Always register users as `tenant_user`.
- Call `ensureAtLeastOneTenantAdmin(db, userId)` after every successful registration and OAuth sign-up. It promotes the earliest user (by `created_at`) to `tenant_admin` if no admin yet exists.
- This is safe because `ensureAtLeastOneTenantAdmin` is a safe-default function (does nothing when an admin already exists).

### OAuth linked account deduplication
When an OAuth callback fires for a provider identity that is already linked, **never call `createOAuthLinkedAccount`** — it mutates the `linked_at` timestamp and changes the row `id`.
- When `existingLinked` is truthy: call `updateOAuthAccountLastUsed(userId, provider)`.
- When `existingLinked` is null: call `createOAuthLinkedAccount(...)`.

### Native OAuth redirect format: URL fragments
The server delivers the bearer token to the mobile app via a URL **fragment** (`#token=...&csrfToken=...`), not a query string. Fragments are not transmitted in HTTP requests, so the token does not appear in server logs or `Referer` headers.
- `buildNativeOAuthRedirect` and `buildNativeOAuthError` use `#` in `apps/geneweave/src/oauth-native.ts`.
- `parseNativeOAuthCallback` in the mobile client reads the fragment first, falls back to query string for backward compat during rolling deploys.
- Do not regress this to `?` query-string delivery.

### Migration code placement
Migration code (schema changes, seed inserts) belongs **only** inside migration batch functions. Never embed schema changes or seed data in shared helpers like `safeExec`. `safeExec` is a DDL catch-ignoring wrapper — adding non-DDL code inside it causes that code to fire on every `safeExec` call, potentially hundreds of times per boot.

### Dev-only API fields in production
API fields that accept secrets for development/testing (e.g., `privateKeyPemDev` in the BYOK endpoint) must be **rejected in production** (`process.env['NODE_ENV'] === 'production'`). Guard at the route level before reaching any service/DB call. Return HTTP 400 with a clear message.

### Break-glass request immutability
`requested_by` and `reason` on `tenant_break_glass_request` rows are **write-once** — they must not appear in the `allowed` array for `updateBreakGlassRequest`. Only workflow/status fields (`status`, `customer_approver`, `approved_at`, `expires_at`, `consume_count`, `denial_reason`) may be updated after creation.

### Admin route isolation
SV and Kaggle routes must be registered on `adminRouter`, not the bare `router`. `adminRouter` wraps every handler with `ensurePermission(auth, permissionForAdminRoute(path, method))`. Registering on `router` bypasses RBAC entirely.

### Guardrail unknown-type default
Unknown or unimplemented guardrail types must return `warn`, **not `allow`**. A silently-allowed misconfigured guardrail is invisible to operators. `warn` surfaces the issue in escalation reports and can trigger approval workflows.

### Escalation `require-approval` decision
An escalation policy with `onEscalate === 'require-approval'` produces decision `warn` (hold pending human review), not `deny` (hard block). The caller must hold the turn and await task completion, not immediately reject it. `block` policies produce `deny`.

---

## Known pre-existing issues (do not fix unless asked)

Pre-existing tsc errors in `examples/86, 92, 95, 97` and
`comprehensive-live-agents-workflow.ts` use older live-agents/workflow API surfaces.
Building `apps/geneweave` + the relevant packages is clean.