# Phase Log

Build history for **weaveIntel / GeneWeave**. This is the relocated narrative that used to
live inline in `copilot-instructions.md`: what each phase added, the design decisions,
gotchas discovered during the build, verification performed, and reference paths
(examples / tests / e2e scripts).

**This file is history, not law.** Forward-looking rules and durable contract facts live in
`copilot-instructions.md`. When a phase here is superseded, fold its durable facts into the
instructions' Contract Reference rather than editing history here.

Two boilerplate notes that originally repeated in nearly every phase have been hoisted into
the instructions' **Build & Test Environment Invariants** and are referenced below as:

- **[DIST]** — after editing `apps/geneweave/src/**`, run `npx tsc -b apps/geneweave`
  before restarting the server/example, or the change has zero runtime effect.
- **[AUTH]** — E2E auth quartet: `set +H`; promote via `UPDATE users SET
  persona='tenant_admin'`; CSRF token from the login response body as `csrfToken`; send as
  `X-CSRF-Token` on mutations.

---

## Tool Platform

### Phase 1 — Runtime Bridge (complete)
- `tool_catalog` table (renamed from `tool_configs`) is the DB-backed registry of all known
  tools; replaces the legacy `tool_configs`.
- `syncToolCatalog(db)` runs at startup to INSERT new `BUILTIN_TOOLS` entries without
  overwriting operator customizations.
- `createToolRegistry()` respects `disabledToolKeys` via `ToolRegistryOptions`. Server
  callers load enabled keys via `db.listEnabledToolCatalog()` and compute the disabled set
  before calling it.
- Admin path `/api/admin/tool-catalog` (old `/api/admin/tools` retired). `ToolCatalogRow`
  is canonical; `ToolConfigRow` is a deprecated alias. New fields: `tool_key`, `version`,
  `side_effects`, `tags`, `source`, `credential_id`. Risk levels migrated from
  `low/medium/high` to the six-value scheme.

### Phase 2 — Tool Policies (complete)
- `tool_policies` table; admin CRUD `/api/admin/tool-policies`; seeded `default`,
  `strict_external`, `destructive_gate`, `read_only`.
- `ToolPolicyResolver` interface in `@weaveintel/tools`; GeneWeave supplies
  `DbToolPolicyResolver`. `createPolicyEnforcedRegistry(registry, opts)` wraps every tool:
  enabled → circuit breaker → risk gate → approval gate → rate limit → timed execute →
  audit emit.
- `createToolRegistry()` accepts `policyResolver`, `auditEmitter`, `rateLimiter`; when a
  `policyResolver` is supplied the returned registry is policy-enforced automatically.
- `ChatEngine` wires `DbToolPolicyResolver` + `DbToolRateLimiter` + `DbToolAuditEmitter`
  into `this.toolOptions`. Rate limiting via `tool_rate_limit_buckets`, 1-minute tumbling
  windows; `checkAndIncrementRateLimit()` is atomic (INSERT OR IGNORE + UPDATE in the same
  window row). `EffectiveToolPolicy.source`: `default | global_policy | skill_override |
  persona_override`. Legacy `consoleAuditEmitter` no longer wired in production.

### Phase 3 — Tool Audit Trail + Health Persistence (complete)
- Every invocation persisted to `tool_audit_events` (UUID PK, outcome, `duration_ms`,
  chat/user/agent context, input/output previews, error, `policy_id`).
  `DbToolAuditEmitter` wraps `db.insertToolAuditEvent()` — best-effort, never throws,
  camelCase→snake_case.
- `startToolHealthJob(db)` runs every 15 min (`setInterval` + `.unref()`), groups the last
  window of audit events by `tool_name`, computes success/error/denied counts, avg + p95
  duration (in-process percentile), error rate, availability → writes one
  `tool_health_snapshots` row per tool.
- Admin: `/api/admin/tool-audit` (append-only list + by-id),
  `/api/admin/tool-health` (live 24h summary + `/:toolName/snapshots`). Both tabs
  `readOnly: true`. Startup order: `seedDefaultData()` → `syncToolCatalog(db)` →
  `startToolHealthJob(db)` → listen.

### Phase 4 — Credentials + External Tool Support (complete)
- `tool_credentials` stores operator-managed credentials; **secrets never in DB**, only
  `env_var_name`. Admin `/api/admin/tool-credentials` (CRUD + `POST /:id/validate`).
- `tool_catalog.config` (nullable TEXT) stores MCP (`{ endpoint }`) / A2A (`{ agentUrl }`)
  config. **`createToolRegistry()` became `async`** — all call sites `await`;
  `buildWorkersFromDb()` in `chat.ts` is async too.
- MCP loading: `source='mcp'` entries use `createHttpMCPTransport()` injecting
  `Authorization` from `env_var_name`. A2A loading: `source='a2a'` entries use
  `buildA2ATool()` wrapping `weaveA2AClient().sendTask()`. Both non-fatal per entry.

### Phase 5 — Tool Simulation + Test Harness (complete)
- Operators run dry-run/live simulations without a real chat session.
  `GET /api/admin/tool-simulation/tools`; `POST /api/admin/tool-simulation` returns
  `{ simulationId, auditEventId, policy, policyTrace, allowed, result?, durationMs }`.
  `policyTrace` steps: `enabled_check → risk_level_gate → approval_gate → rate_limit →
  [execute]`. Dry-run returns the trace but skips execution.
- All simulations emit an audit event with `outcome: 'simulation'` (added to
  `ToolAuditOutcome`). `AdminTabDef.customView` introduced (`'tool-simulation'`). Source:
  `admin/api/tool-simulation.ts`, `ui/tool-simulation-ui.ts`.

### Phase 6 — Skill→Tool Policy Closure + Approval Workflow (complete)
- A skill's `toolPolicyKey` is passed as `skillPolicyKey` in `PolicyResolutionContext` so
  every tool call in that session is evaluated under the skill's policy.
- Tools whose policy has `requireApproval: true` are blocked; the gate creates a
  `tool_approval_requests` row (`pending`). Admin `/api/admin/tool-approval-requests`
  (list + by-id + `/approve` + `/deny`, 409 if already resolved, all auth-gated).
  `DbToolApprovalGate` inserts the rows. Example `examples/34-skill-tool-policy-approval.ts`.

---

## Prompts Platform (`@weaveintel/prompts`)

### Phase 2 — Fragments, Frameworks, Lint, Unified Render, Adapters (complete)
- Fragment inclusions `{{>key}}`: `resolveFragments`, `InMemoryFragmentRegistry` /
  `fragmentFromRecord`, `extractFragmentKeys`; circular refs detected (max depth 5).
  `prompt_fragments` table + `/api/admin/prompt-fragments`.
- Frameworks: `renderFramework`, `defaultFrameworkRegistry` (`rtce`, `full`, `critique`,
  `judge`); only `SYSTEM_SECTIONS` (`'role'`) maps to system. `prompt_frameworks` table.
- Lint: `lintPromptTemplate` with nine rules; helpers `hasLintErrors`, `topLintSeverity`,
  `formatLintResults`; attach `lintResults` to spans when non-empty.
- `renderWithOptions()` is the unified path (fragment expand → optional lint →
  interpolation) returning `RenderResult`. Adapters: `openAIAdapter`, `anthropicAdapter`,
  `textAdapter`, `systemAsUserAdapter`, `resolveAdapter`. `chat.ts` loads enabled DB
  fragments and expands `{{>key}}` before rendering; expansion failure is non-fatal.

### Phase 5 — Version & Experiment Resolution (complete)
- `resolvePromptRecordForExecution()` is the shared resolver. Order: requested override →
  active experiment weighted variant → active published version → latest published → base
  prompt fallback. Empty/unavailable tables fall back without failing the request.
