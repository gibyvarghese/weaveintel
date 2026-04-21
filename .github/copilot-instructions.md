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
