# Changelog

All notable changes to weaveIntel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Fabric Versioning](VERSIONING.md).

---

## [Unreleased]

### Live-Agents — DB-Driven Runtime Phase 3.5: Per-Agent Model Routing

- New `model_capability_json`, `model_routing_policy_key`, and
  `model_pinned_id` columns on `live_agents` and `live_agent_definitions`
  (additive M22 ALTERs + inline `CREATE TABLE` mirrors so fresh DBs and
  upgraded DBs converge). `LiveAgentRow` and `LiveAgentDefinitionRow`
  carry the new fields end-to-end through `createLiveAgent` /
  `createLiveAgentDefinition`.
- New runtime helper `resolveAgentModelSpec()` in
  `@weaveintel/live-agents-runtime` — pure-data, no `@weaveintel/routing`
  dependency. Returns `{ capabilitySpec, routingPolicyKey, pinnedId, source }`
  with the documented precedence (`pinned > capability > default`).
- New geneweave bridge `resolveLiveAgentModel(db, row, factory, opts)` in
  `apps/geneweave/src/live-agents/agent-model-resolver.ts` — turns the spec
  into a concrete `Model` via a pluggable `AgentModelFactory` so callers can
  delegate to `@weaveintel/routing` (or any other strategy) without coupling
  the bridge. Caches per `(agentId, runId)`. Best-effort audit:
  every successful resolution appends a `live_run_events` row of kind
  `model.resolved` with the full payload for replay/reproducibility.
- Admin tabs `live-agents` and `live-agent-definitions` gained the three
  new fields with model-facing labels (capability spec textarea hints at
  `@weaveintel/routing` resolution).
- New example `examples/85-agent-model-routing.ts` demonstrates all three
  resolution paths against the inbox-triage demo mesh and prints the
  resulting `live_run_events` audit trail.

### Live-Agents — DB-Driven Runtime Phase 2.5: LLM Loop Scaffold

- New `packages/live-agents/src/llm/` directory establishes the seam between
  the live-agents runtime and the underlying ReAct/tool-calling engine.
  Exports `runLiveReactLoop()`, `BudgetExhausted`, and the
  `LiveAgentBudget` / `LiveAgentRunStatus` / `ModelCapabilitySpec` types.
- `runLiveReactLoop()` is now the single LLM call site for live-agents.
  It enforces a per-run budget envelope (`maxSteps`, `maxToolCalls`,
  `maxTokens`, `maxWallMs`), normalises terminal status, and never throws
  under normal operation — error paths surface as `status: 'errored'` with
  a populated `error` field.
- `agentic-task-handler.ts` no longer imports from `@weaveintel/agents`
  directly; it delegates to the new scaffold so future phases can swap
  the engine, plug Phase 3.5 model resolution in front of the loop, or
  add streaming/pause/resume without touching handler code.

### Live-Agents — DB-Driven Runtime Phase 3: Tool Binder

- New `@weaveintel/live-agents-runtime` exports `resolveAgentToolCatalog()` —
  a DB-driven resolver that turns enabled `live_agent_tool_bindings` rows
  into `ToolCatalogRow`-shaped entries. Inline `mcp_server_url` bindings are
  synthesised into ad-hoc `source='mcp'` catalog rows so the existing tool
  factory path is reused.
- New geneweave bridge `buildToolRegistryForAgent(db, agentId, baseToolOptions)`
  in `apps/geneweave/src/live-agents/agent-tool-registry.ts` hands the
  resolved entries to the existing `createToolRegistry()` factory so all
  policy / credential / audit / rate-limit wiring is preserved end-to-end.
- Admin tab `live-agent-tool-bindings` field labels refined to mention
  Phase 3 binder semantics (capability scoping, runtime synthesis of inline
  MCP rows, soft-disable via `enabled=0`).
- `examples/84-agent-tool-binding.ts` — seeds two bindings (built-in catalog
  row + inline MCP url) and demonstrates the resulting per-agent
  `ToolRegistry`, plus a disabled-binding skip diagnostic.

### GeneWeave — Scientific Validation (sv:) Phases 7–9: UI, Evals, and Docs

#### Phase 7 — Three-View UI