- DB tables `prompt_versions`, `prompt_experiments`. Capture resolution metadata
  (`source`, `resolvedVersion`, `selectedBy`, experiment metadata) in message metadata.

### Phase 7 — Prompt Evaluation and Optimization (complete)
- Dataset-driven evaluation (`PromptEvalDataset`) in `@weaveintel/prompts` +
  `@weaveintel/evals`; reusable rubric judge adapters + normalized score helpers.
- Optimizer selection/config DB-managed (key, kind, config, enabled). Persist evaluation
  runs and optimization runs as first-class records. Capture baseline-vs-candidate evidence
  (`avgScore`, pass/fail counts, diff metadata, optimizer key). Admin exposes eval
  datasets, eval runs, optimizers, optimization runs with safe defaults (draft status,
  conservative thresholds).

---

## Cross-cutting Adoption

### Phase 8 — Observability and Runtime Adoption (complete)
Add observability schemas in shared packages first; keep capability telemetry grounded in
code (emitted from runtime hooks, stored in DB-backed traces); wire new shared helpers into
existing trace persistence and dashboards rather than app-only stores; keep capability
descriptions model-facing.

### Phase 9 — Modularization and Reusability (complete)
Reusable admin schema primitives go in shared packages first (`@weaveintel/core`); extract
large GeneWeave files by capability domain and re-compose from index modules; new capability
records stay DB-driven end-to-end (schema + adapter + admin CRUD + runtime resolution in one
change set); preserve model-facing descriptions and operator UX (explicit labels, safe
defaults, JSON hints).

---

## Scientific Validation (`sv:`)

### Design patterns
- `SVWorkflowRunner` instantiated once at startup, passed to `registerSVRoutes`. Never
  per-request. Model factories on `SVRunnerOptions` are **async**. Specialist agents
  (literature, statistical, mechanistic, simulation, synthesis, critique) composed inside
  the runner; the router never invokes agents directly.
- `SvHypothesisStatus`: `queued|running|verdict|abandoned`; terminal set
  `{verdict, abandoned}`. `SvClaimType`: `mechanism|epidemiological|mathematical|
  dose_response|causal|other` (never `empirical`).
- Tables (UUID PK): `sv_hypothesis`, `sv_sub_claim` (no `rationale`/`status`), `sv_verdict`,
  `sv_evidence_event` (no `tenant_id`), `sv_agent_turn`.

### Phase 6 — API routes, idempotency, auth, tests (complete)
- 7 routes via `registerSVRoutes(router, db, json, readBody, runner)`. `Idempotency-Key`
  required on submit + reproduce; replays return the original response (24h TTL store,
  namespaced `hypotheses:<key>` / `reproduce:<key>`). Every route 401 when `auth` is null;
  tenant isolation via `db.getHypothesis(id, tenantId)`. Tests:
  `sv-routes.test.ts` (31) + 8 integration tests in `api.test.ts`.

### Phases 7–9 — UI (complete, Playwright verified)
- Three views (`sv-submit-view`, `sv-live-view`, `sv-verdict-view`) exported from the
  feature barrel. State: `svView` (`submit|live|verdict`), `svHypothesisId`,
  `svHypothesis`, `svVerdict`. SSE via `EventSource({ withCredentials: true })`, event
  types `evidence|turn|verdict|keepalive`; `MutationObserver` cleanup on DOM removal.
  `globalThis.state` exposed for Playwright. Selector contracts on placeholders/headings.
  E2E `sv-ui.e2e.ts` (8 tests).

### Eval corpus
- `evals/corpus.json` — 20 curated hypotheses (5 known-true / false / ill-posed / p-hacked).
  `evals/run-corpus.ts` CLI runner; target accuracy ≥ 85% on true/false/p-hacked.
  `expectedVerdict`: `supported|refuted|inconclusive|needs_revision`.

### SV tool + SSE notes
- 18 SV tools registered only for SV agents via `toolMap` (not in `tool_catalog`, not
  operator-policy-managed). SSE uses `pollRows` async generator, keepalive every 15s,
  `try/finally` cleanup, max 5-minute stream.

---

## Live-Agents Framework

### Phases 14–16 — core framework (complete)
Mesh + agents (`createMesh`, `mesh.spawnAgent` with `attentionPolicy`), immutable contracts
+ evidence, heartbeat scheduler (every 10 min) + attention policy + ticks (time-based and
event-based), account binding (humans only, immediate revocation), MCP integration (env-var
credentials, account-binding-scoped), cross-mesh bridges (source registers, target
approves, either revokes). Reference impl `apps/live-agents-demo`, examples 52–58, ADRs in
`docs/live-agents/ADR/`.

### Capability parity Phase 1 — `ModelResolver` (complete)
- First-class per-tick model slot mirroring `weaveAgent`'s pinned `model`.
  `createAgenticTaskHandler` accepts both `model?` and `modelResolver?` (≥1 required).
  Fallback chain `resolveModelForTick`: resolver `Model` → use; `undefined` → pinned;
  throw → pinned + capture error; neither → throw naming both slots. Factories:
  `weaveModelResolver`, `weaveModelResolverFromFn`, `composeModelResolvers`.
  `ModelResolverContext` carries role/capability/agent/mesh/tenant/run/step. Example
  `examples/91`.

### Phase 2 — DB-backed `ModelResolver` + per-agent overlay (complete)
- `weaveDbModelResolver` in `@weaveintel/live-agents-runtime` (never imports geneweave /
  routing types). Per tick: `listCandidates → routeModel → getOrCreateModel`; all failures
  return `undefined` → land on pinned. `weaveAgentOverlayResolver` reads
  `live_agents.model_pinned_id` / `model_capability_json` / `model_routing_policy_key`.
  Emits `live_run_events` kind `model.resolved` (best-effort). `createHeartbeatSupervisor`
  accepts `modelResolver?`. Example `examples/92`.

### Phase 3 — `LiveAgentPolicy` (complete)
- Bundles `policyResolver?`, `approvalGate?`, `rateLimiter?`, `auditEmitter?` +
  `defaultResolutionContext`. `weaveLiveAgentPolicy(opts)` factory;
  `hasAnyPolicyCapability(p)` predicate. Handler wraps `prep.tools` with
  `createPolicyEnforcedRegistry` before the ReAct loop when any capability present; a
  `permissivePolicyResolver` is synthesized when omitted (enables audit-only / rate-only).
  `weaveDbLiveAgentPolicy` in the runtime package accepts pre-built DB adapters. Kaggle
  strategist fully migrated. Example `examples/93`.

### Phase 4 — `weaveLiveAgent` constructor (complete)
- Canonical user-facing constructor mirroring `weaveAgent`. Returns `{ handler, definition
  }`. Throws `TypeError` when neither `model`/`modelResolver` nor `prepare`/`systemPrompt`
  supplied. Default `prepare` synthesized from `systemPrompt`. `memory`/`bus` captured for
  introspection only (runtime wiring deferred). Migrated: kaggle strategist + built-in
  `agentic.react` handler. Tests `weave-live-agent.test.ts` (8). Example `examples/94`.

### Phase 5 — delete kaggle bespoke model-routing plumbing (complete)
- Single canonical path is `weaveDbModelResolver`. Removed `buildPlannerModel()`, the
  `resolveModelForRole` shim, and the deprecated `resolveModelForRole?` field on
  `KaggleRoleHandlersOptions`. `plannerModel?: Model` retained as static fallback.
  Agentic trigger now `if (opts.plannerModel || opts.modelResolver)`. ~140 LOC removed,
  behavior unchanged.

