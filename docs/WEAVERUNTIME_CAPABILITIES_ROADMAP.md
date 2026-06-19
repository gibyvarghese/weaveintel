# WeaveRuntime Capabilities Roadmap
> Audit date: 2026-06-20 | Baseline commit: `1dab467`

## Purpose

This document captures a full gap analysis of `WeaveRuntime` — the cross-cutting ambient dependency-injection container used by every subsystem in WeaveIntel — cross-referenced against mid-2026 industry standards for production AI agent runtimes. It then defines a phased implementation plan with explicit wiring requirements for `geneWeave`, acceptance tests, and a GitHub commit gate between every phase.

---

## Part 1 — Current State of WeaveRuntime

### 1.1 The Eight Slots Today

`WeaveRuntime` is defined in `packages/core/src/runtime.ts`. At boot in `apps/geneweave/src/index.ts`, six of the eight slots are populated:

| Slot | Type | Wired at boot? | Where |
|---|---|---|---|
| `egress` | `RuntimeEgressSlot` | ✅ auto | `weaveRuntime()` default |
| `tracer` | `Tracer` | ✅ | `weaveConsoleTracer()` |
| `secrets` | `SecretResolver` | ✅ | `envSecretResolver()` |
| `audit` | `AuditLogger` | ✅ auto | `createDurableAuditLogger` when persistence present |
| `persistence` | `RuntimePersistenceSlot` | ✅ | `weaveSqlitePersistence` |
| `guardrails` | `RuntimeGuardrailsSlot` | ✅ partial | `geneweaveGuardrailsSlot()` — **no `checkInput`** |
| `encryption` | `RuntimeEncryptionSlot` | ✅ partial | `geneweaveEncryptionSlot()` — `getManager()` returns `unknown` |
| `resilience` | `RuntimeResilienceSlot` | ❌ **NEVER WIRED** | — |

### 1.2 Packages Operating Outside the Runtime

The following packages have substantial production-grade functionality that **never connects to any `WeaveRuntime` slot**:

| Package | Key exports | Current integration | Gap |
|---|---|---|---|
| `@weaveintel/resilience` | `createCircuitBreaker`, `createResilientCallable`, `createTokenBucket`, `createLatencyTracker` | `db-resilience-observer.ts` uses process-global `getDefaultSignalBus()` | `RuntimeCapabilities.Resilience` never set; circuit state invisible to any consumer through DI |
| `@weaveintel/routing` | `SmartModelRouter`, `ModelHealthTracker`, `ModelScorer` | Constructed privately inside `ChatEngine` and `generic-supervisor-boot.ts` | Two separate health trackers; live-agent 429s don't reach chat engine |
| `@weaveintel/cache` | `weaveInMemoryCacheStore`, `weaveSemanticCache` | Private `ChatEngine` field | Evaporates on restart; invisible to tools/agents |
| `@weaveintel/cost-governor` | `weaveCostGovernor`, `createDurableCostLedger`, L1–L9 levers | Wired in workflow engine via `opts.runtime`; chat/live-agents do it ad-hoc | No shared cost gate; no `RuntimeCapabilities.CostGovernor` |
| `@weaveintel/memory` | `weaveSqliteMemoryStore`, `weaveSemanticMemory`, `weaveWorkingMemory` | Direct DB adapter calls | No `runtime.memory`; tools can't write memory without full DB injection |
| `@weaveintel/identity` | `IdentityContext`, RBAC, delegation chains, `evaluateAccess` | Raw `ctx.userId`/`ctx.tenantId` strings | No typed permission sets or delegation validation at tool invocation |
| `@weaveintel/compliance` | `createDurableConsentManager`, residency engine, legal hold | Constructed per-call-site (2 instances in `chat.ts` + `server.ts`) | No single authoritative compliance state machine |
| `@weaveintel/tenancy` | `createDurableBudgetEnforcer`, `EntitlementPolicy`, `TenantCapabilityMap` | DB rows read per request | No runtime slot |
| `@weaveintel/notifications` | `createNotificationDispatcher`, channel adapters | `notifications-wiring.ts` (standalone) | Not connected to audit or persistence slots |

### 1.3 Partially Implemented Slots

**`guardrails`** — `checkToolCall` and `checkOutput` are present; **`checkInput` is missing**. User messages enter the LLM pipeline without a pre-flight guardrail gate.

**`encryption`** — `getManager()` returns `unknown`. Every consumer must cast to `TenantKeyManager`. No `isActive()`, no key rotation event hooks, no `hardShred` API.

**`audit`** — `AuditEntry` has no `correlationId` / `spanId`. Audit rows cannot be joined to OTel traces. Redacting wrapper only scrubs `entry.details`; `entry.resource` and `entry.action` can carry PII.

### 1.4 Live-Agents-Runtime Specific Gaps

