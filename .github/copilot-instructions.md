# Copilot Instructions

## Architecture Priorities
- Prefer reusable package-level capabilities over app-local implementations when a feature belongs to the shared weaveIntel platform.
- Keep GeneWeave database-driven for prompts, skills, agents, policies, and related configurable capabilities.
- Route prompt parsing, rendering, and version normalization through `@weaveintel/prompts` instead of duplicating prompt logic inside apps.
- Treat prompt records as prompt assets only when they are genuinely model-authored instructions or reusable prompt compositions.
- Move behavior bundles, operational policies, and tool activation logic into skills, tools, contracts, or runtime policies when they are not prompt assets.
- Keep the operator tool catalog (`tool_catalog` in DB, `/api/admin/tool-catalog`) as the single source of truth for which tools are active at runtime. Never hardcode tool enablement in code.

## Prompt Boundary
- Use prompts for templateable model instructions, reusable system/user message structures, few-shot exemplars, routing/judging/optimizer prompt assets, and model-facing text variants that benefit from versioning and experimentation.
- Use skills for reusable behavior packs that combine instructions, tool activation, and execution guidance.
- Use tools or workers for capabilities that must perform actions or fetch data instead of only shaping model text.
- Use runtime policies for orchestration rules, hard execution constraints, guardrails, and non-optional workflow behavior.
- Preserve strong descriptions and structured metadata on any prompt, skill, tool, or worker that is callable by an LLM.

## GeneWeave Expectations
- Wire GeneWeave to shared packages rather than keeping parallel app-only versions of the same logic.
- When prompt metadata changes, update GeneWeave database schema, admin CRUD, and runtime resolution together so the app remains internally consistent.
- Keep admin surfaces usable: prefer explicit labels, structured JSON fields only where needed, and defaults that make creation safe.
- Favor modular changes that help reduce pressure on large files such as `chat.ts`, `ui.ts`, `server.ts`, and `server-admin.ts`.
- For local runtime work, treat `./geneweave.db` as the canonical GeneWeave SQLite database. Both `examples/12-geneweave.ts` (dev) and `deploy/server.ts` (prod) honor `DATABASE_PATH` from `.env`, which is set to `./geneweave.db`. Do not apply data fixes or validation against `./apps/geneweave/geneweave.db` or `./data/geneweave.db` unless runtime configuration is intentionally changed.

## Tool Platform (Phase 1 complete — Runtime Bridge)
- The `tool_catalog` table (renamed from `tool_configs`) is the DB-backed registry of all known tools. It replaces the legacy `tool_configs` table.
- `syncToolCatalog(db)` runs at startup to INSERT new BUILTIN_TOOLS entries into `tool_catalog` without overwriting operator customizations.
- `createToolRegistry()` respects the `disabledToolKeys` set passed via `ToolRegistryOptions`. Server-side callers must load enabled keys via `db.listEnabledToolCatalog()` and compute the disabled set before calling `createToolRegistry()`.
- Admin API path for tool catalog is `/api/admin/tool-catalog`. The old `/api/admin/tools` path is retired.
- `ToolCatalogRow` is the canonical type (exported from `@weaveintel/geneweave`). `ToolConfigRow` is a deprecated alias kept for backward compatibility.
- New tool fields: `tool_key` (unique key matching BUILTIN_TOOLS key), `version`, `side_effects`, `tags`, `source` (`builtin`|`custom`|`mcp`|`plugin`), `credential_id`.
- Risk level values are: `read-only` | `write` | `destructive` | `privileged` | `financial` | `external-side-effect`. Old values (`low`, `medium`, `high`) are retired.
- Phase 2 (Tool Policies) is **complete**. See the section below for the full Phase 2 contract.

## Tool Platform (Phase 2 complete — Tool Policies)
- Named `tool_policies` table in DB; admin CRUD at `/api/admin/tool-policies`. Seeded with 4 built-in policies: `default`, `strict_external`, `destructive_gate`, `read_only`.
- `ToolPolicyResolver` interface (in `@weaveintel/tools`) is the contract for looking up the effective policy for a tool at runtime. GeneWeave supplies `DbToolPolicyResolver` backed by the `tool_policies` SQLite table.
- `createPolicyEnforcedRegistry(registry, opts)` (in `@weaveintel/tools`) wraps every tool in the registry with an enforcement sequence: enabled check → circuit breaker → risk level gate → approval gate → rate limit → execute with timeout → audit emit.
- `createToolRegistry()` in `tools.ts` accepts `policyResolver`, `auditEmitter`, and `rateLimiter` in `ToolRegistryOptions`. When a `policyResolver` is provided the returned registry is policy-enforced automatically.
- `ChatEngine` constructor wires `DbToolPolicyResolver`, `DbToolRateLimiter`, and `DbToolAuditEmitter` into `this.toolOptions` so all tool invocations are policy-gated and persistently audited end-to-end.
- Rate limiting uses `tool_rate_limit_buckets` with 1-minute tumbling windows. `checkAndIncrementRateLimit()` on `DatabaseAdapter` is atomic (INSERT OR IGNORE + UPDATE within the same window row).
- `EffectiveToolPolicy.source` values are: `'default'` | `'global_policy'` | `'skill_override'` | `'persona_override'`. Skill-level overrides are passed via `skillPolicyKey` in `PolicyResolutionContext`.
- Audit events are emitted via `ToolAuditEmitter`. GeneWeave uses `DbToolAuditEmitter` (persists every invocation to `tool_audit_events`). The legacy `consoleAuditEmitter` is no longer wired in production.
- `ToolPolicyRow` and `ToolRateLimitBucketRow` are exported from `@weaveintel/geneweave` `db-types.ts`. All `tool_policies` rows use UUID primary keys.
- Phase 3 (Tool Audit Trail + Health Persistence) is **complete**. See the section below for the full Phase 3 contract.

## Cross-Cutting Requirements
- Reuse shared observability and evaluation hooks for new AI capabilities instead of creating app-only telemetry paths.
- Update examples and supporting docs when adding or changing platform capabilities so end-to-end usage stays discoverable.
- Add concise comments only where the control flow or data mapping is non-obvious.
- Keep prompts grounded in runtime reality: if a prompt requires tools, data freshness, or deterministic checks, route that requirement through skills/tools/runtime policies instead of relying on instruction text alone.

## Durable Cross-Cutting Principles

These principles emerged from the Scientific Validation feature (sv:) but apply framework-wide. Every new contribution must follow them.

- **Every database row uses a UUID primary key** — UUIDs prevent ID collisions across replay, export/import, and future sharding. SQLite uses `TEXT` (UUID v7 preferred for sortability via `newUUIDv7()` in `apps/geneweave/src/lib/uuid.ts`); Postgres adopters get `uuid` natively. Never use `INTEGER PRIMARY KEY AUTOINCREMENT` for new tables.
- **The evidence ledger is always `@weaveintel/contracts`** — Any feature that needs to track "things an agent discovered that justify a conclusion" uses completion contracts with evidence bundles. Never invent a parallel ledger table.
- **Reproducibility is always `@weaveintel/replay`** — Any feature that needs "run it again and get the same answer" uses replay traces. Never invent a bespoke bundle format.
- **Sandboxed compute for anything with native code, subprocesses, or non-trivial memory** — The in-process sandbox executor is not sufficient for SymPy, SciPy, R, RDKit, OpenMM, Biopython, and similar. Use the container executor (`ContainerExecutor` in `@weaveintel/sandbox`).
- **Tool invocations flow through `@weaveintel/tools` with risk tags** — No ad-hoc subprocess spawning. Every tool is a registration with versioning, risk classification, and health tracking. Guardrails enforce the risk policy.
- **Multi-agent dialogue flows through `@weaveintel/a2a`** — In-process bus for local; HTTP transport for distributed. Never pass messages between agents by shared module state.
- **Model selection flows through `@weaveintel/routing`** — Agents never hard-code a model id. They declare a capability requirement; routing decides.
- **Redaction happens before the model call, not after** — `@weaveintel/redaction` with reversible tokenisation sits as middleware on the model client. LLMs never see raw PII.
- **Every workflow step is observable** — `@weaveintel/observability` tracer wraps every step. Every cost item is attributed. Budget envelopes are enforced at step boundaries.
- **Idempotency on writes** — `@weaveintel/reliability` provides the idempotency key mechanism. Every POST route that creates or modifies state uses an `Idempotency-Key` header.

