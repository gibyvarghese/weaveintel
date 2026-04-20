# Changelog

All notable changes to weaveIntel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Fabric Versioning](VERSIONING.md).

---

## [Unreleased]

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