- **Runtime never reaches tick contexts** — `startGenericSupervisorIfEnabled` has no `runtime?` field; every tick has `ctx.runtime === undefined`
- **No interrupt/cancellation propagation** — `PATCH /api/admin/live-runs/:id { status: 'CANCELLED' }` never injects an `AbortSignal` into the in-flight handler
- **No A2A handler** — `createDefaultHandlerRegistry()` has `agentic.react`, `deterministic.forward`, `deterministic.template`, `human.approval` — no A2A inbound or outbound
- **No real-time event streaming** — clients must poll `live_run_events`; no SSE fan-out from supervisor
- **No durable checkpointing** — agents can't sleep to a future timestamp and survive process restarts
- **No multi-modal content handling** — `ImageContent`/`AudioContent`/`FileContent` are defined in core but no handler adapts them in the tick loop
- **`WeaveLiveMeshFromDbOptions` has no `runtime?`** — the package never threads runtime into any mesh-level construct

---

## Part 2 — Mid-2026 Technology Landscape Comparison

### 2.1 Protocol Standards (June 2026)

**A2A (Agent-to-Agent)** — Contributed to the Linux Foundation in June 2025, now at 150+ supporting organizations (Google, Microsoft, AWS, Salesforce, SAP, IBM). Defines `AgentCard`, `Task`, HTTP + SSE + JSON-RPC 2.0 transport. **WeaveIntel has the full A2A contract in `@weaveintel/core` but no handler in `live-agents-runtime`** — this is the most critical protocol gap.

**MCP (Model Context Protocol)** — 97 million monthly SDK downloads, 81k+ GitHub stars, supported by every major AI vendor. Key 2026 additions: async `Tasks` primitive for long-running operations, Streamable HTTP replacing SSE as preferred transport, OAuth 2.1 as standard auth, `.well-known` discoverability. WeaveIntel's `@weaveintel/mcp-server` and `@weaveintel/mcp-client` exist but don't fully leverage 2026 features (async tasks, streamable HTTP).

### 2.2 Observability (OTel GenAI Semantic Conventions)

**OpenTelemetry GenAI Semantic Conventions** are the 2026 standard for LLM observability — LLM client spans, agent spans, events (prompt/completion content capture), and metrics (token counts, latency, cost). WeaveIntel currently emits `weaveConsoleTracer()` — a bare console tracer. This should be the full OTel SDK with the GenAI semantic conventions. **`audit` entries lack `spanId`** to join to traces. The `OTEL_SEMCONV_STABILITY_OPT_IN` env var enables dual-emission during migration.

### 2.3 Resilience Patterns for AI Agents

Mid-2026 research shows multi-agent systems fail at **41–86.7% rates in production without deliberate fault tolerance**. Production-grade AI resilience requires:
- **Circuit breakers** (3-state: CLOSED/OPEN/HALF-OPEN) — WeaveIntel has these in `@weaveintel/resilience` but they are unwired from the runtime
- **Bulkhead isolation** — failure domains per tenant/model/tool — partially present but not runtime-managed
- **Fallback chains** — route to cached responses or alternative models on open circuit — in place in chat routing but siloed
- **Self-healing state machines** — `HALF-OPEN` probe + automatic `CLOSED` on recovery — exists in the package, not DI-accessible

The `RuntimeResilienceSlot` interface today only exposes `emit(event)`. The interface needs to expose `getState(endpoint)`, `has(endpoint)`, and latency percentile queries so consumers can make routing decisions through the DI contract rather than importing the global singleton.

### 2.4 Cost Governance

Mid-2026 enterprise standard is **hierarchical budget with four-tier attribution**: platform → tenant → team/user → task. Token attribution records every token (prompt, tool, memory, response) against the specific tenant/user/task. WeaveIntel's `@weaveintel/cost-governor` has the levers and durable ledger but the budget gate is never called from a shared runtime slot — chat and live-agents each compose it ad-hoc.

### 2.5 Compliance & Data Governance

2026 GDPR enforcement focuses on: explicit consent before processing (not just data storage), data residency with EEA adequacy standards, right-to-erasure mechanisms, and retention policy with defined timelines. ISO 42001 (AI-specific governance) is increasingly expected alongside SOC 2 Type II and ISO 27001. WeaveIntel's compliance package has all primitives but they are scattered across 2+ call sites with no shared `RuntimeComplianceSlot`.

### 2.6 Memory Architecture

2026 production memory systems have moved beyond pure vector search to **multi-signal retrieval**: semantic similarity + BM25 keyword + entity matching, all normalized and fused. The standard four layers are: working (active context), episodic (past interactions), semantic (factual/entity knowledge), and organizational/procedural (rules, skills, company knowledge). WeaveIntel implements all four types in `@weaveintel/memory` and the DB schema, but there is no `RuntimeMemorySlot` — tools and agents access memory through a direct DB adapter injection.

### 2.7 Identity & RBAC