## Grounding Reality Guardrails
- Treat prompt text as guidance, not guaranteed execution. Any requirement that must always happen (tool call, policy check, verification pass, formatting guarantee) belongs in code-level orchestration and shared runtime hooks.
- Keep execution strategies DB-driven and traceable: strategy selection should come from prompt metadata (`executionDefaults.strategy`) plus admin-managed strategy records, not hardcoded app-only conditionals.
- Ensure runtime metadata captures which strategy, contracts, and evaluations were used so observability and audits can explain model behavior after the fact.
- Prefer app-wide reusable helpers in `@weaveintel/prompts` for prompt execution and strategy overlays; GeneWeave should consume these helpers, not duplicate them.

## Phase 8 Observability and Runtime Adoption
- Add new observability schemas in shared packages first (`@weaveintel/core` contracts, `@weaveintel/observability` helpers) so prompts, skills, agents, and tools can emit one comparable trace shape.
- Keep capability telemetry grounded in code, not prompt text: prompt/skill/agent runtime metadata must be emitted from runtime hooks and stored in DB-backed traces.
- When GeneWeave adopts new shared observability helpers, wire them into existing trace persistence and dashboard views instead of creating app-only telemetry stores.
- Capability descriptions in traces must remain model-facing and explicit enough to support future routing, audits, and replay review.

## Phase 9 Modularization and Reusability
- Put reusable admin capability schema primitives in shared packages first (for example, `@weaveintel/core`) and keep GeneWeave as a consumer.
- For large GeneWeave files, extract by capability domain (prompt tabs, skill tabs, routes, runtime units) and re-compose from index modules rather than appending new blocks.
- New capability records must stay DB-driven end-to-end: schema + adapter + admin CRUD + runtime resolution in one change set.
- New prompt/skill/tool/agent-facing admin fields must preserve model-facing descriptions; avoid generic labels for LLM-discovered entities.
- New features must wire shared observability/eval hooks by default so prompts, skills, agents, and tools emit comparable telemetry without app-only pipelines.
- When modularizing UI/admin surfaces, preserve operator UX: explicit labels, safe defaults, and JSON hints for advanced fields.

## Live-Agents Framework (Phases 14-16)

### When to use live-agents vs @weaveintel/agents

**Use live-agents when:**
- Agents run continuously over hours/days/weeks (not one-shot interactions)
- Agents need to persist and accumulate learnings in contracts
- Multiple agents run in parallel (need distributed coordination)
- Agents need to respond to external events (webhooks, file changes) continuously
- You need mesh-level isolation and cross-mesh bridges for multi-team collaboration

**Use @weaveintel/agents when:**
- Single request/response interaction (user query → agent response)
- Stateless tool-calling chains
- ReAct loop with bounded depth

### Live-agents core patterns

**Mesh and agents:**
```typescript
const mesh = await createMesh('my-team', { stateStore });
const agent = await mesh.spawnAgent('assistant', { 
  instructions: '...',
  attentionPolicy: (agent) => [...], // Defines when agent should work
});
```

**Contracts and evidence:**
- Contracts are immutable work products (findings, decisions, errors)
- Evidence links contracts to tool outputs (reproducible and auditable)
- Use contracts for cross-mesh collaboration (bridges filter by contract type)

**Heartbeat and ticks:**
- Heartbeat scheduler runs every 10 minutes
- Attention policy decides what work each agent should do
- Ticks are scheduled units of work (atomic, claimed by workers)
- Supports time-based (daily compression, hourly email check) and event-based (new contracts) scheduling

**Account binding (critical invariant):**
- Only humans bind accounts to agents (agent cannot self-bind)
- Binding includes capabilities array (SEND_EMAIL, READ_INBOX, etc.)
- Revocation is immediate (next tick sees revoked binding)
- See docs/live-agents/ADR/001-account-binding-invariants.md

**MCP integration:**
- MCP tools connect agents to external systems (Gmail, Slack, Drive)
- Credentials live in environment variables (never in DB)
- Account binding controls which agent can use which account's credentials
- Fixtures enable testing without real API calls

**Cross-mesh bridges:**
- Bridge: source mesh → target mesh, filters by contract type, requires both meshes to approve
- Authorization: source registers bridge, target approves
- Revocation: either mesh can revoke, stops message routing immediately

### Live-agents documentation

- [`@weaveintel/live-agents`](packages/live-agents/README.md) — Framework overview, core concepts, when to use
- [Use Cases](docs/live-agents/use-cases.md) — Six scenarios with examples 52-57
- [Account Model](docs/live-agents/account-model.md) — Why humans bind accounts, threat model, anti-patterns
- [MCP Integration](docs/live-agents/mcp-integration.md) — How external tools connect, credential scoping, testing
- [StateStore Guide](docs/live-agents/statestore-guide.md) — Persistence layer, in-memory/Redis/Postgres, implementing custom stores
- [Compression Guide](docs/live-agents/compression-guide.md) — Context compression strategies, token budgeting, daily/weekly/hierarchical summaries
- [ADRs](docs/live-agents/ADR/) — Architectural decision records (account binding, heartbeat, bridges, state store, credentials)

### Tools for live-agents

- [`@weaveintel/tools-webhook`](packages/tools-webhook/README.md) — Receive webhooks (GitHub push, Stripe payment, Slack mention) and route to agents
- [`@weaveintel/tools-filewatch`](packages/tools-filewatch/README.md) — Monitor file system, trigger agent actions on file events

### Reference implementation

- [`apps/live-agents-demo`](apps/live-agents-demo) — Complete HTTP API, PostgreSQL state store, in-memory/Redis options, interactive UI
- [`examples/52-57`](examples/) — Six core examples covering all major use cases
- [`examples/58-live-agents-demo-e2e.ts`](examples/58-live-agents-demo-e2e.ts) — E2E test of demo app API

## LLM-Callable Metadata
- Enforce detailed model-facing descriptions for prompts, skills, tools, and agents through shared validation helpers in `@weaveintel/core`.
- Prefer shared prompt runtime helpers in `@weaveintel/prompts` for DB-backed rendering with lifecycle hooks and evaluations.
- Keep admin UX labels explicit when fields are used for model discovery and routing.

## Phase 2 Prompt Capabilities (`@weaveintel/prompts`)

### Fragment Inclusions (`{{>key}}` syntax)
- Templates may embed reusable text blocks via `{{>fragmentKey}}` markers (note the `>` prefix distinguishing them from `{{variable}}` slots).
- Use `resolveFragments(template, registry)` to expand all fragment markers before interpolation; unresolvable keys are left in place for lint to catch.
- Build registries with `InMemoryFragmentRegistry` in-memory or load from the GeneWeave `prompt_fragments` DB table via `fragmentFromRecord(row)`.
- Use `extractFragmentKeys(template)` to discover all `{{>key}}` references in a template without a registry.
- Circular references are detected (max depth 5) and left unexpanded rather than throwing.
- GeneWeave DB: `prompt_fragments` table; admin CRUD at `/api/admin/prompt-fragments`.