### Phase 6 — `weaveLiveMeshFromDb` / `weaveLiveAgentFromDb` (complete)
- Canonical DB-driven boot entry points composing every Phase 1–5 primitive.
  `LiveAgentsDb` is the single aggregated structural interface (`ProvisionMeshDb &
  SupervisorDb & AttentionPolicyDb & AgentToolBindingDb`); geneweave's `DatabaseAdapter`
  satisfies it structurally. Two modes: boot existing meshes (default) or
  provision-then-boot. Conditional spreads mandatory (`exactOptionalPropertyTypes`). Tests
  `weave-live-mesh-from-db.test.ts` (6). Example `examples/96`.

### Phase 7 — GeneWeave migration onto `weaveLiveMeshFromDb` (complete)
- `generic-supervisor-boot.ts` now calls `weaveLiveMeshFromDb(...)` instead of
  `createHeartbeatSupervisor` directly (returns `meshHandle.supervisor` to preserve the
  external contract). Kaggle heartbeat **not** migrated — bespoke per-tick scheduling tied
  to `kgl_competition_runs`. ~10 LOC swapped.

### Phase 8 — Adoption surface: README, ADRs, examples + demo audit (complete)
- README "First-class capabilities" section; ADR 006 (ModelResolver), ADR 007 (naming
  convention). Examples 52–57 confirmed not to use LLM agents (no migration needed);
  `apps/live-agents-demo` correctly uses deterministic executors (no DB blueprint, so
  `weaveLiveMeshFromDb` doesn't apply). ~120 LOC docs + ~280 LOC ADRs added.

### Phase 9 — Declarative `prepare()` (complete)
- `live_agents.prepare_config_json` (TEXT, nullable; migration `m22DefAlters` — no
  backticks in the SQL comment). `PrepareConfig` recipe; `parsePrepareConfig(json)` +
  `dbPrepareFromConfig(config, deps)`. Synthesis rules for `systemPrompt` (literal /
  `{promptKey}`), `userGoal` (literal / `{from}` / `{template}` with `{{subject}}`/`{{body}}`),
  `tools: "$auto"`, `memory` (parsed, not enforced). Caller-supplied `prepare` always wins.
  Admin `POST`/`PUT /api/admin/live-agents` accept the field. Generic supervisor wires
  `resolvePromptText`; kaggle not migrated. Tests `db-prepare-resolver.test.ts` (21).
  Example `examples/98`.

### Capability parity & naming (durable summary kept in instructions)
The `weave*` (runnable) vs `create*` (infrastructure) rule, per-tick resolver-injection
rule, and `live_run_events` audit-kind list are now in `copilot-instructions.md`.

---

## Workflow Platform (`@weaveintel/workflows`)

### Phase 1 — Composable DB-driven Steps (complete)
- DB-driven step composition: operators define workflows as `workflow_defs` rows; the
  engine resolves each step's `handler` via a `HandlerResolverRegistry`. No JS handler
  registration at runtime.
- `DefaultWorkflowEngine` (`startRun` synchronous to terminal, `tickRun` for paused).
  `WorkflowDefinitionStore` interface; `InMemoryWorkflowDefinitionStore` in-package, DB
  store over `workflow_defs` in geneweave. Built-in resolvers: `noop`, `script`, `tool`
  (`prompt`/`agent`/`mcp`/`subworkflow` reserved). `describeHandlerKinds(registry)` seeds
  `workflow_handler_kinds`.
- `WorkflowStep` schema, `handler`/`next`/`inputMap`/`outputMap` semantics, and tool-adapter
  shapes are in the instructions' Contract Reference. `workflow_handler_kinds` synced at
  startup preserving operator `enabled`. Admin `POST /api/admin/workflows/:id/run`. Example
  `examples/97`. Tests: `phase1.test.ts` (21) + `workflows.test.ts` (37) +
  `workflow-engine.db.test.ts` (3).

---

## Trigger Platform (`@weaveintel/triggers`)

### Phase 3 — DB-driven triggers (complete)
- Package ships interfaces + dispatcher + JSONLogic-lite filter + rate limiter + built-in
  source/target adapters + `InMemoryTriggerStore`; never imports DB types.
- `TriggerStore` (`list`/`save`/`recordInvocation`, swallows its own failures). Nested
  `Trigger` shape; source/target kinds and invocation statuses in the Contract Reference.
- Dispatch path: enabled → filter (fail-closed) → rate limit → `inputMap` → target lookup
  → `target.dispatch()`; one `TriggerInvocation` per outcome. Host calls
  `dispatcher.reload()` after every CRUD write. `dispatcher.start()` spins one
  `CronSourceAdapter` per enabled cron trigger.
- GeneWeave: `triggers` + `trigger_invocations` tables; `db-trigger-store.ts`;
  `target-adapters.ts` (`createWorkflowTargetAdapter`; other kinds record
  `no_target_adapter`). Admin body snake_case; manual fire matches only `manual` source.
  **Gotcha:** router exposes `del` not `delete`; invocation ids via `crypto.randomUUID()`;
  conditional spreads for serialized optionals. Example `examples/99`. Tests
  `dispatcher.test.ts` (20).

---

## Mesh ↔ Workflow Binding (Phase 4, complete)
- A workflow declares an `outputContract`; the engine emits it via `ContractEmitter` on
  successful completion; geneweave persists to `mesh_contracts` and re-publishes on a Node
  `EventEmitter`; `MeshContractSourceAdapter` consumes the bus and fires
  `contract_emitted` triggers; the trigger target dispatches the next unit.
- `outputContract` round-trips via reserved key `metadata.__outputContract` (no schema
  change). Both `save()` and `rowToWorkflow()` must agree (pack/unpack). REST accepts
  `output_contract` (snake_case). **Collision risk:** explicit `output_contract` silently
  overwrites a user-set `metadata.__outputContract` — documented as known.
- One `EventEmitter` per process, shared by `DbContractEmitter` (publisher) +
  `MeshContractSourceAdapter` (consumer); never module-level state. Emission best-effort.
  Admin readonly `/api/admin/mesh-contracts`. Example `examples/100`. Tests
  `contract-emitter.test.ts` (8) + `db-contract-emitter.test.ts` (2). **[DIST]** burned
  multiple debug cycles this phase.

---

## Workflow Governance / Durability / Replay (Phase 5, complete)
- Four primitives: input-shape governance (`validateWorkflowInput`, ajv-free
  JSON-schema-lite, rejects before any step runs), cost ceilings (`CostMeter` +
  `WorkflowPolicy.costCeiling` → fail + emit `workflow:cost_exceeded`), deterministic
  **ordinal-strict** replay (`WorkflowReplayRecorder` / `createReplayRegistry`;
  `Replay overrun` if more steps than trace), durable persistence (`CheckpointStore`,
  `WorkflowRunRepository` incl. `JsonFileWorkflowRunRepository`).
- `CapabilityPolicyBinding` in `@weaveintel/core`; `resolveCapabilityBinding` returns
  highest-precedence match — **agent=100 > mesh=50 > workflow=10**.
- GeneWeave: `workflow_runs.cost_total`, `workflow_checkpoints`,
  `capability_policy_bindings`; `DbWorkflowRunRepository`, `DbCheckpointStore`. Admin
  `/api/admin/capability-policy-bindings`.
- **Gotchas:** engine caches resolved handlers by `handlerRef` for a run → replay must be
  ordinal-strict. `RunIdCapturingRepo` pattern when a resolver needs the runId before
  `startRun` returns. `HandlerResolveContext` has no `handlerRef` (use
  `ctx.step.handler ?? ctx.step.id`). `createScriptResolver` reads `step.config.script`.
  SQLite 1s precision → `ORDER BY created_at, rowid`. Example `examples/101`. Tests
  `phase5.test.ts` (12) + `workflow-phase5.db.test.ts` (4).

---

## Capability Packs (Phase 6, complete)
- Versioned, exportable bundles of DB rows, installed/uninstalled atomically.
  `validateManifest` (key `lower.dotted.snake_case`, **no hyphens**; semver).
  `installPack` writes nothing if `unmetPreconditions` (→ 412); `uninstallPack` deletes
  exactly the ledger rows (re-uninstall → 409). `resolveActivePackVersion` (semver).
  `PackInstallAdapter` interface.
- GeneWeave: `capability_packs` / `_installations` / `_experiments`;
  `createGeneweavePackInstallAdapter` with 6 buckets (`workflow_defs`, `triggers`,
  `prompts`, `prompt_fragments`, `tool_policies`, `capability_policy_bindings`); 11 admin
  routes.
- **Gotchas:** pack key disallows hyphens (`e2e-1234` rejected; use `e2e_1234`).
  `workflow_defs` bucket row shape must match real `WorkflowDefRow` columns. Install → 412
  on unmet preconditions; re-uninstall → 409. Manifest `authoredBy` (camelCase) maps to
  `authored_by` column. Example `examples/102`. E2E
  `scripts/e2e-phase6-capability-packs.mjs` (27 assertions). **[AUTH]**

---

## Cost Governor Platform (`@weaveintel/cost-governor`)

Reusability invariant throughout: imports only `@weaveintel/core` + `@weaveintel/tools`.
"DB-driven" is a property of the geneweave reference impl, not the package. Every lever is
**never load-bearing**.

### Phase 1 + 2 — Ledger + tier presets + DB resolver (complete)
- `CostTier` (`economy|balanced|performance|max|custom`, default `balanced`). `CostPolicy`
  / `ResolvedCostPolicy` / `resolveCostPolicy`. `TIER_PRESETS` for the four named tiers
  (`custom` skips merge). `weaveCostGovernor(policy)` returns a bundle whose five lever
  resolvers are **no-op stubs in Phase 2**. `CostPolicyResolver` /
  `weaveStaticCostPolicyResolver` / `composeCostPolicyResolvers` /
  `resolveCostGovernorBundle` (per-run override → resolver → package default).
- GeneWeave: `cost_policies` table; reuses `capability_policy_bindings` with
  `policy_kind='cost_policy'`. `DbCostPolicyResolver` walks agent→mesh→workflow.
  Operator-only routes use local `{ json, readBody }` helper. Example `examples/103`. Tests
  (28). E2E `scripts/e2e-phase2-cost-policies.mjs` (21).

### Phase 3 — Prompt Caching (complete)
- `PromptCacheHints`, `CacheShaper`, `weavePromptCachingShaper` (key strategies `static` /
  `role` / `role+phase`), `wrapModelWithCacheHints` (Anthropic: rewrites system into
  `metadata.systemPrompt` content blocks with `cache_control`, drops system from
  `messages`; others: stamps `metadata.promptCacheKey`). OpenAI provider forwards
  `prompt_cache_key`. Errors swallowed → forwarded unchanged.
- **Gotchas:** use `Message` not `StructuredPromptMessage` (`'tool'` role). `ModelInfo.modelId`
  not `.id`. Watch duplicate `Model` import in kaggle. `seedDefaultCostPolicies()` seeds
  4 idempotent rows (stable UUIDs). `cachingModelResolver` composing pattern duplicated in
  generic + kaggle. Example `examples/104`. Tests `cache-shaper.test.ts` (13). E2E (26).

### Phase 4 — Model Cascade (complete)
- `RunCostStateTracker` (per-run signal accumulator, TTL eviction).
  `decideCascadeModel` / `evaluateEscalationRule` (rule kinds `tool_call_failed_count`,
  `json_parse_failed_count`, `step_kind`, `intel_score_below`). `weaveModelCascadeResolver`
  (all errors → `pass-through`; cascade never load-bearing).
  `wrapAuditEmitterWithCascadeTracker`. `ModelCascadeConfig` in `levers_json.modelCascade`.
- **Gotchas:** `runId` is the consumer's responsibility (`ctx.runId ?? ctx.agentId`).
  `chatId === agent.id` for live-agent tool calls. Use `ToolAuditEvent` from
  `@weaveintel/core/tool-lifecycle`. Resolver chain order mandatory: `caching → cascade →
  base` (generic), `caching → cascade → cost-ledger → base` (kaggle). One tracker per
  supervisor. Example `examples/105`. Tests `model-cascade.test.ts` (29). E2E (18).

### Phase 5 — Tool Subset (complete)
- `decideToolSubset`, `weaveToolSubsetFilter`, `applyToolFilterToRegistry`. Strategies
  `all` (pass-through) / `phase` (lookup `ctx.phase`). **Never load-bearing** —
  pass-through on null config / missing phase / no entry / zero overlap / throw.
- Kaggle-only wiring: `costToolFilter` derives phase from `kgl_run_event` `kernel_pushed`
  counts (0→discovery, 1→kernel, ≥2→improvement). Seed row `kaggle_phase_subset`.
- **Gotchas:** core barrel aliases `weaveToolRegistry as createToolRegistry`,
  `weaveTool as defineTool`. `db.listKglRunEvents` is **positional** `(runId, opts)`. Tool
  result shape `{ content: 'ok' }`. Example `examples/106`. Tests `tool-subset.test.ts`
  (14). E2E (24).

### Phase 6 — Intel Gating + History Compaction (complete)
- L4 intel gating: `decideIntelGating`, `IntelScoreProvider` (domain supplies the score —
  no built-in scorer), `weaveIntelGate` → `PromptShape | null`, `shouldKeepSection`,
  section keys `intel_header` / `intel_snippets`. L5 history compaction: `decideCompaction`
  (`none|sliding|summary|hierarchical`), `weaveHistoryCompactor`, `HistorySummarizer`.
  Hard invariants: first system message + last 2 messages always preserved; both levers
  never load-bearing.
- Kaggle: `createDbIntelScoreProvider` (5-signal aggregate); strategist truncates inbound
  body (not the system prompt) to keep the cached prefix stable. `historyCompactor` slot
  declared but unconsumed (ReAct loop owns history). Seed row `kaggle_intel_aware`.
- Repaired pre-existing `cache-shaper.test.ts` drift (Model interface). Example
  `examples/107`. Tests `intel-gating.test.ts` (21) + `history-compactor.test.ts` (13).
  E2E (26).

### Phase 7 — maxSteps + Reasoning + Output Truncation + Budget Gate (complete)
- `decideMaxSteps` / `decideMaxStepsDetailed`; `wrapModelWithReasoningEffort` /
  `wrapModelWithStaticReasoningEffort` (stamps `metadata.reasoningEffort`; OpenAI forwards
  `reasoning_effort`); `weaveToolOutputTruncator` / `wrapToolRegistryWithOutputTruncation`
  (UTF-8-safe byte cap); `weaveBudgetGate` (throws `CostCeilingExceededError`);
  `weaveCostLedgerFromBreakdown`.
- **Critical:** `CostCeilingExceededError` fields are **`runId`, `costUsd`, `ceilingUsd`**
  (never `totalUsd`). Disabled budget gate fast path is **sync** (`{ check: () =>
  undefined }`) — tests must not `await … .resolves`. Model wrapper arg order is
  `generate(ctx, request)`. Wrappers forward `capabilities`, bind `hasCapability`,
  conditional-spread `stream?`. Kaggle resolves the bundle once at boot, passes four scalar
  levers. Seed row `kaggle_full_governor`. Example `examples/108`. Tests
  (max-steps 7 + reasoning 8 + truncation 13 + budget 13 = 41). E2E (27).

### Phase 8 — Intent-RAG Tool Retrieval (complete)
- L3 `'intent-rag'` strategy: per-step top-K tool retrieval via cosine similarity between
  goal text and tool-description embeddings. `Embedder` / `EmbeddingStore` / `GoalResolver`
  / `ToolEmbedding` / `IntentRagConfig`; `cosineSimilarity`, `hashDescription` (pure FNV-1a,
  no `crypto`), `decideIntentRagSubset`, `weaveIntentRagToolSubsetFilter`. Never
  load-bearing across every error path.
- GeneWeave: `tool_embeddings` table (migration `m23ToolEmbeddings`);
  `createDbToolEmbeddingStore`, `createOpenAIEmbedder` (returns null when API key absent),
  `warmToolEmbeddings` (boot block between `syncToolCatalog` and `startToolHealthJob`,
  dynamic imports inside try/catch). Hash + modelId both must match to skip; `includeAlways`
  keys added when in `availableKeys`. Seed row `kaggle_intent_rag`.
- **Gotchas:** `createExecutionContext` re-exported only as `weaveContext`. `BUILTIN_TOOLS`
  in `apps/geneweave/src/tools.ts`. Example `examples/109`. Tests `intent-rag.test.ts`
  (24). E2E (25).

### Phase 9 — Lazy Trace Retrieval (`@weaveintel/live-agents-trace-tools`, complete)
- Generalised the kaggle `kaggle_get_*` trace tools into a domain-agnostic package.
  `createLiveTraceTools({ runId, … })` returns 5 tools (`live_get_run_timeline`,
  `live_get_failed_attempts`, `live_get_recent_events`, `live_get_event_details`,
  `live_get_step_artifact`), each closure-bound to one `runId`. `LiveRunEventReader` /
  `LiveRunStepReader` / `CostSoFarReader` interfaces; `FAILURE_EVENT_KINDS`;
  `payloadByteLimit` default 4000. **Run-isolation invariant:** every tool re-validates
  `row.run_id === closure.runId`. Package depends only on core + tools.
- Recipe extension: `prepare_config_json.tools` is now `'$auto' | { auto?, traceTools?:
  '$auto' }`; `dbPrepareFromConfig` accepts `deps.traceToolsFactory`. Factory throws /
  null → graceful pass-through.
- GeneWeave: `db-live-trace-tools.ts` adapters over `live_run_*`; generic supervisor
  `traceToolsFactory` resolves the active RUNNING run. Kaggle keeps its richer bespoke
  impl over `kgl_run_*` (do not migrate). Example `examples/110`. Tests
  `trace-tools.test.ts` (20) + `db-prepare-resolver.test.ts` (now 33). E2E (20).

### Default-on behavior + coverage matrix
- Cost governor is automatically active for every live-agent tick:
  `resolveCostGovernorBundle` never returns null — no binding → `package_default`
  (`balanced`). `DbCostPolicyResolver` precedence: agent=100 > mesh=50 > workflow=10 >
  tenant=5 > package default. Kaggle workflow id is `'kaggle'`.
- Per-tick on kaggle: all 9 levers. Generic supervisor: L1 + L2 per-tick; L3–L9 slots
  exist but need per-domain wiring. L5 history compaction is a slot-only stub on kaggle
  (ReAct loop owns history). Kaggle trace tools stay bespoke (richer `kgl_run_*` schema).
  L4 / L9 require domain-specific deps the package can't synthesize.

---

## Tenant Encryption (`@weaveintel/encryption`)

Package depends only on `@weaveintel/core` + `node:crypto` throughout. KeyStatus is
`active|previous|revoked` (never `'rotated'`). Sentinel `enc:v1:<epoch>:<iv_b64>:<ct_b64>`,
AAD `tenant|table|column|rowId|epoch`.

### Phase 1 — Envelope encryption engine (complete)
- Per-tenant KEK→DEK hierarchy, AES-256-GCM, versioned epochs.
  `weaveTenantKeyManager({ store, kms, audit })`; `LocalKmsProvider`;
  `loadMasterKeyFromEnv` (`WEAVE_ENCRYPTION_MASTER_KEY`, hex64/base64 → 32 bytes; throws
  `KmsUnavailableError` when absent unless `devGenerateIfMissing`). `EncryptionStore`
  (12 methods), `AuditEmitter` (`noopAuditEmitter`), `mergeFieldPolicy`.
- 6 tables (`tenant_encryption_policy` TEXT timestamps; `tenant_keks/deks/biks` ms-epoch
  INTEGER; `encryption_audit`; `encryption_rewrite_progress`). `createDbEncryptionStore`,
  `createDbAuditEmitter`, `bootstrapEncryption` (non-fatal; returns null when key absent),
  module-level `geneweaveEncryptionManager`. `seedDefaultEncryptionPolicies()` seeds
  `demo-encrypted-tenant` (`enabled=0`).
- **Critical gotcha:** `WrappedKey` (Buffer, KMS internals) vs `SerializedWrappedKey`
  (string, records) — do NOT serialize/deserialize at the DB boundary. Decrypt looks up
  DEK by `(tenantId, epoch)` so `previous` DEKs stay readable. Example `examples/13`. Tests
  (26).

### Phase 2 — Admin REST + lifecycle (complete)
- 10 endpoints under `/api/admin/tenant-encryption-policies` (auth + CSRF). Auto-bootstrap
  on `enabled=1` when `manager_available`. Rotate-dek / rotate-kek / shred (requires
  `{confirm: tenantId}`) / bootstrap / `/keys` (strips `wrapped`) / `/audit`.
- **ESM live-binding pattern (critical):** read `geneweaveEncryptionManager` via
  `import * as indexModule` + `getManager = () => indexModule.geneweaveEncryptionManager`
  — never capture the binding directly. Sidebar wiring in two files. `AuthContext` fields
  are direct (`auth.userId`, `auth.tenantId`).
- **HARD:** package decrypt does NOT gate on key status — under `LocalKmsProvider`, shred
  is audit-grade only; cryptographic shred needs real KMS deletion. Example `examples/14`.
  E2E `scripts/e2e-phase2-tenant-encryption.mjs` (38). **[AUTH]**

### Phase 3 — Chat encryption-at-rest (complete)
- `withTenantEncryptedMessages(db, getManager)` — Proxy intercepting `insertMessage`,
  `getMessage`, `listMessages`. Encrypts on write iff manager + tenantId + policy enabled +
  column in `field_policy.messages.columns`; decrypts any `enc:v1:` sentinel; plaintext
  passes through (lazy-upgrade tolerant). AAD per call.
- `tenant_id` must be populated on the user (registration leaves it NULL). Missing tenantId
  → plaintext (graceful). Rotation advances sentinel epoch; old reads still decrypt.
  **HARD:** DELETE policy → 409 if live keys; shred first. E2E
  `scripts/e2e-phase3-chat-encryption.mjs` (34).

### Phase 4 — Coverage expansion across PII tables (complete)
- Generalised into `weaveTenantEncryptedProxy<DB>({ db, getManager, specs })` with
  `EncryptedMethodSpec` (roles `insert|read-single|read-list`). `withTenantEncryptedDb` is
  canonical; `withTenantEncryptedMessages` is a back-compat alias. Coverage:
  `messages` (`content`, `metadata`) + `chats` (`title`). **Positional-arg escape hatch**
  for `updateChatTitle(chatId, newTitle, userId?)`.
- Kill-switch (`enabled=0`) applies to new writes only; existing ciphertext still decrypts.
  Cross-epoch reads work across all wrapped tables. Example `examples/15`. E2E
  `scripts/e2e-phase4-multi-table.mjs` (45).

### Phase 5 — Automated DEK Rotation Scheduler (complete)
- `startEncryptionRotationScheduler({ db, getManager, intervalMs? })` (default 1h,
  `.unref()`, live-binding getter). `SCHEDULE_THRESHOLDS_MS` (monthly/quarterly/annual);
  `'manual'` skipped. `SCHEDULER_ACTOR = 'system:rotation-scheduler'`. **Strict `>`
  boundary.** Per-tenant try/catch.
- **Critical:** audit emission lives inside `manager.rotateDek` — scheduler must NOT
  double-emit. Audit column `event_kind` (snake_case at DB/REST; camelCase `eventKind` in
  package). E2E helper `scripts/_phase5-tick-once.mjs`; E2E
  `scripts/e2e-phase5-rotation-scheduler.mjs` (29). Tests
  `rotation-scheduler.test.ts` (8). zsh launcher: use a `/tmp/start-*.sh` file.

### Phase 6 — GDPR hard-shred + Tenant deletion lifecycle (complete)
- `EncryptionStore.deleteAllWrappedMaterial(tenantId)`; `manager.hardShred` (shred →
  delete wrapped material → emit `tenant_purged`); `manager.restoreFromShred` (one-shot
  un-shred while keys still present); `weavePurgeScheduler` (generic;
  `PURGE_SCHEDULER_ACTOR = 'system:purge-scheduler'`, **strict `<=` boundary**).
- GeneWeave: `tenant_deletion_requests` table; `startEncryptionPurgeScheduler`; 5 admin
  endpoints (request-deletion, cancel-deletion, restore-from-shred, list, by-id).
- **Critical:** hard-shred irreversible under `LocalKmsProvider`; restore works only while
  `revoked` keys remain (before purge). Purge `retention_until <= now`. Package-side audit
  only. Example `examples/16`. E2E `scripts/e2e-phase6-tenant-deletion.mjs` (33). Tests
  `purge-scheduler.test.ts`.

### Phase 7 — Cloud KMS Provider Registry (complete)
- `KmsProviderRegistry` (register/list/build/healthCheck); `defaultWrapUnwrapHealthCheck`;
  `createCachedKmsResolver` (cache key includes config hash, falls back to default
  provider); `createBuiltinKmsRegistry` (5: `local|aws-kms|azure-kv|gcp-kms|vault`).
  `weaveTenantKeyManager` gains `kmsResolver`. New audit kind `kms_health_check`.
- GeneWeave: bootstrap returns `{ manager, registry, resolver, source }`; module-level
  `geneweaveKmsRegistry` / `geneweaveKmsResolver`; 2 admin endpoints (list providers +
  health-check). Provider validated at write time (400 on unknown); cache invalidated after
  upsert. **Cloud SDKs stay lazy** (`import()` inside provider wrap/unwrap). E2E
  `scripts/e2e-phase7-kms-providers.mjs`. Docs `docs/ENCRYPTION_KMS_PROVIDERS.md`.

### Phase 8 — Blind Indexes (complete)
- Companion `<column>_bidx` = `HMAC-SHA-256(BIK, "table|column|value")` truncated to 24
  hex. `computeBlindIndex`, `rotateBik` (epoch+1, prior → previous; **must follow with
  rebuild**), `BlindIndexSpec` / `DEFAULT_BLIND_INDEX_SPECS` (`users.email`),
  `bidxColumnName`, `maybeBlindIndex` (null on disabled/sentinel/empty),
  `computeRowBlindIndices`. New audit kinds `bik_*` / `bidx_*`.
- GeneWeave: `users.email_bidx` + index; reserved `__system__` tenant for cross-tenant
  equality (login by email); proxy intercepts `createUser`/`updateUser`/`getUserByEmail`
  (bidx lookup first, plaintext fallback — lazy-upgrade). Admin `rotate-bik` +
  `rebuild-bidx` (id-cursor paging; no-op for non-`__system__` until apps register scopes).
- **HARD:** equality-only (no range/prefix/LIKE); `rotateKek` does not re-wrap BIKs.
  Runbook: enable → rebuild → (rotate → immediately rebuild). E2E
  `scripts/e2e-phase8-blind-indexes.mjs`. Docs `docs/ENCRYPTION_BLIND_INDEXES.md`.

### Phase 9 — Observability + Alert Evaluator (complete)
- `MetricsEmitter.record()` (**synchronous, fire-and-forget**); bounded
  `InMemoryMetricsEmitter` (cardinality cap + ring buffer; `snapshot()` with p50/p95/p99);
  `noopMetricsEmitter`; `startTimer`; pure `evaluateAlerts` (rule kinds `rotation_overdue`,
  `kms_error_rate`, `aead_error_rate`, `decrypt_latency_p95`, `cache_hit_rate`);
  `DEFAULT_ALERT_RULES`. Instrumentation already in `key-manager.ts` + `kms-resolver.ts`.
- GeneWeave: `tenant_encryption_alert_config` (fleet rule `tenant_id IS NULL` + per-tenant
  override coexist via expression index; manual select-then-upsert, NOT `ON CONFLICT`);
  module-level `geneweaveEncryptionMetrics`; `seedDefaultAlertRules` (idempotent); admin
  `/encryption/health`, `/encryption/metrics`, `/encryption/alerts*`.
- **Keep labels low-cardinality** (`tenantId/table/column/provider/kind/cache`). Alert
  config is DB-driven (seed is not the runtime source of truth). E2E
  `scripts/e2e-phase9-observability.mjs`. Docs `docs/ENCRYPTION_OBSERVABILITY.md`.

### Phase 10 — BYOK / HYOK / break-glass / attestation (complete)
- Layering (do not violate): `packages/encryption/src/byok/` is pure crypto
  (`node:crypto` + core); `apps/geneweave/src/encryption/byok-service.ts` is host glue
  (persists `tenant_byok_config`, mirrors into `tenant_encryption_policy.kms_config` so the
  cached resolver routes through `byok-pem`); `admin/api/tenant-byok.ts` is thin HTTP.
- **HARD invariants:** RSA-4096 minimum (enforced at package boundary → 400); HYOK secrets
  never in DB (store env var *name* only); dual approval non-bypassable + 24h cap;
  attestation uses canonical JSON (recursively sorted keys) → SHA-256 `payload_hash` →
  Ed25519; `payload_hash` recomputable; audit chain append-only + tip-anchored; mirror not
  duplicate config (preserve existing policy fields); audit `actor` always populated.
- 4 tables (`tenant_byok_config`, `tenant_break_glass_request`, `tenant_attestation_log`,
  `system_attestation_signing_key`). E2E `scripts/e2e-phase10-byok.mjs`. Tests
  `byok/byok.test.ts` (28). Docs `docs/ENCRYPTION_BYOK_HYOK.md`.

---

## Known pre-existing issues (do not fix unless asked)
Pre-existing tsc errors in `examples/86, 92, 95, 97` and
`comprehensive-live-agents-workflow.ts` use older live-agents/workflow API surfaces.
Building `apps/geneweave` + the relevant packages is clean.

---

## weaveIntel Platform Foundation — W1-W10 (complete)

Ten workstreams delivering an interaction-model-agnostic client-app platform
foundation on top of the existing geneWeave runtime. All code lives in shared
packages and is consumed by apps as thin wiring — no app-local reimplementation.

### W1 — Core type foundations
- `RunStatus`, `RunOrigin`, `RunHandle` in `@weaveintel/core` (`run.ts`).
- `SurfaceCatalog`, `CatalogEntry`, `SurfaceCatalogRequest`, `SurfaceCatalogResolver` in `@weaveintel/core` (`surface-catalog.ts`).
- `HumanTask` extended with `WidgetPayload`, `HumanTaskPriority`, `TaskProvenance`.
- 17 tests: `packages/core/src/w1-run-types.test.ts`.

### W2 — Widget builders
- `@weaveintel/ui-primitives`: widget builders (`buildTextWidget`, `buildCardWidget`,
  `buildFormWidget`, `buildListWidget`, `buildProgressWidget`, `buildActionWidget`);
  widget-action helpers (`buildButtonAction`, `buildLinkAction`, `buildSubmitAction`);
  `WidgetRegistry` with version-stamped slot management.
- 14 tests: `packages/ui-primitives/src/w2-widgets.test.ts`.

### W3 — Run registry + journal
- `RunRegistry` and `RunJournal` added to `@weaveintel/collaboration`.
- `RunRegistry`: create/get/update/list with status transitions and last-event cursor.
- `RunJournal`: append-only ordered event log, resumable via `afterSequence`.
- 12 tests: `packages/collaboration/src/w3-run-registry.test.ts`.

### W4 — Notification dispatcher
- `@weaveintel/notifications`: channel abstractions (`WebPushChannel`, `ApnsChannel`,
  `FcmChannel`); `NotificationRegistry` for multi-channel dispatch; typed subscription
  management; `NotificationDispatcher` with batch/fanout.
- 25 tests: `packages/notifications/src/w4-notifications.test.ts`.

### W5 — Action-item tasks
- `@weaveintel/human-tasks` extended: `createActionItem`, `completeActionItem`,
  `cancelActionItem` with bus emission. `listByAssignee` on all 5 store backends.
- 15 tests: `packages/human-tasks/src/w5-action-items.test.ts`.

### W6 — Trigger provenance + reminders
- `@weaveintel/triggers`: `ownerPrincipalId`, `tenantId`, `provenance` fields on
  `Trigger`; `listByOwner` on all 5 store backends (sqlite, postgres, mongodb, +
  in-memory + db-backed).
- `createReminderTrigger`, `rescheduleReminder`, `ReminderBusTargetAdapter` (emits
  `reminder.due`, auto-disables one-shot triggers).
- 13 tests: `packages/triggers/src/w6-triggers.test.ts`.

### W7 — Client SDK
- `@weaveintel/client`: `sseTransport` / `fetchJsonTransport` / `mockSseTransport`;
  `streamReducer` + `emptyRunViewModel` (idempotent, handles all run event kinds);
  `createRunClient` with `startRun`, `listRuns`, `getRun`, `cancelRun`, `attach`
  (auto-reconnect + resume via `afterSequence`), `postEvent`; `createRunOutbox`
  (offline queue, `MemoryStorage`).
- 17 tests: `packages/client/src/w7-client.test.ts`.

### W8 — Surface catalog resolver
- `createSurfaceCatalogResolver` in `@weaveintel/identity`: multi-source fanout with
  per-entry `accessCheck` (fail-closed), in-memory TTL cache keyed by
  `${tenantId}::${userId}::${surfaceId}`, and ambient `catalog.resolved` tracer span.
- 11 tests: `packages/identity/src/w8-surface-catalog.test.ts`.

### W9 — geneWeave user-scope API
- Migration `m41-platform-foundation`: tables `user_runs`, `user_run_events`,
  `user_devices`, `notification_preferences`, `mode_labels`, `starter_prompts`.
- `IMeStore` interface + `SQLiteAdapter` implementation.
- `registerMeRoutes`: all `/api/me/*` routes — runs (CRUD + SSE stream + cancel +
  idempotency), catalog, tasks, reminders, devices, notification-prefs.
- 21 tests: `apps/geneweave/src/routes/w9-me.test.ts`.

### W10 — Docs, examples, vocab lint
- `examples/139-detachable-run.ts`: detachable run + resume via `@weaveintel/client`.
- `examples/140-action-item-reminder.ts`: action-item + reminder lifecycle end-to-end.
- `examples/141-surface-catalog.ts`: surface catalog for 2 resolvers (user vs admin).
- `scripts/check-vocab-w9.mjs`: vocab lint that fails if W1-W10 packages export
  banned interaction-model terms (`conversation`, `chatHistory`, `chatSession`,
  `messageHistory`, `turnHistory`). Run via `npm run check:vocab-w9`.
- All 3 examples type-clean and execute (`npx tsx examples/139-...` etc.).

### W9b — Audit-gap closure (user surface fully wired)
Source-level audit of `main` found four W9 gaps where capabilities existed in
shared packages but were not wired through geneWeave. All four are now closed,
additive-only, each with package-consistent unit tests plus one live-server e2e.

- **Gap 1 — user-authored memory** (commit `2c10694`). `registerMeMemoriesRoutes`
  (`apps/geneweave/src/routes/me-memories.ts`): `GET/POST/PATCH/DELETE
  /api/me/memories`, reusing the existing `semantic_memory` + `entity_memory`
  tables (Option A). Corrections supersede the prior row (lineage preserved);
  superseded originals are hidden from the active list. Migration `m42` adds
  `semantic_memory.metadata` + `notification_preferences.timezone`. 10 tests
  (`w9b-me-memories.test.ts`).
- **Gap 2 — surface catalog** (commit `746bc02`). `createMeCatalogResolver`
  (`apps/geneweave/src/me-catalog.ts`) wires `@weaveintel/identity`’s
  `createSurfaceCatalogResolver` over four fail-soft sources (mode-labels,
  live-agents, models, skills). `GET /api/me/catalog` now resolves via the
  shared resolver with a fail-closed `accessCheck` (tenant_user does not see the
  `agent` kind; tenant_admin does). 6 tests (`w9b-catalog.test.ts`).
- **Gap 3 — notification dispatcher** (commit `063de8a`). `createNotificationsHub`
  (`apps/geneweave/src/notifications-wiring.ts`) wires `@weaveintel/notifications`:
  preference-backed `SuppressionPolicy` (master toggle, category allow-list,
  quiet hours evaluated in the stored timezone, fail-closed), device-backed
  `TargetStore`, and lifecycle helpers (`notifyRunTerminal` detached-only,
  `notifyTask` high-priority approve/deny for actionable items, `notifyReminderDue`).
  New `POST /api/me/notifications/actions` resolves a task decision idempotently
  (terminal → `alreadyResolved`; cross-principal → 404). Deep links are opaque
  `geneweave://` URIs. 17 tests (`w9b-notifications.test.ts`).
- **Gap 4 — admin catalog CRUD** (commit `b56007d`). `registerAdminCatalogRoutes`
  (`apps/geneweave/src/admin/routes/catalog.ts`): `GET/POST/PUT/DELETE
  /api/admin/mode-labels` and `/api/admin/starter-prompts`, on the admin router
  (`admin:tenant:write` RBAC gate). New adapter methods enforce the unique
  `(surface_id, mode_key)` constraint and the at-most-one-default-per-surface
  invariant transactionally. Validation: surface allow-list `web|desktop|mobile`,
  `label ≤ 80`, `mode_key ≤ 40`, `prompt_text ≤ 500`. 9 tests
  (`w9b-admin-catalog.test.ts`).
- **Live e2e** (commit `95b32ea`): `scripts/e2e-w9b-user-surface.mjs` — 32
  assertions against a running server exercising all four gaps through the real
  SQLite adapter, router, and RBAC gate.
- Validation: full `npx turbo build` clean (83/83); the four new suites (42 tests)
  plus the W9 suite (21) all green; `check:vocab-w9`, `check:no-adhoc-resilience`
  clean. The 47 remaining suite failures and the 8 `check:no-raw-fetch` violations
  in `packages/client` + `packages/notifications` are pre-existing on `main`
  (identical at base `13a8e06`), unrelated to W9b.
- W1-W10 packages pass vocab lint with zero violations.

---

## geneWeave Mobile (clients/mobile)

### M0 — Repo scaffold
- Monorepo workspace entry `clients/mobile` with Expo SDK 52, React Native 0.76,
  Expo Router 4, new architecture enabled.
- `@geneweave/api-client` and `@geneweave/tokens` as workspace peers.
- Pure lib layer `src/lib/` testable in Node via vitest (no RN imports).
- Device layer `src/native/` + Expo Router screens `app/` are device-gated.

### M1 — Server picker
- `app/(auth)/server.tsx` — host validation + friendly error messages.
- `src/lib/auth/host.ts` + `host-probe.ts` — normalise URL, probe catalog endpoint.
- `src/lib/config/env.ts` — `EXPO_PUBLIC_DEFAULT_HOST`, `EXPO_PUBLIC_TENANT_ID`.

### M2 — Biometric gate
- `src/lib/auth/biometric-gate.ts` — cold-start lock + re-lock window logic.
- `src/native/adapters/expo-biometric.ts` — `BiometricAuthenticator` over
  `expo-local-authentication` (Face ID / Touch ID).
- `app/(auth)/unlock.tsx` — biometric prompt screen.

### M3 — Auth + navigation shell
- Full auth state machine: `createAuthController` + `AuthStore` (observable).
- Per-tenant token namespacing in SecureStore (`tenant@host` scope).
- `app/(tabs)/_layout.tsx` — four-tab navigator themed from `@geneweave/tokens`.
- `useProtectedRoute` — auth-state → route-group switching.
- `src/native/composition-root.ts` — single assembly point for native adapters.
- 4 test files; `e2e-m3-mobile-auth.ts` live-server E2E.

### M4 — Chat surface
- `app/(tabs)/index.tsx` — composer + inverted streaming transcript.
- `src/lib/chat/chat-session.ts` — streaming run lifecycle (send, stop, edit, regen,
  20s background-detach window).
- `src/native/adapters/rn-sse-transport.ts` — XHR-based SSE transport (no
  streaming `response.body` on RN).
- Markdown rendering + tool-call line components.

### M5 — Memory management
- `app/memory.tsx` — memory list with CRUD (create, correct, delete, clear all).
- `src/lib/memory/memory-list.ts` — kind segmentation, provenance labels, validation.
- Widget render spec parser + fixtures for dev gallery (`app/widget-gallery.tsx`).

### M6 — Conversation history
- `app/(tabs)/chats.tsx` — searchable, sortable list (pin / archive / rename).
- `src/lib/conversations/conversation-list.ts` — filter, section, sort, relative timestamps.

### M7 — Actions tab (tasks, reminders, approvals)
- `app/(tabs)/actions.tsx` — segmented Approvals / Action Items / Reminders.
- Optimistic mutations with rollback for all task/reminder operations.
- `src/lib/actions/action-list.ts` — badge math, snooze targets, due-today predicate.

### M8 — Profile, settings, voice
- `app/(tabs)/profile.tsx` — user profile header with manage-on-web link.
- `app/settings.tsx` — notification preferences, quiet hours (IANA timezone encoded).
- `src/lib/settings/notification-prefs.ts` — pure quiet-hours predicate + category helpers.
- `src/native/voice/` — `expo-speech-recognition` adapter + `useVoice` hook.
- Social sign-in (OAuth): `expo-web-browser` adapter, server-discovered providers,
  `SocialSignInButtons`, `useOAuthSignIn` hook. Server: open-redirect guard on native
  callback URI, shared `mintSessionForUserId` helper.

### M9 — Push notifications & background
- **expo-notifications** permission flow: lazy request (post sign-in, not on cold start).
- **Device registration**: `POST /api/me/devices` (`channel:'apns'|'fcm'`); token
  persisted in SecureStore; deregistered on sign-out via `controller.getDeviceToken`.
- **Interactive notification categories**: Approve / Deny action buttons registered with
  `APPROVAL_CATEGORY_ID` — buttons do not foreground the app.
- **Background action handler** (`background-action-handler.ts`): defined at module level
  via `TaskManager.defineTask` so it runs before React renders. Reads credentials from
  SecureStore, calls `resolveNotificationAction`, refreshes badge. On failure: schedules
  a local "open app" notification.
- **Foreground banners**: OS alert suppressed; in-app `ForegroundBanner` slides in
  from the top with a 4s auto-dismiss. Tapping navigates to the deep-link target.
- **Deep-link tap-through** (all 3 kinds: `geneweave://run/`, `task/`, `reminder/`):
  cold-start via `getLastNotificationResponse`; warm-start via response listener;
  URL-scheme cold-start via `Linking.getInitialURL`.
- **Background-fetch badge refresh** (15 min): `expo-background-fetch` +
  `expo-task-manager` task queries `listTasks()` and updates the iOS/Android badge.
- **Actions tab badge**: live count from `useActions().badgeCount` shown on the tab icon.
- **PushProvider**: orchestrates all of the above; exposes `requestPushPermission()` for
  the settings screen to trigger the permission prompt at the right moment.
- Key files: `src/lib/push/push-token.ts`, `src/native/adapters/expo-notifications-adapter.ts`,
  `src/native/push/notification-categories.ts`, `src/native/push/background-action-handler.ts`,
  `src/native/push/use-push-registration.ts`, `src/native/push/use-background-fetch.ts`,
  `src/native/ui/push/foreground-banner.tsx`, `src/native/providers/push-provider.tsx`.

### M10 — Offline, polish, release engineering
- **SQLite offline outbox** (`expo-sqlite-outbox.ts`): implements `OutboxStorage`
  interface backed by WAL-mode SQLite, namespaced per `tenant@host`. Flushes
  automatically on reconnect via `OfflineProvider`.
- **Network state** (`offline-state.ts`): `@react-native-community/netinfo` observer;
  treats `isInternetReachable === false` as offline (captive-portal-aware); fails open
  on null (simulator/dev).
- **OfflineProvider**: subscribes to NetInfo, auto-flushes outbox on reconnect, polls
  queued count every 10s while offline.
- **Offline banner** (`offline-banner.tsx`): slides in from the bottom of safe area
  showing queued count and a Retry button; interactive widgets are disabled while offline.
- **Error / retry states** (`error-retry.tsx`): full-screen `ErrorRetry` + inline
  `InlineError` components used by list screens when queries fail.
- **Haptics** (`expo-haptics-adapter.ts`): typed API (`light/medium/heavy/selection/
  success/warning/error`) with reduced-motion suppression via `AccessibilityInfo`.
- **Sentry** (`src/sentry.ts`): crash reporting + performance monitoring; `initSentry()`
  called before any component renders; `withSentryWrapper` wraps root component.
  No-op when `EXPO_PUBLIC_SENTRY_DSN` is unset (safe in development).
- **EAS profiles** (`eas.json`): `development` (simulator, `developmentClient`),
  `preview` (internal distribution, APK/IPA), `production` (auto-increment, AAB/IPA,
  App Store submit config).
- **app.json** updates: `version: "1.0.0"`, `runtimeVersion`, `icon`/`splash` asset
  references, `supportsTablet: true` (iPad single-column — capped-width layout via
  `maxWidth` in screen styles), `associatedDomains` placeholder, Android
  `googleServicesFile`, `expo-sqlite` + `@sentry/react-native` plugins.
- **CI** (`.github/workflows/mobile-ci.yml`): unit tests + typecheck on every PR;
  EAS iOS + Android preview builds on push to main (non-blocking `--no-wait`).
  Scoped to `clients/mobile`, `clients/api-client`, `clients/tokens` path triggers.
- Key files added: `eas.json`, `src/sentry.ts`, `src/native/adapters/expo-sqlite-outbox.ts`,
  `src/native/adapters/expo-haptics-adapter.ts`, `src/native/offline/offline-state.ts`,
  `src/native/providers/offline-provider.tsx`, `src/native/ui/offline-banner.tsx`,
  `src/native/ui/error-retry.tsx`, `.github/workflows/mobile-ci.yml`.