- **`sv-submit-view.ts`** — Hypothesis submission form: title, statement textarea, comma-separated domain tags. Posts to `/api/sv/hypotheses`; on success transitions state to `live` view with the returned hypothesis ID.
- **`sv-live-view.ts`** — Real-time deliberation view. Opens two `EventSource` streams (`/events` + `/dialogue`) with `withCredentials`. Evidence panel shows agent ID, step, kind badge, and summary. Dialogue panel shows agent turns with dissent highlighting and round index. `verdict` SSE event transitions to `verdict` view. Status polling every 4 s as fallback. `MutationObserver` cleans up streams when the element is removed from DOM.
- **`sv-verdict-view.ts`** — Verdict display: verdict badge with colour-coded card, confidence interval bar, limitations text, sub-claims list (with claim type and testability score), evidence kind summary chips, and a `<a download>` bundle link. "New Hypothesis" button resets state to `submit` view.
- **`ui/index.ts`** — Barrel export for all three views.
- **`state.ts`** — Added `svView`, `svHypothesisId`, `svHypothesis`, `svVerdict` fields to the app state object.
- **`ui-client.ts`** — Added `'scientific-validation'` to `allowedViews`; added `else if (state.view === 'scientific-validation')` branch that routes to the correct SV sub-view based on `state.svView`.
- **`workspace-shell.ts`** — Added 🔬 **Validation** nav entry to the sidebar.

#### Phase 8 — Eval Corpus

- **`evals/corpus.json`** — 20 curated hypotheses: 5 known-true, 5 known-false, 5 ill-posed, 5 p-hacked. Each entry has `id`, `category`, `title`, `statement`, `domainTags`, `expectedVerdict`, and `rationale`.
- **`evals/run-corpus.ts`** — CLI runner that iterates all corpus entries, submits each to a live server, polls for verdict, and reports per-category pass/fail rates. Supports `--url`, `--apiKey`, `--timeout`, `--category`, `--dryRun` flags.

#### Phase 9 — Tests, Example, and Docs

- **`examples/35-scientific-validation.ts`** — Runnable example demonstrating submit, SSE streaming, verdict polling, bundle download, cancel, and reproduce. Requires a live server and model provider credentials.
- **`sv-ui.e2e.ts`** — 8 Playwright E2E tests: SV nav button visibility, form render, required-field validation, submission → live-view transition, live-view panel presence, cancel button, verdict view rendering, and bundle download link.
- **`docs/scientific-validation/feature-readme.md`** — Full feature documentation: API reference, SSE event shapes, bundle schema, DB tables, seed data, UI views, eval corpus usage, and test commands.
- **`README.md`** — Scientific Validation section extended with UI description, eval corpus usage, and link to feature-readme.

### @weaveintel/sandbox — Phase 1: Container Executor