### Framework Registry (Named Section Structures)
- Frameworks define ordered, named sections (e.g. role → task → context → expectations) assembled by `renderFramework(framework, sectionValues)`.
- Use `defaultFrameworkRegistry` which ships four built-ins: `rtce`, `full`, `critique`, `judge`.
- Build custom frameworks in-memory with `InMemoryFrameworkRegistry` or load from `prompt_frameworks` DB via `frameworkFromRecord(row)`.
- Only sections whose key is in `SYSTEM_SECTIONS` (currently `'role'`) map to the system message; all others map to the user turn.
- GeneWeave DB: `prompt_frameworks` table; admin CRUD at `/api/admin/prompt-frameworks`.

### Lint / Static Analysis
- Call `lintPromptTemplate(template, variables, values, context?)` after fragment expansion to get typed `PromptLintResult[]`.
- Nine built-in rules: `missing_required_variable`, `missing_optional_variable`, `undefined_variable`, `empty_template`, `excessive_size`, `unresolved_fragment`, `circular_fragment`, `missing_description`, `no_variables_declared`.
- Use `hasLintErrors(results)`, `topLintSeverity(results)`, `formatLintResults(results, promptName)` as diagnostic helpers.
- Attach `lintResults` to observability spans when non-empty to surface quality signals in production.

### Unified Entry Point: `renderWithOptions()`
- `renderWithOptions(template, variables, values, options?)` is the Phase 2 unified path: fragment expansion → optional lint → interpolation.
- Returns a `RenderResult` with `.text`, `.lintResults`, and `.expandedTemplate`.
- Prefer this over calling `resolveFragments` + `createTemplate().render()` separately.

### Provider-Aware Render Adapters
- `openAIAdapter()` → `.adaptText(userText, systemText?)` returns `{role, content}[]` compatible with OpenAI Chat Completions.
- `anthropicAdapter()` → `.adaptForAnthropic(userText, systemText?)` returns `{ system, messages }`.
- `textAdapter()` → `.toText(userText, systemText?)` returns a single concatenated string.
- `systemAsUserAdapter()` → wraps system content as `<<SYSTEM>>\n...\n<</SYSTEM>>` for models without a system role.
- `resolveAdapter(provider)` selects the right adapter from a `KnownProvider` string (`'openai' | 'anthropic' | 'text' | 'system-as-user'`).

### chat.ts Fragment Integration
- GeneWeave `chat.ts` loads enabled DB fragments before rendering a DB-backed system prompt and calls `resolveFragments()` to expand `{{>key}}` markers.
- Fragment expansion failure is non-fatal — the raw template is used as fallback.

## Tool Platform (Phase 3 complete — Tool Audit Trail + Health Persistence)
- Every tool invocation is persisted to `tool_audit_events` (UUID PK, all `ToolAuditOutcome` values, duration_ms, chat/user/agent context, input/output previews, error message, policy_id).
- `DbToolAuditEmitter implements ToolAuditEmitter` (in `apps/geneweave/src/tool-audit-emitter.ts`) wraps `db.insertToolAuditEvent()` — best-effort, never throws, maps camelCase→snake_case, generates UUID via `randomUUID()`.
- `startToolHealthJob(db)` (in `apps/geneweave/src/tool-health-job.ts`) runs every 15 minutes via `setInterval` (`.unref()` for clean shutdown), queries the last window of audit events, groups by `tool_name`, computes `success_count`, `error_count`, `denied_count`, `avg_duration_ms`, `p95_duration_ms` (in-process percentile), `error_rate`, `availability`, and writes one `tool_health_snapshots` row per tool.
- `tool_health_snapshots` table stores historical point-in-time snapshots per tool per window for trend analysis.
- Admin API path for audit log is `/api/admin/tool-audit` (GET list with `tool_name`, `chat_id`, `outcome`, `after`, `before`, `limit`, `offset` filters; GET by ID). Append-only — no mutations exposed.
- Admin API path for health is `/api/admin/tool-health` (GET live 24h summary via SQL aggregation; GET `/api/admin/tool-health/:toolName/snapshots` for historical snapshots).
- Both tabs use `readOnly: true` in `AdminTabDef` (no Create/Edit/Delete UI rendered). `AdminFieldDef` now supports `readonly?: boolean` for individual field display.
- `ToolAuditEventRow` and `ToolHealthSnapshotRow` are exported from `@weaveintel/geneweave` `db-types.ts`. All `tool_audit_events` rows use UUID primary keys.
- Startup sequence in `index.ts`: `seedDefaultData()` → `syncToolCatalog(db)` → `startToolHealthJob(db)` → HTTP server listen.

## Tool Platform (Phase 4 complete — Credentials + External Tool Support)
- `tool_credentials` table stores operator-managed credentials for external tools. **Secrets are never stored in DB** — only `env_var_name` is stored; the actual secret lives in the process environment.
- `ToolCredentialRow` exported from `@weaveintel/geneweave` `db-types.ts`. UUID primary keys. Fields: `id, name, description, credential_type, tool_names (JSON), env_var_name, config (JSON), rotation_due_at, validation_status, enabled`.
- Admin API at `/api/admin/tool-credentials` — full CRUD + `POST /:id/validate` (checks env var, updates `validation_status`, returns `{ status, configured: boolean }` — never exposes secret).
- `tool_catalog.config` column (`TEXT`, nullable) — stores JSON configuration for MCP (`{ endpoint }`) and A2A (`{ agentUrl }`) tools.
- **`createToolRegistry()` is now `async`** — all call sites must `await` it. `buildWorkersFromDb()` in `chat.ts` is also async.
- `ToolRegistryOptions` extended: `credentialResolver?: (id: string) => Promise<ToolCredentialRow | null>` and `catalogEntries?: ToolCatalogRow[]`.
- MCP tool loading: catalog entries with `source='mcp'` use `createHttpMCPTransport()` which injects `Authorization` headers from `env_var_name`. Non-fatal per entry — broken MCP servers do not block request processing.
- A2A tool loading: catalog entries with `source='a2a'` use `buildA2ATool()` wrapping `weaveA2AClient().sendTask()` with the correct `A2ATask` shape (`id, input: { role, parts: [{ type: 'text', text }] }`). Non-fatal per entry.
- `ChatEngine` wires `credentialResolver: (id) => db.getToolCredential(id)` and passes `catalogEntries` from `db.listEnabledToolCatalog()` in both streaming and non-streaming `toolOptions`.



### Strategy Runtime (DB + Shared Package)
- Use `executePromptRecord(record, variables, options?)` as the package-level execution entry point when strategy overlays are needed.
- `executePromptRecord()` performs shared render + strategy resolution + evaluation hook execution in one path.
- Strategy resolution order: explicit `options.strategyKey` → prompt `executionDefaults.strategy` → fallback strategy.
- Load DB rows into runtime strategy definitions with `strategyFromRecord(row)` and register them in `InMemoryPromptStrategyRegistry`.
- Start with `defaultPromptStrategyRegistry`, then layer DB-defined strategies for app/tenant-specific behavior.
- GeneWeave DB: `prompt_strategies` table; admin CRUD at `/api/admin/prompt-strategies`.

## Tool Platform (Phase 6 complete — Skill→Tool Policy Closure + Approval Workflow)
- When a skill is activated in chat, its `toolPolicyKey` is passed as `skillPolicyKey` in `PolicyResolutionContext` so every tool call in that session is evaluated under the skill's effective policy.
- Tools whose effective policy has `requireApproval: true` are blocked at runtime; the approval gate creates a `tool_approval_requests` row (UUID PK) with `status: 'pending'`.
- `tool_approval_requests` table: `id (UUID), tool_name, chat_id, skill_key, policy_key, status ('pending'|'approved'|'denied'), requested_at, resolved_at, resolved_by, resolution_note, input_preview`.
- Admin API at `/api/admin/tool-approval-requests`:
  - `GET /api/admin/tool-approval-requests` — list with `status`, `chat_id`, `tool_name`, `limit`, `offset` filters
  - `GET /api/admin/tool-approval-requests/:id` — single request (404 if not found)
  - `POST /api/admin/tool-approval-requests/:id/approve` — approve with optional `{ note }`; 409 if already resolved
  - `POST /api/admin/tool-approval-requests/:id/deny` — deny with optional `{ note }`; 409 if already resolved