2026 best practice is typed `IdentityContext` objects (not raw user-id strings) carrying permission sets, delegation chain, and tenant entitlements at every invocation point. WeaveIntel's `@weaveintel/identity` has `IdentityContext`, `evaluateAccess`, and delegation chain — none of it is ambient on the runtime.

---

## Part 3 — Gap Summary: Keep, Add, Rethink

| Item | Verdict | Reason |
|---|---|---|
| `egress` slot | ✅ Keep as-is | Hardened fetch is the 2026 standard for SSRF-safe egress |
| `tracer` slot | 🔧 Upgrade | Replace `weaveConsoleTracer` with OTel SDK + GenAI semantic conventions |
| `secrets` slot | ✅ Keep as-is | Env resolver + vault chain is correct pattern |
| `audit` slot | 🔧 Upgrade | Add `spanId` / `correlationId` to `AuditEntry`; scrub all fields, not just `details` |
| `persistence` slot | ✅ Keep as-is | Well-designed; KV + document + vector is correct abstraction |
| `resilience` slot | ❌ Wire now | `RuntimeResilienceSlot` exists but is never populated; widen interface |
| `guardrails` slot | 🔧 Add `checkInput` | Pre-LLM input gate is missing |
| `encryption` slot | 🔧 Type tighten | `getManager()` → typed `TenantKeyManager`; add `isActive()`, `hardShred()` |
| `runtime.routing` | ➕ New slot | Shared `ModelRouter` + `ModelHealthTracker` |
| `runtime.cost` | ➕ New slot | Shared `CostGovernor` with durable ledger and budget gate |
| `runtime.memory` | ➕ New slot | Ambient `MemoryStore` accessible to tools and agents |
| `runtime.compliance` | ➕ New slot | Aggregated consent + residency + retention + legal hold |
| `runtime.identity` | ➕ New slot | Typed `IdentityContext` + RBAC policy |
| A2A handler in live-agents | ➕ New | Protocol is Linux Foundation standard; WeaveIntel has the types |
| Durable checkpointing in live-agents | ➕ New | Agents that sleep across restarts are 2026 production requirement |
| Real-time SSE from supervisor | ➕ New | Polling `live_run_events` is not production-grade for streaming UIs |
| OTel GenAI spans | ➕ New | Standard for every LLM observability platform in 2026 |
| Multi-modal in `agentic.react` | ➕ New | Image/audio/file content parts are in core but not handled |
| `WeaveLiveMeshFromDbOptions.runtime` | 🔧 Wire | Package-level gap; blocks all runtime DI into mesh layer |

---

## Part 4 — Phased Implementation Plan

> **Rule for every phase:**
> 1. Implement the changes in the packages
> 2. Wire it into `geneWeave` (`apps/geneweave/src/`)
> 3. Update or add at least one usage example (in `apps/geneweave/src/` or `docs/`)
> 4. All existing tests must pass (`npx vitest run` — 0 regressions)
> 5. New unit/integration tests must cover the feature
> 6. `tsc --build` must be clean
> 7. Commit and push to GitHub before beginning the next phase

---

### Phase 0 — Runtime Foundation (Resilience + Live-Agent Threading)
> **Priority: P0 | Estimated effort: 3–4 days**

These are blocking gaps that affect every subsequent phase.

#### 0.1 Wire the `resilience` slot

**Files to change:**
- `packages/core/src/runtime.ts` — Widen `RuntimeResilienceSlot`:
  ```typescript
  export interface RuntimeResilienceSlot {
    emit(event: ResilienceEvent): void;
    getState(endpoint: string): 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'UNKNOWN';
    getLatencyP50(endpoint: string): number | null;
    getLatencyP95(endpoint: string): number | null;
  }
  ```
- `packages/resilience/src/index.ts` — Export `createRuntimeResilienceAdapter(bus)` that wraps `ResilienceSignalBus` and implements the widened slot interface
- `apps/geneweave/src/index.ts` — Import `createRuntimeResilienceAdapter`, construct after `createResilienceSignalBus()`, pass to `weaveRuntime({ resilience: adapter })`
- `apps/geneweave/src/db-resilience-observer.ts` — Remove the `getDefaultSignalBus()` import; accept `runtime.resilience` instead

**geneWeave wiring:** `index.ts` → `createGeneWeave()` → `weaveRuntime({ ..., resilience: resilienceAdapter })`

**Tests:**
- Unit: `RuntimeCapabilities.Resilience` is now set after boot
- Unit: `runtime.resilience.getState('anthropic')` returns `'CLOSED'` when no events emitted
- Integration: Inject 5 failures → circuit trips to `'OPEN'` → query through `runtime.resilience.getState()`

#### 0.2 Thread `WeaveRuntime` through live-agent supervisor