- **`ContainerExecutor`** — New class (`packages/sandbox/src/executors/container/`) that gates every container run through an image allow-list, clamps resource limits to per-image ceilings, strips disallowed env keys, filters the network allow-list, and wraps each execution in an `@weaveintel/core` `Tracer` span with `cache=hit|miss` attribution.
- **`DockerRuntime`** — Real Docker-based `ContainerRuntime` with hardened security flags: `--rm`, `--read-only`, `--tmpfs /tmp`, `--pids-limit 256`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--user 65534`, `--memory`, `--cpus`, hard wall-time kill via `SIGKILL`. Stdout/stderr capped per `limits.stdoutBytes`/`stderrBytes` with `truncated` tracking.
- **`FakeRuntime`** — Deterministic in-memory `ContainerRuntime` keyed by `sha256(imageDigest + stdin)`. Supports `register()` seeding, `calls` recording, and `resetCalls()` for test assertions. No Docker required.
- **`ImagePolicy` / `createImagePolicy()`** — O(1) allow-list by exact `sha256:` digest. Each entry declares `networkAllowList`, `envAllowList`, and `resourceCeiling` (`cpuMillis`, `memoryMB`, `wallTimeSeconds`).
- **`ResultCache<T>`** — Simple `get(key)/set(key, value)` interface for deterministic hash-keyed result caching (distinct from `SemanticCache` which is embedding-based).
- **Typed errors** — `DigestRequired`, `ImageNotAllowed`, `NetworkDenied`, `ResourceLimitExceeded`, `EnvKeyDenied` — all with `readonly code` discriminant fields.
- **`weaveContainerExecutor(opts)`** — Factory function exported from `@weaveintel/sandbox` following shared factory convention.
- **`weaveFakeContainerRuntime(opts?)`** — Helper exported from `@weaveintel/testing` for DI-based test setups.
- **20 tests** — Cover determinism, isolation (network), resource limit clamping, image policy enforcement, cache interop, env allow-list, stdout cap, and backwards compatibility with `createSandbox()`.
- **Spec compliance** — Tags (non-`sha256:` digests) are rejected at executor entry; only successful (exit 0) results are cached; existing in-process `createSandbox()` API is fully unchanged.

### GeneWeave — Tool Platform Phase 4: Credentials + External Tool Support

- **`tool_credentials` table** — DB-backed registry for operator-managed credentials (API keys, OAuth tokens, JWT, basic auth). UUID PKs. Secrets stay in environment variables; DB stores only `env_var_name` reference — no plaintext secrets in DB.
- **`ToolCredentialRow`** — New type exported from `@weaveintel/geneweave` `db-types.ts` with 7 `DatabaseAdapter` methods: `createToolCredential`, `getToolCredential`, `listToolCredentials`, `listEnabledToolCredentials`, `updateToolCredential`, `deleteToolCredential`, `validateToolCredential(id)`.
- **Admin API `/api/admin/tool-credentials`** — Full CRUD (GET list, GET by ID, POST, PUT, DELETE) + `POST /:id/validate` action. Validate endpoint checks env var presence, updates DB `validation_status`, returns `{ status, configured: boolean }` — never exposes the secret value.
- **Admin UI** — New **Tool Credentials** tab under the Orchestration group. Fields: `name`, `description`, `credential_type` (select: api_key / oauth_token / basic_auth / jwt / custom), `tool_names` (JSON), `env_var_name`, `config` (JSON), `rotation_due_at`, `validation_status` (readonly), `enabled`.
- **`tool_catalog.config` column** — New nullable JSON column on `tool_catalog` for storing MCP endpoint URLs (`{ endpoint }`) and A2A agent URLs (`{ agentUrl }`) for externally-sourced tools.
- **`createToolRegistry()` is now async** — Breaking change. All call sites require `await`. MCP and A2A tools are loaded from `catalogEntries` at registry-creation time.
- **`ToolRegistryOptions` extended** — New fields: `credentialResolver?: (id: string) => Promise<ToolCredentialRow | null>` and `catalogEntries?: ToolCatalogRow[]`.
- **MCP catalog tool loading** — `catalog_entries` with `source='mcp'` are loaded at runtime via `createHttpMCPTransport()` which injects credential headers from `env_var_name`. Non-fatal per-entry (broken MCP servers do not block requests).
- **A2A catalog tool loading** — `catalog_entries` with `source='a2a'` create delegate tools via `buildA2ATool()` wrapping `weaveA2AClient().sendTask()`. Non-fatal per-entry.
- **`ChatEngine` wiring** — `credentialResolver` and `catalogEntries` wired in constructor and both streaming/non-streaming `toolOptions` assembly paths.
- **3 new Playwright E2E tests** — Validate Tool Credentials tab visibility, New button, and create form.

### GeneWeave — Tool Platform Phase 3: Audit Trail + Health Persistence

- **`tool_audit_events` table** — Persists every tool invocation with UUID PK, outcome (`success` | `error` | `denied` | `timeout` | `circuit_open`), duration_ms, chat/user/agent context, input/output previews, error message, and policy_id.
- **`DbToolAuditEmitter`** (`apps/geneweave/src/tool-audit-emitter.ts`) — Implements `ToolAuditEmitter`; wraps `db.insertToolAuditEvent()`, best-effort (never throws), generates UUID via `randomUUID()`.
- **`ChatEngine` wiring** — `DbToolAuditEmitter` is now passed into `ToolRegistryOptions`; all tool invocations are persistently audited end-to-end.
- **`tool_health_snapshots` table** — Stores point-in-time health snapshots per tool per 15-minute window for trend analysis.
- **`startToolHealthJob(db)`** (`apps/geneweave/src/tool-health-job.ts`) — Background job that runs every 15 minutes; aggregates `success_count`, `error_count`, `denied_count`, `avg_duration_ms`, `p95_duration_ms`, `error_rate`, `availability` per tool and writes to `tool_health_snapshots`. Uses `.unref()` for clean shutdown.
- **Admin API `/api/admin/tool-audit`** — Read-only GET list (filters: `tool_name`, `chat_id`, `outcome`, `after`, `before`, `limit`, `offset`) + GET by ID. Append-only; no mutations exposed.
- **Admin API `/api/admin/tool-health`** — GET live 24h summary via SQL aggregation; GET `/api/admin/tool-health/:toolName/snapshots` for historical snapshots.
- **Admin UI** — Two new read-only tabs under the Orchestration group: **Tool Audit** and **Tool Health** (no Create/Edit/Delete rendered).
- **`AdminFieldDef.readonly`** — Added `readonly?: boolean` to the shared `AdminFieldDef` interface in `@weaveintel/core` to support per-field read-only display in admin forms.
- **Startup sequence** — `seedDefaultData()` → `syncToolCatalog(db)` → `startToolHealthJob(db)` → HTTP server listen.
- **4 new Playwright E2E tests** — Validate both read-only tabs are visible and have no New button.

---

## [1.0.0] — Aertex — 2026-04-12

First stable release of weaveIntel.

### Core Framework
- **@weaveintel/core** — Contracts, types, context, events, middleware, capability system, plugin registry
- **@weaveintel/models** — Unified model router with fallback chains, streaming, middleware, capability-based selection
- **@weaveintel/provider-openai** — OpenAI adapter — chat, streaming, embeddings, image, audio, structured output, vision, files, fine-tuning, batches, responses API
- **@weaveintel/provider-anthropic** — Anthropic adapter — chat, streaming, tool use, extended thinking, vision, token counting, batches, computer use, prompt caching
- **@weaveintel/testing** — Fake models, embeddings, vector stores, and MCP transports for deterministic tests

### Agent Orchestration
- **@weaveintel/agents** — Agent runtime with ReAct tool-calling loop and supervisor-worker hierarchies
- **@weaveintel/workflows** — Multi-step workflow engine with conditional branching, checkpointing, and compensation
- **@weaveintel/human-tasks** — Human-in-the-loop approval tasks, review queues, escalation, decision logging
- **@weaveintel/contracts** — Completion contracts with evidence bundles and completion reports
- **@weaveintel/prompts** — Versioned prompt templates, A/B experiments, instruction bundles
- **@weaveintel/routing** — Smart model routing — health tracking, capability matching, weighted scoring

### Knowledge & Retrieval
- **@weaveintel/retrieval** — Document chunking (6 strategies), embedding pipeline, vector retrieval with reranking
- **@weaveintel/memory** — Conversation, semantic, and entity memory implementations
- **@weaveintel/graph** — Knowledge graph with entity linking, timeline, and graph-based retrieval
- **@weaveintel/extraction** — Document extraction pipeline — entity, metadata, timeline, table, code, task stages
- **@weaveintel/cache** — Semantic caching with TTL, LRU eviction, and embedding-based lookup
- **@weaveintel/artifacts** — Artifact storage — versioned blobs with metadata, tagging, lifecycle management

### Tools & Connectivity
- **@weaveintel/tools** — Extended tool registry with versioning, risk tagging, health tracking
- **@weaveintel/tools-search** — Web search tools (DuckDuckGo, Brave)
- **@weaveintel/tools-browser** — Browser tools for URL fetching and content extraction
- **@weaveintel/tools-http** — HTTP endpoint tools with auth and rate limiting
- **@weaveintel/tools-enterprise** — Enterprise connectors (Jira, Slack, GitHub, database)
- **@weaveintel/tools-social** — Social media tools (Twitter/X, LinkedIn)
- **@weaveintel/mcp-client** — MCP protocol client for remote tool/resource/prompt discovery
- **@weaveintel/mcp-server** — MCP protocol server to expose tools, resources, and prompts
- **@weaveintel/a2a** — Agent-to-agent protocol (remote HTTP + in-process bus)
- **@weaveintel/plugins** — Plugin lifecycle — register, enable/disable, validate, dependency resolution

### Safety & Governance
- **@weaveintel/guardrails** — Guardrail pipeline with risk classification and cost guards
- **@weaveintel/redaction** — PII detection (email, phone, SSN, CC), reversible tokenization
- **@weaveintel/compliance** — Data retention, GDPR/CCPA deletion, legal holds, consent management
- **@weaveintel/sandbox** — Sandboxed execution with policy enforcement and resource limits
- **@weaveintel/identity** — Identity management — delegation chains, ACL enforcement
- **@weaveintel/tenancy** — Multi-tenancy with tenant isolation and budget management
- **@weaveintel/reliability** — Idempotency, retry budgets, dead-letter queues, health checking

### Observability & Evaluation
- **@weaveintel/observability** — Tracing, spans, event bus, cost/token usage tracking
- **@weaveintel/evals** — Evaluation runner with 6 assertion types
- **@weaveintel/replay** — Trace replay for debugging and regression testing

### Application Layer
- **@weaveintel/recipes** — Pre-built agent factories (governed assistant, approval-driven, workflow)
- **@weaveintel/devtools** — Developer tools for scaffolding, inspection, validation
- **@weaveintel/ui-primitives** — UI streaming events, widgets, artifacts, citations, progress
- **@weaveintel/triggers** — Trigger system (cron, webhooks, queue-based)
- **@weaveintel/collaboration** — Multi-user session management and agent collaboration
- **@weaveintel/geneweave** — Full-stack demo app with chat UI, admin dashboard, model pricing sync

### Examples
- 20 runnable examples covering simple chat, tool calling, RAG, hierarchical agents, MCP, A2A, memory, PII redaction, evaluations, observability, Anthropic provider, and geneWeave

---

[1.0.0]: https://github.com/gibyvarghese/weaveintel/releases/tag/v1.0.0