- All routes require authentication (`{ auth: true }` option) and return 401 for unauthenticated callers.
- `registerToolApprovalRequestRoutes(router, db, helpers)` is wired in `server-admin.ts` on the direct `router` (not `adminRouter`) with manual `if (!auth)` guard per route.
- `DbToolApprovalGate` (in `apps/geneweave/src/tool-approval-gate.ts`) implements the approval gate by inserting `tool_approval_requests` rows when policy requires approval.
- API tests: `describeAdmin('Tool Approval Requests API', ...)` in `api.test.ts` (5 tests — all pass).
- Example: `examples/34-skill-tool-policy-approval.ts`.

## Tool Platform (Phase 5 complete — Tool Simulation + Test Harness)
- Admin operators can run dry-run or live simulations of any registered tool without starting a real chat session.
- `GET /api/admin/tool-simulation/tools` — lists BUILTIN_TOOLS + enabled catalog entries for simulation selection.
- `POST /api/admin/tool-simulation` — accepts `{ toolName, inputJson, dryRun?, chatContext?, agentPersona?, skillPolicyKey? }`. Returns `{ simulationId, auditEventId, toolName, dryRun, policy, policyTrace, allowed, violationReason?, result?, durationMs }`.
- `policyTrace` is `Array<{ step: string, passed: boolean, detail: string }>` with steps: `enabled_check → risk_level_gate → approval_gate → rate_limit → [execute]`.
- On dry-run, the full policy trace is returned but execution is skipped and `result` is omitted from response.
- On live run, execution is attempted (may call real tool) and `result.content` contains the tool output string.
- All simulation invocations emit an audit event with `outcome: 'simulation'` — best-effort, non-blocking.
- `ToolAuditOutcome` in `@weaveintel/core` now includes `'simulation'` as a valid value.
- `AdminTabDef` in `@weaveintel/core` now has `customView?: string` — set `customView: 'tool-simulation'` to bypass standard CRUD list/form and render a custom UI component.
- Custom view injection pattern in `renderAdminView`: check `schema?.customView === 'tool-simulation'` before the `showEditor` block, then `appendChild(renderToolSimulationView(...))`.
- `tool-simulation` tab is under Orchestration group in admin sidebar; `readOnly: true, customView: 'tool-simulation'` in tab schema.
- Source files: `apps/geneweave/src/admin/api/tool-simulation.ts` (API routes), `apps/geneweave/src/ui/tool-simulation-ui.ts` (custom admin UI component).
- API tests: `describeAdmin('Tool Simulation API', ...)` in `api.test.ts`; E2E: two Playwright tests in `admin-ux.e2e.ts`.

## Phase 5 Prompt Capabilities (`@weaveintel/prompts` + GeneWeave)

### Prompt Version & Experiment Resolution (Grounding Runtime)
- Use `resolvePromptRecordForExecution()` as the shared package-level resolver for runtime prompt selection.
- Resolution order is deterministic and must remain package-owned: requested version override → active experiment weighted variant → active published version → latest published version → base prompt fallback.
- Keep runtime safe during partial migrations: if version or experiment tables are empty/unavailable, fallback to base prompt behavior without failing request execution.
- Avoid app-local branching for version picking in GeneWeave; apps should pass DB rows to shared resolver and consume returned `{ record, meta }`.

### DB-Driven Configuration Requirements
- Keep prompt lifecycle and rollout controls in DB records, not hardcoded conditionals.
- GeneWeave DB tables for Phase 5: `prompt_versions` and `prompt_experiments`.
- Admin CRUD must stay aligned with schema and runtime contracts for both entities.

### Observability & Evaluation Expectations
- Capture prompt resolution metadata (`source`, `resolvedVersion`, `selectedBy`, experiment metadata) in runtime message metadata for audits and evaluation traces.
- Preserve shared execution metadata from strategy/contract/evaluation hooks so prompt behavior is explainable after the fact.

### LLM-Callable Metadata Quality
- Prompt version descriptions, experiment descriptions, and variant labels should be explicit and model-facing when they influence runtime behavior.
- Prefer structured metadata fields over freeform text for fields consumed by routing/selection logic.

## Phase 7 Prompt Evaluation and Optimization (`@weaveintel/prompts` + `@weaveintel/evals` + GeneWeave)

### Shared Package-First Evaluation Runtime
- Implement prompt evaluation logic in shared packages first (`@weaveintel/prompts`, `@weaveintel/evals`) and keep GeneWeave as a consumer of package APIs.
- Use dataset-driven prompt evaluation (`PromptEvalDataset`) with explicit case payloads, expected outputs, and rubric criteria; avoid app-local ad-hoc scoring logic.
- Prefer reusable rubric judge adapters and normalized score helpers from `@weaveintel/evals` so scoring behavior remains comparable across prompts, skills, and agents.

### DB-Driven Prompt Optimization and Governance
- Keep optimizer selection and configuration DB-managed via optimizer records (key, kind, config, enabled), not hardcoded app conditionals.
- Persist evaluation runs and optimization runs as first-class records for auditability, rollback decisions, and trend analysis.
- Require model-facing descriptions for optimizer records and evaluation artifacts that can influence LLM discovery/routing.

### Grounding Reality for Optimization Loops
- Treat optimization prompts as hypotheses; always verify candidate quality with deterministic evaluation passes before promotion.
- Runtime promotion decisions (accept/reject candidate versions) must be code-level and data-backed, never instruction-only.
- Capture baseline-vs-candidate evidence in metadata (`avgScore`, pass/fail counts, diff metadata, selected optimizer key) to support observability and postmortems.

### GeneWeave Admin and UX Expectations
- Expose Phase 7 entities in admin with explicit labels and JSON hints: eval datasets, eval runs, optimizers, optimization runs.
- Keep defaults safe for operators (e.g., draft status, conservative thresholds, deterministic starter optimizer).
- Ensure admin CRUD stays aligned with DB schema and shared runtime contracts when fields evolve.


## Scientific Validation Feature (sv: — complete)

### Design Patterns
- `SVWorkflowRunner` is instantiated once at server startup and passed to `registerSVRoutes`. Never create per-request runner instances.
- Model factories on `SVRunnerOptions` are **async**: `makeReasoningModel: () => Promise<Model>` and `makeToolModel: () => Promise<Model>`. Never use sync lazy wrappers.
- Specialist agents (literature, statistical, mechanistic, simulation, synthesis, critique) are composed inside the runner via the workflow engine. The router never invokes agents directly.
- `SvHypothesisStatus` values are `'queued' | 'running' | 'verdict' | 'abandoned'`. Never use `'pending'`, `'completed'`, or `'error'`.
- Terminal statuses are `new Set(['verdict', 'abandoned'])`. Use this set when checking SSE poll termination conditions.

### DB Tables
- `sv_hypothesis` — one row per submitted hypothesis; UUID PK.
- `sv_sub_claim` — decomposed sub-claims from the supervisor; UUID PK. Fields: `id, tenant_id, hypothesis_id, parent_sub_claim_id, statement, claim_type, testability_score, created_at`. No `rationale` or `status` columns.
- `sv_verdict` — final verdict row; UUID PK.
- `sv_evidence_event` — evidence records emitted per agent per step; UUID PK. Fields: `id, hypothesis_id, step_id, agent_id, evidence_id, kind, summary, source_type, tool_key, reproducibility_hash, created_at`. No `tenant_id` column.
- `sv_agent_turn` — inter-agent dialogue messages; UUID PK.