**Files to change:**
- `apps/geneweave/src/live-agents/generic-supervisor-boot.ts` — Add `runtime?: WeaveRuntime` to `StartGenericSupervisorOptions`; thread into every `createTickContext()` call
- `packages/live-agents-runtime/src/weave-live-mesh-from-db.ts` — Add `runtime?: WeaveRuntime` to `WeaveLiveMeshFromDbOptions`; pass to heartbeat supervisor
- `packages/live-agents-runtime/src/heartbeat-supervisor.ts` — Verify propagation to tick contexts (already accepts `runtime?` — confirm it flows through)

**geneWeave wiring:** `startGenericSupervisorIfEnabled({ ..., runtime })` — pass the same `WeaveRuntime` instance from `createGeneWeave()`

**Tests:**
- Integration: Start a supervisor tick; assert `ctx.runtime !== undefined` inside tick handler
- Integration: `ctx.runtime.has(RuntimeCapabilities.Resilience)` is `true` in tick

#### 0.3 Add `checkInput` to guardrails slot

**Files to change:**
- `packages/core/src/runtime.ts` — Add `checkInput?(input: string, ctx: ExecutionContext): Promise<GuardrailDecision>` to `RuntimeGuardrailsSlot`
- `apps/geneweave/src/guardrails-slot.ts` — Implement using existing `evaluateGuardrails()` for input content
- `apps/geneweave/src/chat-send-message.ts` and `chat-stream-message.ts` — Call `deps.config.runtime?.guardrails?.checkInput(content, ctx)` before the model call

**Tests:**
- Unit: `checkInput` with a PII-heavy string triggers a `warn` decision
- Unit: `checkInput` with clean input returns `allow`
- Regression: All 636 existing tests still pass

#### 0.4 Tighten encryption slot types

**Files to change:**
- `packages/core/src/runtime.ts` — Change `RuntimeEncryptionSlot.getManager(): unknown` → `getManager(): TenantKeyManager | null`; add `isActive(): boolean`; add `hardShred(tenantId: string): Promise<void>`
- `apps/geneweave/src/encryption-slot.ts` — Implement `isActive()` and `hardShred()`
- All consumers of `getManager()` — Remove manual casts

**Tests:**
- Unit: `runtime.encryption.isActive()` returns `false` when `VAULT_KEY` absent
- Unit: `hardShred('test-tenant')` resolves without error in test environment

**GitHub gate:** `git push` after all Phase 0 tests green + `tsc` clean.

---

### Phase 1 — Observability (OTel GenAI Semantic Conventions)
> **Priority: P0 | Estimated effort: 3–5 days**

#### 1.1 Replace console tracer with OTel SDK