### `SvClaimType` Values
Valid values: `'mechanism' | 'epidemiological' | 'mathematical' | 'dose_response' | 'causal' | 'other'`. Do NOT use `'empirical'`.

### Route Contracts
- `POST /api/sv/hypotheses` → 201 `{ id, status: 'queued', traceId, contractId }`
- `GET /api/sv/hypotheses/:id` → 200 `{ hypothesis: {..., domainTags: string[]}, verdict: VerdictShape | null }`
- `POST /api/sv/hypotheses/:id/cancel` → 200 `{ id, status: 'abandoned' }` (idempotent — no 409 for already-abandoned)
- `POST /api/sv/hypotheses/:id/reproduce` → 201 `{ id, originalId, status: 'queued', traceId }`
- `GET /api/sv/verdicts/:id/bundle` → 200 JSON with `{ schemaVersion, hypothesis, verdict, subClaims, evidenceEvents, agentTurns }`

### Phase 6 — API routes, idempotency, auth, and test coverage (complete)
- All 7 SV routes are registered via `registerSVRoutes(router, db, json, readBody, runner)` — wired in `server.ts`.
- `Idempotency-Key` header is required on `POST /api/sv/hypotheses` and `POST /api/sv/hypotheses/:id/reproduce`. Replays return the original response without creating a duplicate DB row. Store uses `@weaveintel/reliability`'s `createIdempotencyStore` with a 24-hour TTL, scoped inside `registerSVRoutes`.
- Idempotency key namespacing: `hypotheses:<key>` for the submit route and `reproduce:<key>` for the reproduce route.
- Auth enforcement: every route returns 401 when `auth` is `null`. Tenant isolation is enforced by scoping all `db.getHypothesis(id, tenantId)` calls to the requester's `tenantId`.
- Test file at `features/scientific-validation/routes/sv-routes.test.ts` — 31 tests covering happy path, auth failures (all 7 routes), tenant isolation, idempotency replay, SSE content-type, Last-Event-ID cursor, and evidence/verdict event emission.
- Integration tests in `api.test.ts` under `describeAdmin('Scientific Validation API', ...)` — 8 tests covering 401 checks, 404s, submit, idempotency replay, and cancel.

### SV Tool Registration
- 18 SV tools are registered only for SV agent invocations via `toolMap` passed to `SVWorkflowRunner`. They are NOT in `tool_catalog` and NOT managed by operator tool policies.
- Tool invocation within SV agents uses `ToolInput = { name: string; arguments: Record<string, unknown> }`.
- All index-signature result properties must use bracket notation (`result['ok']`, not `result.ok`) because `noPropertyAccessFromIndexSignature` is enabled.

### SSE Streaming Pattern
- Use `pollRows(rowFetcher, afterId, isTerminalFn)` async generator for both events and dialogue streams.
- Emit `keepalive` pings every 15 s via `startSSEKeepalive(res)` / `clearInterval(ka)`.
- Wrap SSE handlers in `try/finally` to always call `clearInterval(ka)` and `res.end()`.
- Maximum SSE stream duration: 5 minutes (enforced inside `pollRows`).

### UI Architecture (Phases 7–9 — complete, Playwright verified)
- Three views: `sv-submit-view.ts` (form), `sv-live-view.ts` (SSE deliberation), `sv-verdict-view.ts` (verdict + bundle).
- All views exported from `features/scientific-validation/ui/index.ts` barrel.
- State fields: `state.svView` (`'submit' | 'live' | 'verdict'`), `state.svHypothesisId`, `state.svHypothesis`, `state.svVerdict`.
- View routing: `ui-client.ts` `else if (state.view === 'scientific-validation')` branch routes on `state.svView`.
- `'scientific-validation'` is in the `allowedViews` Set; sidebar nav entry is in `workspace-shell.ts`.
- SSE cleanup: `MutationObserver` on `document.body` detects DOM removal of the live view element and calls `cleanup()` to close `EventSource` instances and clear the polling interval.
- `EventSource` opens with `{ withCredentials: true }`. SSE event types: `evidence`, `turn`, `verdict`, `keepalive`.
- `globalThis.state` is exposed at the bottom of `ui-client.ts` (alongside `render`, `initialize`, etc.) so Playwright tests and devtools can manipulate SV state (`svView`, `svHypothesisId`) directly.
- `server.ts` static-file route regex covers `/features/` paths so ES module imports in `ui-client.js` (e.g. `./features/scientific-validation/ui/index.js`) are served correctly from `dist/`.
- `sv-submit-view.ts` title input placeholder must include the word "title" (for test selector `input[placeholder*="title" i]`) and the textarea placeholder must include "statement" (for `textarea[placeholder*="statement" i]`).
- Live deliberation view h2 text is `'Live Deliberation'` — Playwright selects via `/Deliberation|Live|Running/i`.
- Cancel button calls `POST /api/sv/hypotheses/:id/cancel` and on response (or error) sets `svView = 'submit'` and re-renders.
- Playwright E2E test file: `apps/geneweave/src/sv-ui.e2e.ts` — 8 tests covering nav entry, submit form, validation, live view, cancel, verdict, and bundle download.

### Eval Corpus
- `evals/corpus.json` — 20 curated hypotheses (5 known-true, 5 known-false, 5 ill-posed, 5 p-hacked).
- `evals/run-corpus.ts` — CLI runner; submits each hypothesis, polls for verdict, reports per-category pass/fail rates.
- Target accuracy ≥ 85% on known-true, known-false, and p-hacked categories.
- `expectedVerdict` values: `'supported' | 'refuted' | 'inconclusive' | 'needs_revision'`.

## Live-Agents Capability Parity and Naming Conventions

These rules govern any change inside `@weaveintel/live-agents`, `@weaveintel/live-agents-runtime`, or any app that consumes them (geneweave, live-agents-demo, examples). The full design is in [docs/live-agents/LLM_FIRST_CLASS_CAPABILITY_PLAN.md](../docs/live-agents/LLM_FIRST_CLASS_CAPABILITY_PLAN.md).

### Capability parity with `@weaveintel/agents`
- Live-agents is a **temporal extension** of `weaveAgent`, not a parallel implementation. If `weaveAgent` accepts a capability slot (`model`, `tools`, `memory`, `policy`, `bus`, `workers`), `weaveLiveAgent` must accept the same type — either reusing the same implementation or extending it with a per-tick variant. Never duplicate.
- `@weaveintel/live-agents` already ships six state-store backends (`weaveInMemoryStateStore`, `weaveSqliteStateStore`, `weavePostgresStateStore`, `weaveRedisStateStore`, `weaveMongoDbStateStore`, `weaveDynamoDbStateStore`) and an LLM ReAct scaffold (`runLiveReactLoop`). Do not assume "memory only" — extend, don't replace.
- Per-tick capability resolution (model, tools, prompt, policy gates) is first-class. Anything that may change between ticks must be resolvable per invocation via a resolver interface (e.g. `ModelResolver`), not pinned at construction time. Pinned values remain supported for tests and short-lived agents.

### Naming conventions
- `weave*` — user-facing constructor that returns a runnable thing (agent, mesh, store, resolver, model adapter, policy). Examples: `weaveAgent`, `weaveSupervisor`, `weaveLiveAgent`, `weaveLiveSupervisor`, `weaveLiveMesh`, `weaveLiveMeshFromDb`, `weaveLiveAgentFromDb`, `weaveModelResolver`, `weaveDbModelResolver`, `weaveLiveAgentPolicy`.
- `create*` — internal factory that returns infrastructure plumbing (registry, dispatcher, scheduler, supervisor handle). Examples: `createHandlerRegistry`, `createDefaultHandlerRegistry`, `createHeartbeat`, `createLiveAgentsRuntime`, `createCompressionMaintainer`.
- Types use `PascalCase` nouns: `LiveAgent`, `Mesh`, `ModelResolver`, `LiveAgentPolicy`.
- New PRs that add `createLiveXxx` user-facing constructors will be asked to rename to `weaveLiveXxx`.
- Deprecated aliases (e.g. `createAgenticTaskHandler` → `weaveLiveAgent`) are kept for one minor release cycle, then removed.

### DB hydration and runtime composition
- DB hydration goes through `@weaveintel/live-agents-runtime`, never re-implemented in apps. Apps may compose new handler kinds via the registry, but mesh provisioning, handler binding, tool binding, model resolution, and attention policies must use the package functions (`provisionMesh`, `resolveAgentToolCatalog`, `resolveAgentModelSpec`, `resolveAttentionPolicyFromDb`, `createHeartbeatSupervisor`, `bridgeRunState`).
- The single hydration entry points are `weaveLiveMeshFromDb(db, meshId, opts)` and `weaveLiveAgentFromDb(db, agentId, opts)`. App boot files should call these and supply only domain-specific extras (handler kinds, model resolver, account bindings).
- No geneweave types leak into `@weaveintel/live-agents-runtime`. The runtime defines a `LiveAgentsDb` interface aggregating only the row-reader shapes it needs; geneweave's `DatabaseAdapter` implements this interface structurally.

### Audit trail
- Every model resolution, tool resolution, policy decision, and contract change emits a `live_run_events` row. The package emits these; the app does not.
- `live_run_events` kinds in use: `model.resolved`, `tool.resolved`, `policy.decision`, `contract.changed`, `tick.started`, `tick.completed`, `tick.errored`. Add new kinds via PR review, never silently.

### When in doubt
- Adding a new capability to live-agents? Check whether `weaveAgent` already exposes it under a similar name, and reuse that name and shape.
- Adding a new boot path? Use `weaveLiveMeshFromDb` — do not write another `bootXxxMesh()` wrapper.
- Adding a per-tick concern? Inject it as a resolver, not a static value.

### Phase 1 — `ModelResolver` (complete)
- `ModelResolver` (in `@weaveintel/live-agents/src/model-resolver.ts`) is the **first-class capability slot** for per-tick model selection. It mirrors `weaveAgent`'s pinned `model: Model` slot but is called fresh on every tick.
- `createAgenticTaskHandler` accepts both: `model?: Model` (pinned, parity with `weaveAgent`) and `modelResolver?: ModelResolver` (per-tick). At construction at least one MUST be provided or it throws. Never strip pinned `model` support — tests and short-lived agents rely on it.
- Fallback chain (single source of truth: `resolveModelForTick(resolver, pinned, ctx)`): resolver returns `Model` → use it; resolver returns `undefined` → fall back to pinned; resolver throws → fall back to pinned and capture `error` in `ResolvedModel.error`; neither available → throw a clear error mentioning both slots.
- `weaveModelResolver({ model })` is the canonical in-memory factory (pinned wrapper). `weaveModelResolverFromFn(fn)` lifts an existing routing callback into the resolver shape. `composeModelResolvers([a, b, c])` chains resolvers — first non-undefined wins, throws are logged and treated as undefined.
- `ModelResolverContext` carries `{ role, capability, agentId, meshId, tenantId, runId, stepId }`. Callers SHOULD populate as many fields as they have so DB-backed resolvers can route on role/task/run.
- DB-backed resolver (`weaveDbModelResolver`) belongs in `@weaveintel/live-agents-runtime` (Phase 2 of the plan). The `live-agents` package never imports DB types.
- `HandlerContext.modelResolver` (in `@weaveintel/live-agents-runtime/src/handler-registry.ts`) is the runtime-side slot. The built-in `agentic.react` handler accepts either `ctx.model` or `ctx.modelResolver`; geneweave or any consumer fills whichever it has.
- GeneWeave kaggle: `KaggleRoleHandlersOptions` accepts `modelResolver?: ModelResolver` (preferred) alongside the legacy `resolveModelForRole?` callback (deprecated alias kept for back-compat). The strategist wrapper prefers `modelResolver` when both are set. The legacy callback will be removed in Phase 5.
- Example: `examples/91-live-agents-model-resolver.ts` demonstrates pinned, rotating, composed, and fallback patterns end-to-end with no external services.

### Phase 2 — DB-backed `ModelResolver` + per-agent overlay (complete)
- `weaveDbModelResolver` lives in `@weaveintel/live-agents-runtime` (NOT `@weaveintel/live-agents`). It accepts injected adapters — `listCandidates`, `routeModel`, `getOrCreateModel` — so the runtime package never imports geneweave or `@weaveintel/routing` types. Anything DB-shaped is wrapped at the consumer boundary.
- Sequence per tick: `listCandidates(ctx)` → `routeModel(candidates, hints)` (taskType derived from `ctx.capability?.task ?? roleTaskMap[ctx.role] ?? defaultTaskType ?? 'reasoning'`; prompt = `live-agent-<role>`) → `getOrCreateModel(provider, modelId)`. Returns the Model with `id` tagged via `Object.defineProperty` for log clarity (skip with `tagModelId: false`). All failure modes return `undefined` so the live-agents fallback chain (Phase 1) lands on the pinned `model`.
- `weaveAgentOverlayResolver({ base, getAgentRow, loadPinnedModel?, appendAuditEvent? })` wraps any base resolver with per-agent intent encoded in the `live_agents` row:
  - `model_pinned_id` set → bypass routing, call `loadPinnedModel(pinnedId)`. Throws fall back to `base`.
  - `model_capability_json` set → merge into `ctx.capability` (deep-merged with existing), then delegate. `model_routing_policy_key` is forwarded as `capability.hints.policyKey`.
  - Neither set OR no agentId → delegate to `base` untouched.
- Audit trail: every successful resolution emits a `live_run_events` row of kind `'model.resolved'` via `appendAuditEvent` (only when `runId` and the writer are both supplied). Audit failures are swallowed — never block resolution.
- `createHeartbeatSupervisor` (in `@weaveintel/live-agents-runtime`) accepts `modelResolver?: ModelResolver` alongside the existing pinned `model` slot. Threaded into `HandlerContext` so any handler (built-in `agentic.react` or custom) prefers the resolver when present and falls back to pinned.
- GeneWeave consumers (`apps/geneweave/src/live-agents/kaggle/heartbeat-runner.ts` and `apps/geneweave/src/live-agents/generic-supervisor-boot.ts`) construct exactly **one** `weaveDbModelResolver` per supervisor by wrapping `routeModel(db, ...)`, `getOrCreateModel(...)`, and `listAvailableModelsForRouting(db)` (kaggle) or a `model_pricing` enumeration (generic). The legacy `resolveModelForRole(role, hint)` closure is now a thin shim over `dbModelResolver.resolve({ role, capability })` for back-compat — slated for removal in Phase 5.
- `agent-model-resolver.ts` in geneweave re-exports `weaveAgentOverlayResolver`, `WeaveAgentOverlayResolverOptions`, and `ModelResolvedAuditEvent` from the runtime package. The legacy `resolveLiveAgentModel` function + cache are retained for back-compat only (no external callers; safe deletion in Phase 5).
- Example: `examples/92-live-agents-db-routing.ts` demonstrates the round-robin resolver and pinned overlay end-to-end with stub adapters and no external services. Audit events print inline so the resolution trail is visible.