**Files to change:**
- `packages/observability/src/` — Create `createOtelTracer(opts: { serviceName, endpoint? })` that returns a `Tracer` using `@opentelemetry/sdk-node` with GenAI semantic conventions attributes:
  - `gen_ai.system` (e.g., `'anthropic'`)
  - `gen_ai.request.model`
  - `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
  - `gen_ai.response.finish_reasons`
  - `gen_ai.operation.name` (`'chat'`, `'tool_call'`, `'embedding'`)
- `apps/geneweave/src/index.ts` — Replace `weaveConsoleTracer()` with `createOtelTracer({ serviceName: 'geneweave' })` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; fall back to console tracer

#### 1.2 Add `spanId` / `correlationId` to audit entries

**Files to change:**
- `packages/core/src/runtime.ts` — Add optional `spanId?: string` and `correlationId?: string` to `AuditEntry`
- `apps/geneweave/src/chat-send-message.ts` and `chat-stream-message.ts` — Pass `ctx.traceId` / active span ID when writing audit entries
- `packages/core/src/runtime.ts` — Widen redacting wrapper to scrub all string fields, not just `details`

#### 1.3 LLM span instrumentation in chat paths

**Files to change:**
- `apps/geneweave/src/chat-send-message.ts` — Wrap every model `generate()` call in an OTel span with GenAI attributes
- `apps/geneweave/src/chat-stream-message.ts` — Same for stream path
- `apps/geneweave/src/chat-trace-utils.ts` — Extend `recordTraceSpans` to emit OTel spans alongside existing DB spans

**geneWeave wiring:** `OTEL_EXPORTER_OTLP_ENDPOINT` env var controls OTel endpoint; `OTEL_SERVICE_NAME` overrides default `'geneweave'`

**Example to add:** `docs/observability-otel-setup.md` — step-by-step for connecting to Grafana Cloud / Honeycomb / Jaeger

**Tests:**
- Unit: OTel span emitted with `gen_ai.request.model` attribute on `sendMessage`
- Unit: `AuditEntry.spanId` is set when tracer is active
- Regression: All tests pass

**GitHub gate:** `git push` after Phase 1 green.

---

### Phase 2 — Shared Routing Slot
> **Priority: P1 | Estimated effort: 2–3 days**

#### 2.1 Define `RuntimeRoutingSlot`

**Files to change:**
- `packages/core/src/runtime.ts` — Add:
  ```typescript
  export interface RuntimeRoutingSlot {
    route(opts: RoutingRequest): Promise<RoutingDecision | null>;
    recordOutcome(modelId: string, providerId: string, latencyMs: number, success: boolean, error?: string): void;
    listHealth(): ModelHealth[];
    getBlockedProviders(): Set<string>;
  }
  export const RuntimeCapabilities = {
    // existing...
    Routing: 'routing',
  } as const;
  ```
- `packages/routing/src/index.ts` — Export `createRuntimeRoutingAdapter(router, tracker)` implementing the slot interface

#### 2.2 Wire in geneWeave

**Files to change:**
- `apps/geneweave/src/index.ts` — Construct one shared `SmartModelRouter` + `ModelHealthTracker`; create adapter; pass to `weaveRuntime({ ..., routing: routingAdapter })`
- `apps/geneweave/src/chat.ts` — Replace `this.healthTracker` and local router construction with `config.runtime?.routing ?? localFallback`
- `apps/geneweave/src/live-agents/generic-supervisor-boot.ts` — Use `runtime.routing.recordOutcome(...)` when recording model latency in supervisor ticks

**Tests:**
- Unit: `runtime.has(RuntimeCapabilities.Routing)` is `true`
- Integration: Record a `success=false` outcome from the supervisor path; assert it appears in `runtime.routing.listHealth()`
- Regression: Routing tests in `packages/routing/src/` all pass

**GitHub gate:** `git push` after Phase 2 green.

---

### Phase 3 — Shared Cost Governor Slot
> **Priority: P1 | Estimated effort: 3–4 days**

#### 3.1 Define `RuntimeCostSlot`

**Files to change:**
- `packages/core/src/runtime.ts` — Add:
  ```typescript
  export interface RuntimeCostSlot {
    gate(opts: { userId: string; tenantId: string | null; estimatedTokens: number; model: string }): Promise<{ allowed: boolean; reason?: string }>;
    record(opts: { userId: string; tenantId: string | null; tokens: { prompt: number; completion: number }; model: string; provider: string; cost: number }): Promise<void>;
    getBudgetStatus(tenantId: string): Promise<{ used: number; limit: number | null; period: string }>;
  }
  export const RuntimeCapabilities = {
    // existing...
    Cost: 'cost',
  } as const;
  ```
- `packages/cost-governor/src/index.ts` — Export `createRuntimeCostAdapter(governor, ledger)` implementing the slot interface

#### 3.2 Wire in geneWeave

**Files to change:**
- `apps/geneweave/src/index.ts` — Instantiate shared cost governor + durable ledger; pass to `weaveRuntime({ ..., cost: costAdapter })`
- `apps/geneweave/src/chat-send-message.ts` — Call `runtime?.cost?.gate(...)` before model call; fail with `402` when denied
- `apps/geneweave/src/chat-stream-message.ts` — Same pre-flight gate
- `apps/geneweave/src/chat-send-message.ts` and `chat-stream-message.ts` — Call `runtime?.cost?.record(...)` after model response instead of raw `db.recordMetric`
- `apps/geneweave/src/live-agents/generic-supervisor-boot.ts` — Call `runtime.cost.gate(...)` at tick start

**Tests:**
- Unit: `gate()` returns `{ allowed: false }` when tenant budget is 0
- Unit: `record()` increments `getBudgetStatus().used`
- Integration: Chat message fails with structured error when budget exceeded
- Regression: All cost-governor package tests pass

**GitHub gate:** `git push` after Phase 3 green.

---

### Phase 4 — A2A Protocol + Live-Agent Cancellation
> **Priority: P1 | Estimated effort: 4–6 days**

#### 4.1 A2A handler in live-agents-runtime

**Files to change:**
- `packages/live-agents-runtime/src/handlers/a2a-inbound.ts` (NEW) — Handler kind `'a2a.inbound'`:
  - Accepts `A2ATask` from wire
  - Maps to internal `ExecutionContext` with `runtime`
  - Emits `A2ATask` updates back through `InternalA2ABus`
- `packages/live-agents-runtime/src/handlers/a2a-outbound.ts` (NEW) — Enables `agentic.react` to delegate subtasks to remote agents via A2A; wraps outbound as `A2ATask` with status polling
- `packages/live-agents-runtime/src/handler-registry.ts` — Register both new handlers in `createDefaultHandlerRegistry()`
- `packages/live-agents-runtime/src/index.ts` — Export A2A adapter and `AgentCard` builder helper

**geneWeave wiring:**
- `apps/geneweave/src/server.ts` — Add `GET /.well-known/agent.json` route serving an `AgentCard` generated from registered meshes and their capabilities
- `apps/geneweave/src/routes/a2a.ts` (NEW) — `POST /api/a2a/tasks` receiver wired to `a2a.inbound` handler

**Example to add:** `docs/a2a-agent-delegation.md` — walkthrough of mesh A delegating a subtask to mesh B via A2A

**Tests:**
- Unit: `a2a.inbound` handler maps `A2ATask` to internal tick and returns status update
- Unit: `AgentCard` served at `/.well-known/agent.json` contains correct capability entries
- Integration: End-to-end A2A task submission → completion → status poll

#### 4.2 Live-agent cancellation via `AbortSignal`

**Files to change:**
- `packages/live-agents-runtime/src/heartbeat-supervisor.ts` — Accept `abortSignal?: AbortSignal` in tick options; check at tick boundary; propagate to `ctx.deadline`
- `packages/live-agents-runtime/src/run-bridge.ts` — Add `cancelRun(runId: string): void` that triggers the `AbortSignal` for in-flight ticks of that run
- `apps/geneweave/src/routes/live-agents.ts` — When `PATCH /:id/stop` is called, also invoke `runBridge.cancelRun(id)` in addition to DB update
- `apps/geneweave/src/admin/api/live-runtime-runs.ts` — On `PATCH /:id { status: 'CANCELLED' }`, invoke `runBridge.cancelRun(id)`

**Tests:**
- Integration: PATCH a running agent to `stopped`; assert tick loop terminates before natural completion
- Unit: `AbortSignal` propagated from `cancelRun()` to active tick context

#### 4.3 Real-time SSE event streaming from supervisor

**Files to change:**
- `packages/live-agents-runtime/src/heartbeat-supervisor.ts` — Add `onEvent?: (runId: string, event: LiveRunEvent) => void` callback
- `apps/geneweave/src/routes/admin-live-run-stream.ts` (NEW) — `GET /api/admin/live-runs/:id/stream` — SSE endpoint that subscribes to supervisor `onEvent` and fans out to connected clients
- `apps/geneweave/src/server.ts` — Register the new SSE route

**Tests:**
- Integration: Start a run; connect SSE client; assert events arrive without polling DB
- Unit: `onEvent` is called for each step completion

**GitHub gate:** `git push` after Phase 4 green.

---

### Phase 5 — Memory Slot + Multi-Signal Retrieval
> **Priority: P1–P2 | Estimated effort: 3–4 days**

#### 5.1 Define `RuntimeMemorySlot`

**Files to change:**
- `packages/core/src/runtime.ts` — Add:
  ```typescript
  export interface RuntimeMemorySlot {
    semantic: SemanticMemoryStore;
    episodic: EpisodicMemoryStore;
    working: WorkingMemoryStore;
    consolidate(userId: string): Promise<void>;
  }
  export const RuntimeCapabilities = {
    // existing...
    Memory: 'memory',
  } as const;
  ```
- `packages/memory/src/index.ts` — Export `createRuntimeMemoryAdapter(stores)` implementing the slot

#### 5.2 Multi-signal retrieval

**Files to change:**
- `packages/memory/src/retrieval.ts` (NEW) — `fusedMemorySearch(userId, query, opts)`:
  - Runs semantic similarity (vector), BM25 keyword, and entity-match in parallel via `Promise.all`
  - Normalizes scores to [0,1], weighted sum, top-K results
- `apps/geneweave/src/chat-memory-utils.ts` — Replace `buildMemoryContext` with `fusedMemorySearch` when `runtime.memory` is present

#### 5.3 Wire in geneWeave

**Files to change:**
- `apps/geneweave/src/index.ts` — Construct `RuntimeMemorySlot` from existing `weaveSqliteMemoryStore` instances; pass to `weaveRuntime({ ..., memory: memoryAdapter })`
- `apps/geneweave/src/chat.ts` — Remove direct `this.db.listSemanticMemory(...)` calls in memory-context building; use `runtime.memory.semantic.query(...)` instead
- `apps/geneweave/src/live-agents/generic-supervisor-boot.ts` — Expose `ctx.runtime.memory` to agent tools that need to write episodic memory

**Tests:**
- Unit: `fusedMemorySearch` returns results from all three signals when they agree
- Unit: BM25 keyword match surfaces results that pure semantic search misses
- Integration: Agent tick writes an episodic event; next tick retrieves it via `runtime.memory.episodic.list(userId)`
- Regression: All existing memory-related tests pass

**GitHub gate:** `git push` after Phase 5 green.

---

### Phase 6 — Compliance Slot + Identity Slot
> **Priority: P2 | Estimated effort: 4–5 days**

#### 6.1 Define `RuntimeComplianceSlot`

**Files to change:**
- `packages/core/src/runtime.ts` — Add:
  ```typescript
  export interface RuntimeComplianceSlot {
    consent: DurableConsentManager;
    residency: DurableResidencyEngine;
    isAllowed(userId: string, purpose: ConsentPurpose): Promise<boolean>;
    canProcess(tenantId: string, dataCategory: string, targetRegion: string): Promise<boolean>;
    scheduleRetention(entityId: string, tier: RetentionTier): Promise<void>;
    requestExport(userId: string): Promise<GdprExportArchive>;
    requestErasure(userId: string): Promise<ErasureSummary>;
  }
  ```
- `packages/compliance/src/index.ts` — Export `createRuntimeComplianceAdapter(opts)` implementing the slot; replaces the two ad-hoc `createDurableConsentManager` call sites

#### 6.2 Define `RuntimeIdentitySlot`

**Files to change:**
- `packages/core/src/runtime.ts` — Add:
  ```typescript
  export interface RuntimeIdentitySlot {
    resolve(userId: string, tenantId: string | null): Promise<IdentityContext>;
    evaluate(ctx: IdentityContext, resource: string, action: string): Promise<AccessDecision>;
    validateDelegation(chain: DelegationChain): Promise<boolean>;
  }
  ```
- `packages/identity/src/index.ts` — Export `createRuntimeIdentityAdapter(opts)` implementing the slot

#### 6.3 Wire both in geneWeave

**Files to change:**
- `apps/geneweave/src/index.ts` — Construct adapters; pass to `weaveRuntime({ ..., compliance: complianceAdapter, identity: identityAdapter })`
- `apps/geneweave/src/chat-send-message.ts` / `chat-stream-message.ts` — Replace ad-hoc consent checks with `runtime.compliance.isAllowed(userId, 'analytics')`
- `apps/geneweave/src/chat.ts` — Replace ad-hoc consent checks with `runtime.compliance.isAllowed(userId, 'personalization')`
- `apps/geneweave/src/routes/me-compliance.ts` — Use `runtime.compliance.requestExport(userId)` and `requestErasure(userId)`
- `apps/geneweave/src/routes/` — Add `runtime.identity.resolve()` to auth middleware; pass typed `IdentityContext` in `req.identity` (or `ctx.identity`)

**Tests:**
- Unit: `runtime.compliance.isAllowed(userId, 'analytics')` returns `true` for absent record (permit-if-no-record)
- Unit: `runtime.identity.evaluate()` denies resource access for non-admin persona
- Integration: GDPR export route uses single compliance adapter; all 4 memory tables included
- Regression: All existing compliance tests pass

**GitHub gate:** `git push` after Phase 6 green.

---

### Phase 7 — Cache Slot + Durable Checkpointing
> **Priority: P2 | Estimated effort: 3–4 days**

#### 7.1 Define `RuntimeCacheSlot`

**Files to change:**
- `packages/core/src/runtime.ts` — Add:
  ```typescript
  export interface RuntimeCacheSlot {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown, ttlMs: number): Promise<void>;
    invalidate(key: string): Promise<void>;
    semanticGet?(embedding: number[], threshold: number): Promise<unknown>;
  }
  ```
- `packages/cache/src/index.ts` — Export `createRuntimeCacheAdapter(store, semanticCache?)` implementing the slot
- `apps/geneweave/src/index.ts` — Wire the shared in-memory (or Redis-backed) cache into `weaveRuntime({ ..., cache: cacheAdapter })`
- `apps/geneweave/src/chat.ts` — Use `config.runtime?.cache` instead of `this.responseCache` private field

#### 7.2 Durable checkpointing for live-agent ticks

**Files to change:**
- `packages/live-agents-runtime/src/checkpoint-store.ts` (NEW) — `CheckpointStore` interface backed by `runtime.persistence.kv`:
  ```typescript
  interface CheckpointStore {
    save(runId: string, stepIndex: number, state: unknown): Promise<void>;
    load(runId: string): Promise<{ stepIndex: number; state: unknown } | null>;
    clear(runId: string): Promise<void>;
  }
  ```
- `packages/live-agents-runtime/src/handlers/agentic-react.ts` — After each step, call `checkpointStore.save(runId, stepIndex, state)`; on boot, call `checkpointStore.load(runId)` to resume interrupted runs
- `apps/geneweave/src/live-agents/generic-supervisor-boot.ts` — Wire `checkpointStore` from `runtime.persistence.kv`

#### 7.3 Multi-modal content in `agentic.react`

**Files to change:**
- `packages/live-agents-runtime/src/handlers/agentic-react.ts` — Detect `ContentPart` type in agent inbox; route `ImageContent` to vision-capable model, `AudioContent` to voice model, `FileContent` through sandbox extraction before adding to context
- `packages/core/src/runtime.ts` — Add `supportsMultiModal(): boolean` to `RuntimeRoutingSlot` (from Phase 2)

**Tests:**
- Unit: Cache adapter `get` returns `null` on miss
- Unit: `semanticGet` returns cached response for semantically equivalent query above threshold
- Integration: Resume an interrupted agent run from checkpoint; assert it starts from the last saved step
- Unit: `agentic.react` handler correctly routes `ImageContent` to a vision model call

**GitHub gate:** `git push` after Phase 7 green.

---

## Part 5 — Summary Table

| Phase | What | Key new slots / features | Effort |
|---|---|---|---|
| 0 | Runtime foundation | Wire `resilience`, `checkInput` guardrail, type-tighten `encryption`, thread runtime to live-agents | 3–4 days |
| 1 | OTel Observability | OTel GenAI spans, `spanId` in audit entries, structured LLM spans | 3–5 days |
| 2 | Routing slot | `RuntimeRoutingSlot`, shared `ModelHealthTracker` across subsystems | 2–3 days |
| 3 | Cost slot | `RuntimeCostSlot`, pre-flight budget gate on all LLM calls | 3–4 days |
| 4 | A2A + Cancellation + SSE | A2A handler, `cancelRun` with `AbortSignal`, SSE supervisor events | 4–6 days |
| 5 | Memory slot | `RuntimeMemorySlot`, multi-signal retrieval (semantic + BM25 + entity) | 3–4 days |
| 6 | Compliance + Identity slots | Single `RuntimeComplianceSlot`, typed `RuntimeIdentitySlot` | 4–5 days |
| 7 | Cache slot + Checkpointing | `RuntimeCacheSlot`, durable agent checkpoints, multi-modal routing | 3–4 days |

**Total estimated effort: 25–35 engineering days**

---

## Part 6 — Testing Standards for Every Phase

Each phase must satisfy all of the following before the GitHub commit gate:

1. **`npx tsc --build`** — zero errors across all packages and apps
2. **`npx vitest run`** — zero regressions from baseline (currently 636/636 geneweave tests + 1 pre-existing workflow failure)
3. **New unit tests** — every new exported function/class has at least one unit test
4. **New integration tests** — every new runtime slot has at least one integration test that boots the actual `WeaveRuntime` (or a test double) and calls through the slot
5. **geneWeave wiring confirmed** — manual or automated check that the slot's `RuntimeCapabilities` flag is set after `createGeneWeave()` completes
6. **No console warnings from hook failures** — pre-commit hooks must pass cleanly

---

## Part 7 — GitHub Commit Convention

Each phase commit should follow this format:

```
feat(runtime): Phase N — <short description>