### Phase 3 — `LiveAgentPolicy` (complete)
- `LiveAgentPolicy` lives in `@weaveintel/live-agents/src/policy.ts`. It is the **first-class capability slot** mirroring `weaveAgent`'s pinned `policy: AgentPolicy` and bundles four primitives from `@weaveintel/tools`: `policyResolver?: ToolPolicyResolver`, `approvalGate?: ToolApprovalGate`, `rateLimiter?: ToolRateLimiter`, `auditEmitter?: ToolAuditEmitter`, plus an optional `defaultResolutionContext: Partial<PolicyResolutionContext>`. All four primitives are independently optional.
- `weaveLiveAgentPolicy(opts)` is the user-facing factory; pure passthrough using conditional spreads. `hasAnyPolicyCapability(p)` is the boolean predicate (returns `true` iff any of the four primitives is set; `defaultResolutionContext` alone does NOT count).
- `createAgenticTaskHandler({ policy })` wraps the per-tick `prep.tools` registry with `createPolicyEnforcedRegistry` BEFORE the ReAct loop, but only when `hasAnyPolicyCapability(policy)`. The resolution context per call is `{ ...policy.defaultResolutionContext, chatId: agent.id, agentPersona: opts.role ?? opts.name }`.
- A module-level `permissivePolicyResolver` (returns `DEFAULT_TOOL_POLICY`) is synthesized when the caller omits `policyResolver`. This enables audit-only / rate-limit-only configurations without forcing callers to construct a no-op resolver.
- `HandlerContext.policy?: LiveAgentPolicy` (in `@weaveintel/live-agents-runtime/src/handler-registry.ts`) is the runtime-side slot. The built-in `agentic.react` handler conditionally spreads `ctx.policy` into the handler options. `createHeartbeatSupervisor` accepts `policy?: LiveAgentPolicy` and threads it through the dispatcher into every `HandlerContext`.
- `weaveDbLiveAgentPolicy(opts)` lives in `@weaveintel/live-agents-runtime/src/db-policy.ts`. It is a pure passthrough that accepts already-built DB adapter instances (no DB types in the runtime package); apps construct `DbToolPolicyResolver`, `DbToolApprovalGate`, `DbToolRateLimiter`, `DbToolAuditEmitter` from geneweave and pass them in.
- GeneWeave generic supervisor (`apps/geneweave/src/live-agents/generic-supervisor-boot.ts`) wires the same four DB-backed adapter classes that ChatEngine already uses, so live-agent tool calls and chat tool calls share one policy/audit/approval surface end-to-end.
- The kaggle strategist path (`apps/geneweave/src/live-agents/kaggle/strategist-agent.ts`) is **NOT yet migrated** — follow-up needed to plumb `policy` through `KaggleStrategistAgentOptions` and `createKaggleRoleHandlers`.
- `LiveAgent` declarative metadata for break-glass authority, grant authority, and contract authority (in `live-agents/types.ts`) is **not yet runtime-enforced** — declarative only. Enforcement is a follow-up phase.
- Example: `examples/93-live-agents-policy.ts` demonstrates audit-only, rate-limited (1/min then deny), and approval-required (auto-deny) configurations end-to-end with stub model and tools — no DB or external services required.

### Phase 4 — `weaveLiveAgent` constructor (complete)
- `weaveLiveAgent(opts)` lives in `@weaveintel/live-agents/src/weave-live-agent.ts`. It is the **canonical user-facing constructor** mirroring `weaveAgent({ name, model, tools, systemPrompt, policy, memory, bus, maxSteps })` from `@weaveintel/agents`. New code MUST use `weaveLiveAgent`; `createAgenticTaskHandler` is `@deprecated` and kept only as the underlying impl.
- Returns `{ handler: TaskHandler, definition: LiveAgentDefinition }`. `definition` exposes `name`, `role`, `capabilities` flags (`model`, `modelResolver`, `tools`, `policy`, `memory`, `bus`, `customPrepare`), and the original `options` for introspection by mesh provisioning, observability, and tests.
- Validation throws `TypeError` at construction in two cases (clear messages name both slots): (a) neither `model` nor `modelResolver` supplied; (b) neither `prepare` nor `systemPrompt` supplied.
- When `prepare` is omitted but `systemPrompt` is set, a default prepare is synthesized: `({ inbound }) => ({ systemPrompt, ...(tools && { tools }), userGoal: inbound?.body ?? inbound?.subject ?? '' })`. This is the 80% case for simple long-running agents.
- `memory?: ContextPolicy` and `bus?: LiveAgentBus` are **captured on `LiveAgentDefinition` for introspection only** — runtime wiring (context window pruning, event bus routing) is deferred to Phase 6 (mesh provisioning). Setting them today is forward-compatible but does not yet change handler behavior.
- Underlying impl is unchanged: `weaveLiveAgent` builds an `AgenticTaskHandlerOptions` via conditional spreads and calls `createAgenticTaskHandler(...)`. So all Phase 1–3 capabilities (modelResolver, policy enforcement, audit, approval gate, rate limiting) flow through automatically.
- Migrated call sites: `apps/geneweave/src/live-agents/kaggle/strategist-agent.ts` (kaggle strategist) and `packages/live-agents-runtime/src/handlers/agentic-react.ts` (built-in `agentic.react` handler kind) both call `weaveLiveAgent` and destructure `{ handler }`. The runtime handler still returns a bare `TaskHandler` — `definition` is discarded by the runtime today (mesh provisioning will start consuming it in Phase 6).
- Tests: `packages/live-agents/src/weave-live-agent.test.ts` (8 tests — construction validation, capability flags, default prepare synthesis, end-to-end handler run, policy forwarding).
- Example: `examples/94-weave-live-agent-parity.ts` shows side-by-side `weaveAgent` vs `weaveLiveAgent` with identical-looking signatures and a stub model — no DB or external services required.

### Phase 5 — Delete kaggle bespoke model-routing plumbing (complete)
- The single canonical kaggle model-routing path is `weaveDbModelResolver` (in `@weaveintel/live-agents-runtime`). `buildPlannerModel()` and the `resolveModelForRole(role, hint)` shim closure in `apps/geneweave/src/live-agents/kaggle/heartbeat-runner.ts` are **removed**. `listAvailableModelsForRouting()` is retained as a named function only because the resolver's `listCandidates` callback delegates to it for log clarity.
- The deprecated `resolveModelForRole?:` field on `KaggleRoleHandlersOptions` (in `apps/geneweave/src/live-agents/kaggle/handlers/_shared.ts`) is **removed**. Callers MUST use `modelResolver: ModelResolver`. To wrap an existing per-role callback, lift it via `weaveModelResolverFromFn(...)`.
- `plannerModel?: Model` on `KaggleRoleHandlersOptions` is **retained** as a deterministic static-fallback escape hatch — the strategist falls back to it when the resolver returns `undefined` or throws. This preserves parity with `weaveAgent`'s pinned `model` slot for tests and single-model deployments.
- Agentic-mode trigger in `role-handlers.ts` is now `if (opts.plannerModel || opts.modelResolver)`; the legacy `|| opts.resolveModelForRole` branch is gone.
- Both kaggle (`heartbeat-runner.ts`) and the generic supervisor (`generic-supervisor-boot.ts`) construct exactly **one** `weaveDbModelResolver` per supervisor and pass it to handlers — no per-role wrappers, no per-tick closures.
- The strategist handler (`handlers/strategist.ts`) has a single per-tick model resolution path: `opts.modelResolver.resolve({ role: 'strategist', agentId, meshId, capability: { task: 'reasoning' } })` → on success, rebuild inner ReAct handler with the routed model; on `undefined`/throw, fall back to the static `plannerModel` inner handler.
- Net ~140 LOC removed from the kaggle folder; behavior unchanged. Verified via `npx tsc -b apps/geneweave` (clean) and `vitest run` against `@weaveintel/live-agents` (69 tests) and `@weaveintel/live-agents-runtime` (20 tests).

### Phase 6 — `weaveLiveMeshFromDb` / `weaveLiveAgentFromDb` (complete)
- `weaveLiveMeshFromDb(db, opts)` and `weaveLiveAgentFromDb(db, agentId, opts)` (in `@weaveintel/live-agents-runtime`) are the **canonical user-facing entry points** for booting a DB-driven mesh or hydrating a single agent. They compose every Phase 1–5 primitive (provisioner + handler registry + model resolver + attention policy + heartbeat supervisor + run-state bridge) into one call. New apps MUST use these — do not write bespoke `bootXxxMesh()` wrappers.
- `LiveAgentsDb` (in `db-types.ts`) is the **single aggregated structural interface** these entry points consume. It is the intersection of `ProvisionMeshDb & SupervisorDb & AttentionPolicyDb & AgentToolBindingDb`. The runtime package never imports geneweave types — geneweave's `DatabaseAdapter` satisfies the contract structurally.
- `SingleAgentReaderDb` is the narrow read-only slice for `weaveLiveAgentFromDb` — only `listLiveAgents` + `listLiveAgentHandlerBindings` + the two tool-binding methods are required. Use this for tests and ad-hoc invocation.
- `weaveLiveMeshFromDb` has two operating modes:
  - **Boot existing meshes** (default): supervisor starts and ticks every active mesh in the DB. The common case for long-running services where operators manage meshes via the admin UI.
  - **Provision then boot**: pass `provision: { meshDefId | meshDefKey, tenantId, ownerHumanId, ... }` and the function calls `provisionMesh()` first, then boots. Returns the `ProvisionMeshResult` on `result.provisioned`.
- Composition order inside `weaveLiveMeshFromDb`: (1) optional `provisionMesh` → (2) build/extend `HandlerRegistry` (caller-supplied wins; otherwise `createDefaultHandlerRegistry()` + `extraHandlerKinds`) → (3) `createHeartbeatSupervisor` with `modelResolver`, `policy`, `attentionPolicyKey`, `extraContextFor`, etc. forwarded as-is. Returns `{ provisioned, handlerRegistry, supervisor, stop }` with idempotent `stop()`.
- `weaveLiveAgentFromDb` returns `{ agent, binding, context, handler }` — the handler is fully runnable. Throws on unknown agent id, no enabled binding, or unknown handler kind.
- Conditional spreads (`...(opt ? { opt } : {})`) are mandatory in both files because the runtime package uses `exactOptionalPropertyTypes`. Never assign `undefined` to an optional field.
- Tests: `packages/live-agents-runtime/src/weave-live-mesh-from-db.test.ts` (6 tests — boot, custom registry, single-agent hydration, three error paths). All 26 runtime-package tests pass.
- Example: `examples/96-live-agents-phase6-mesh-from-db.ts` runs end-to-end with an in-memory stub DB and `weaveInMemoryStateStore` — no SQLite, no LLM, no external services.
- GeneWeave migration is **incremental**: the existing `apps/geneweave/src/live-agents/generic-supervisor-boot.ts` continues to compose primitives directly (still works). New consumers (kaggle's next refactor, future domain meshes) MUST adopt `weaveLiveMeshFromDb`.

### Phase 7 — GeneWeave migration onto `weaveLiveMeshFromDb` (complete)
- `apps/geneweave/src/live-agents/generic-supervisor-boot.ts` now calls `weaveLiveMeshFromDb(opts.db, { store, handlerRegistry, modelFactory, modelResolver, policy, resolveSystemPrompt, extraContextFor, attentionPolicyKey, logger })` instead of `createHeartbeatSupervisor` directly. Same primitives, single entry point. Returns `meshHandle.supervisor` to preserve the existing `HeartbeatSupervisorHandle` external contract.
- The kaggle heartbeat (`apps/geneweave/src/live-agents/kaggle/heartbeat-runner.ts`) is **not** migrated to `weaveLiveMeshFromDb` because it is structurally different from a generic supervisor: it owns bespoke per-tick scheduling tied to `kgl_competition_runs`, custom `kgl_run_step` / `kgl_run_event` bridging, and uses low-level `createHeartbeat` workers rather than `createHeartbeatSupervisor`. It already consumes Phase 1–5 primitives correctly (`weaveDbModelResolver`, `resolveAttentionPolicyFromDb`, `createKaggleRoleHandlers` with `modelResolver`). Future refactor would require generalizing `weaveLiveMeshFromDb` to accept a custom scheduler/bridge — out of scope for Phase 7.
- The three geneweave shim files (`agent-model-resolver.ts`, `agent-attention-resolver.ts`, `agent-tool-registry.ts`) were already thin re-exports of `@weaveintel/live-agents-runtime` from earlier phases — no further changes needed.
- Net change in geneweave for Phase 7: ~10 LOC swapped (one import + one constructor call). The bulk of the LOC reduction promised in the original plan was already delivered across Phases 2–5.
- Verified via `npx tsc -b apps/geneweave` (clean) and `vitest run` against `@weaveintel/live-agents` + `@weaveintel/live-agents-runtime` + `apps/geneweave` — all package tests pass; the only failures (`grounding.api.test.ts`) are pre-existing e2e tests that require a running server on `:3500`.

### Phase 8 — Adoption surface: README, ADRs, examples + demo audit (complete)
- `packages/live-agents/README.md` gained a **First-class capabilities** section covering: (1) pinned `model` vs `modelResolver` per-tick, (2) `weaveLiveAgentPolicy` four-primitive bundle, (3) `weaveLiveMeshFromDb` single-call DB hydration, (4) the `weave*`/`create*` naming rule, and (5) a migration cheatsheet table. New adopters land here first.
- ADR 006 — [`docs/live-agents/ADR/006-model-resolver.md`](../docs/live-agents/ADR/006-model-resolver.md) — captures the `ModelResolver` contract: fallback chain (`resolver → pinned → throw`), `ResolverContext` shape, DB-backed implementation in `@weaveintel/live-agents-runtime`, agent-row overlay semantics, audit emission as `live_run_events.kind = 'model.resolved'`.
- ADR 007 — [`docs/live-agents/ADR/007-naming-convention.md`](../docs/live-agents/ADR/007-naming-convention.md) — codifies `weave*` (user-facing constructors that return runnable things) vs `create*` (internal infrastructure factories). Includes the quick decision rule, deprecation policy (one minor cycle for aliases), and migration status table for every public surface.
- **Examples 52–57 audit:** these examples demonstrate deterministic action executors (`createActionExecutor`, `createHeartbeat`) and bus/mesh primitives — they do NOT instantiate LLM agents. They never used `createAgenticTaskHandler`, so they need no migration to `weaveLiveAgent`. Confirmed via `grep` across `examples/` for `createAgenticTaskHandler`. The canonical unified-API examples for new adopters remain `examples/91` (model resolver), `92` (DB routing), `93` (policy), `94` (parity demo), `95` (kaggle-style routing), `96` (`weaveLiveMeshFromDb`).
- **`apps/live-agents-demo` audit:** the demo wires deterministic action executors over an HTTP API with in-memory or Postgres state stores. It does NOT use a DB blueprint to hydrate meshes — meshes/agents/contracts are POSTed via the API at runtime. `weaveLiveMeshFromDb` does not apply (no `live_meshes`/`live_agents` rows to read). The demo continues to import `createHeartbeat` and `createActionExecutor` from `@weaveintel/live-agents` directly. This is the correct boundary; do not force `weaveLiveMeshFromDb` where there is no DB blueprint.
- **Net deliverable:** ~120 LOC docs added, ~280 LOC ADRs added, no LOC removed. The naming convention is now enforceable in code review; the model-resolver contract is now citable in PRs.
- Verified via `npx tsc -b packages/live-agents packages/live-agents-runtime apps/geneweave apps/live-agents-demo` (clean) and `npx vitest run packages/live-agents packages/live-agents-runtime` (95 passed, 4 skipped — Redis/Mongo/DynamoDB integration tests). Smoke-tested `examples/96-live-agents-phase6-mesh-from-db.ts` end-to-end.