- <bullet 1>
- <bullet 2>
- <bullet 3>

Tests: X new unit, Y new integration, Z total passing
Breaking changes: none / <describe>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Push to `main` with `git push origin main` after each phase commit clears CI.

---

## References

- [Building Production-Ready AI Agents in 2026 — MLflow](https://mlflow.org/articles/building-production-ready-ai-agents-in-2026/)
- [AI Agent Protocol Ecosystem Map 2026: MCP, A2A, ACP, UCP](https://www.digitalapplied.com/blog/ai-agent-protocol-ecosystem-map-2026-mcp-a2a-acp-ucp)
- [OpenTelemetry GenAI Semantic Conventions — OTel Blog](https://opentelemetry.io/blog/2026/genai-observability/)
- [OpenTelemetry for AI Systems: LLM and Agent Observability — Uptrace](https://uptrace.dev/blog/opentelemetry-ai-systems)
- [Agent2Agent Protocol — Wikipedia](https://en.wikipedia.org/wiki/Agent2Agent)
- [Announcing the Agent2Agent Protocol — Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A Standard Takes Shape as Multi-Agent Systems Emerge](https://www.programming-helper.com/tech/agent-to-agent-protocol-2026-google-a2a-standard)
- [AI Agent Circuit Breakers: The Reliability Pattern Production Teams Are Missing — DEV Community](https://dev.to/waxell/ai-agent-circuit-breakers-the-reliability-pattern-production-teams-are-missing-5bpg)
- [Circuit Breaker Patterns for AI Agent Reliability — B.L. Hendricks](https://brandonlincolnhendricks.com/research/circuit-breaker-patterns-ai-agent-reliability)
- [State of AI Agent Memory 2026 — mem0.ai](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Agent Memory Architectures: Patterns and Trade-offs — Atlan](https://atlan.com/know/agent-memory-architectures/)
- [Token Attribution and Cost Governance for Multi-Tenant LLM Products — SoftwareSeni](https://www.softwareseni.com/token-attribution-and-cost-governance-for-multi-tenant-llm-products-in-production/)
- [GDPR Compliance in 2026: The Complete Guide — SecurePrivacy](https://secureprivacy.ai/blog/gdpr-compliance-2026)
- [2026 MCP Roadmap — Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [The Architecture of Agency: Deep Technical Guide to Agentic AI Systems in 2026 — Medium](https://medium.com/@nraman.n6/the-architecture-of-agency-a-deep-technical-guide-to-agentic-ai-systems-in-2026-9df63b37f6df)
- [Runtime Verification for AI Agents in 2026 — The Backend Developers](https://thebackenddevelopers.substack.com/p/runtime-verification-for-ai-agents)
- [Five Engineering Patterns to Secure Agentic AI in 2026 — Baytech Consulting](https://www.baytechconsulting.com/blog/engineering-patterns-secure-agentic-ai-2026)
