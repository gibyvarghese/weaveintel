# WeaveIntel Modularity & Large-File Refactor Report
**Date:** 2026-05-24  
**Scope:** Full monorepo read-only analysis  
**Purpose:** Identify oversized files, propose splits, provide phased implementation plan  
**Constraint:** No functional changes — rename/reorganise only

---

## Executive Summary

The WeaveIntel monorepo contains ~218K LOC across 71 packages and 2 apps. The largest concentration of technical debt is in the `apps/geneweave/src/` directory, where five files collectively hold **~17,583 LOC** (8% of the entire codebase) and each violates the single-responsibility principle severely. At the package level, `packages/skills/src/index.ts` is the only source file in its package (1,387 LOC), and several large connector/provider files exceed practical review and maintenance thresholds.

**Severity classification used below:**
- 🔴 **Critical** — Single file >3,000 LOC or single-class god objects
- 🟠 **High** — Single file 1,000–3,000 LOC with mixed responsibilities
- 🟡 **Medium** — Single file 600–1,000 LOC or packages with all logic in one file
- 🟢 **Low** — Files 300–600 LOC that could benefit from splitting but function well

---

## 1. File Size Inventory

### 1.1 Top Offenders by LOC

| File | LOC | Severity | Domain Count |
|------|-----|----------|-------------|
| `apps/geneweave/src/db-sqlite.ts` | 7,609 | 🔴 Critical | 94 sections |
| `apps/geneweave/src/db-types.ts` | 3,611 | 🔴 Critical | ~9 domain groups |
| `apps/geneweave/src/db-sqlite-migrations.ts` | 3,207 | 🔴 Critical | M1–M22 + 10 encryption phases |
| `apps/geneweave/src/server-admin.ts` | 3,176 | 🔴 Critical | 5 admin route groups |
| `apps/geneweave/src/server.ts` | 1,980 | 🟠 High | 8 route groups |
| `packages/tools-enterprise/src/connectors/servicenow.ts` | 1,676 | 🟠 High | ~5 entity groups |
| `packages/skills/src/index.ts` | 1,387 | 🟠 High | 8 distinct concerns |
| `packages/tools-enterprise/src/servicenow-tools.ts` | 1,219 | 🟠 High | tool-layer for ServiceNow |
| `packages/live-agents/src/action-executor.ts` | 1,193 | 🟠 High | 5 functional groups |
| `packages/live-agents/src/types.ts` | 832 | 🟡 Medium | 6 type groups |
| `packages/live-agents/src/state-store.ts` | 725 | 🟡 Medium | 7 store variants |
| `packages/provider-google/src/google.ts` | 723 | 🟡 Medium | client + format + public API |
| `packages/mcp-client/src/client.ts` | 717 | 🟡 Medium | transport + tool-gathering + client |
| `packages/provider-anthropic/src/anthropic.ts` | 684 | 🟡 Medium | client + format + public API |
| `packages/workflows/src/engine.ts` | 666 | 🟡 Medium | single DefaultWorkflowEngine class |

### 1.2 Per-Package LOC Summary

| Package | LOC | Files | Concern |
|---------|-----|-------|---------|
| live-agents | 12,103 | 31 | Several individual files too large |
| encryption | 8,063 | 46 | Well-modularised, no issue |
| core | 6,365 | 52 | Well-modularised |
| tools-enterprise | 5,735 | 21 | servicenow.ts + servicenow-tools.ts bloated |
| live-agents-runtime | 5,518 | 23 | Acceptable |
| cost-governor | 4,999 | 31 | Acceptable |
| prompts | 4,674 | 18 | Acceptable |
| sandbox | 4,324 | 26 | Acceptable |
| workflows | 3,999 | 23 | engine.ts borderline |
| tools-kaggle | 2,932 | 8 | kaggle.ts large but focused |
| **skills** | **1,387** | **1** | **Single file — entire package** |

---

## 2. Detailed Findings & Proposed Splits

---

### 2.1 `apps/geneweave/src/db-sqlite.ts` — 7,609 LOC 🔴

**Current state:** Single `SQLiteAdapter` class with 94 domain sections. Sections range from core auth (users/sessions) to Kaggle competition phases to live-agents runtime CRUD. A change to any domain requires opening and scrolling through a 7,600-line file.

**Domain section map (line ranges):**

| Lines | Domain |
|-------|--------|
| 91–178 | Users |
| 179–278 | Sessions |
| 279–307 | OAuth Linked Accounts |
| 308–349 | Chats + Messages |
| 350–507 | Metrics, Evals, Preferences, ChatSettings, Traces |
| 508–665 | Temporal Tools persistence |
| 666–1136 | Prompts (10 sub-entities: prompts, versions, experiments, datasets, eval runs, optimizers, optimization runs, frameworks, fragments, contracts, strategies) |
| 1137–1250 | Guardrails + Model Pricing |
| 1251–1704 | anyWeave Routing (4 phases) |
| 1705–1878 | Workflows + Handler Kinds + Triggers + Mesh Contracts |
| 1879–2503 | Tools (catalog, policies, audit events, health, endpoint health, credentials, MCP gateway, approvals) |
| 2504–2762 | Agents (worker, supervisor) + Workflow Runs + Checkpoints + Capability Bindings |
| 2763–2830 | Cost Governor |
| 2831–2873 | Encryption delegation |
| 2874–3920 | 18× admin config tables (capabilities, guardrail evals, human tasks, cache, identity, memory, search, HTTP, social, connectors, registry, replay, trigger defs, tenant configs, sandbox, extraction, artifacts, reliability, collab, compliance, graph, plugins, scaffold, recipes, widgets, validation) |
| 3922–4113 | Semantic + Entity Memory + Website Credentials + SSO |
| 4114–6404 | Seed data (default rows, hypothesis validation seeds, routing seeds, cost governor seeds, encryption seeds) |
| 6405–6592 | Hypothesis Validation + Evidence events + Agent dialogue turns |
| 6593–7223 | Kaggle K3–K8 phases (projections, artifacts, mesh index, discussion bot, submission validation, competition run ledger) |
| 7224–7608 | Live mesh + Live-Agents Runtime CRUD (M21+M22) |

**Proposed split — 13 files:**

```
apps/geneweave/src/db/
  db-sqlite.ts              ← class skeleton, constructor, init() — ~200 LOC
  db-sqlite-users.ts        ← Users, Sessions, OAuth, Preferences, ChatSettings — ~350 LOC
  db-sqlite-chats.ts        ← Chats, Messages, Metrics, Evals, Traces — ~350 LOC
  db-sqlite-temporal.ts     ← Temporal tools persistence — ~160 LOC
  db-sqlite-prompts.ts      ← Prompts + 10 sub-entities — ~480 LOC
  db-sqlite-routing.ts      ← anyWeave routing 4 phases, model pricing, guardrails — ~600 LOC
  db-sqlite-tools.ts        ← Tool catalog, policies, audit, health, credentials, MCP gateway, approvals — ~700 LOC
  db-sqlite-workflows.ts    ← Workflow defs, handler kinds, triggers, mesh, runs, checkpoints — ~400 LOC
  db-sqlite-agents.ts       ← Worker/supervisor agents, capability bindings — ~350 LOC
  db-sqlite-admin.ts        ← 18 admin config tables (cache, identity, memory, search, etc.) — ~900 LOC
  db-sqlite-memory.ts       ← Semantic + entity memory + website credentials + SSO — ~250 LOC
  db-sqlite-kaggle.ts       ← Hypothesis validation + Kaggle K3–K8 — ~800 LOC
  db-sqlite-live-agents.ts  ← Live mesh + live-agents runtime CRUD — ~420 LOC
  db-sqlite-seed.ts         ← All seed data — ~300 LOC
```

**Implementation pattern:** Each `db-sqlite-*.ts` file exports a `mixin` function that receives `this: SQLiteAdapter` and extends the prototype, or alternatively uses a composition pattern where `SQLiteAdapter` delegates to sub-adapters. The public interface `SQLiteAdapter` remains unchanged — callers see no difference.

---

### 2.2 `apps/geneweave/src/db-types.ts` — 3,611 LOC 🔴

**Current state:** All database row-type interfaces in one file. Every domain is represented — from `UserRow` at line 1 to Kaggle rows near the end. Any developer working on routing types must load 3,600 lines.

**Proposed split — 9 files:**

```
apps/geneweave/src/db-types/
  index.ts               ← re-exports all types (drop-in replacement for db-types.ts)
  core.ts                ← UserRow, SessionRow, OAuthRow, ChatRow, MessageRow, MetricRow, EvalRow, PreferenceRow, TracerRow
  prompts.ts             ← PromptRow and 10 sub-entity rows
  routing.ts             ← TaskTypeDefinitionRow, RoutingPolicyRow, RoutingExperimentRow, FeedbackRow
  tools.ts               ← ToolCatalogRow, ToolPolicyRow, ToolAuditRow, ToolHealthRow, CredentialRow, MCPClientRow
  workflows.ts           ← WorkflowDefinitionRow, TriggerDefinitionRow, WorkflowRunRow, MeshContractRow
  agents.ts              ← WorkerAgentRow, SupervisorAgentRow, CapabilityBindingRow
  admin.ts               ← 20+ admin config table rows (CachePolicyRow, IdentityRuleRow, MemoryRow, etc.)
  kaggle.ts              ← HypothesisRow, ProjectionRow, KaggleRunRow, SubmissionRow, etc.
  live-agents.ts         ← LiveMeshRow, LiveAgentRow, LiveRunRow, LiveRunStepRow, etc.
  encryption.ts          ← TenantEncryptionPolicyRow, WrappedKeyRow, KeyEventRow
```

---

### 2.3 `apps/geneweave/src/db-sqlite-migrations.ts` — 3,207 LOC 🔴

**Current state:** M1 through M22 plus 10 encryption-phase migrations all in one file. Adding a migration requires scrolling past thousands of lines of prior migrations.

**Proposed split — numbered migration files:**

```
apps/geneweave/src/migrations/
  index.ts              ← runAllMigrations(), imports all batches in order
  m01-m10.ts            ← Migrations M1–M10 (core tables, prompts, routing)
  m11-m18.ts            ← Migrations M11–M18 (tools, workflows, agents, admin config)
  m19-m22.ts            ← Migrations M19–M22 (cost governor, Kaggle, live-agents mesh, live runtime)
  encryption.ts         ← Encryption phases 1–10
  helpers.ts            ← safeExec(), shared migration utilities
```

---

### 2.4 `apps/geneweave/src/server-admin.ts` — 3,176 LOC 🔴

**Current state:** Single `registerAdminRoutes()` function containing all admin route registrations. Five distinct route groups are mixed together.

**Proposed split — 5 files:**

```
apps/geneweave/src/admin/routes/
  index.ts              ← registerAdminRoutes() — mounts all sub-routers (~40 LOC)
  users.ts              ← User management admin routes
  prompts.ts            ← Prompt admin routes (8 sub-entity types)
  routing.ts            ← Routing test + callable capabilities routes
  kaggle.ts             ← Kaggle projection admin routes
```

---

### 2.5 `apps/geneweave/src/server.ts` — 1,980 LOC 🟠

**Current state:** Auth, OAuth, model, tools, preferences, settings, traces, chats, dashboard, and admin wiring all in one file. Middleware setup is interleaved with route registration.

**Proposed split — 7 files:**

```
apps/geneweave/src/routes/
  index.ts              ← server setup, middleware, startup, port binding (~200 LOC)
  auth.ts               ← auth + OAuth routes (~300 LOC)
  chat.ts               ← chat + messages routes (~250 LOC)
  model.ts              ← model + tools routes (~200 LOC)
  traces.ts             ← traces + metrics routes (~150 LOC)
  settings.ts           ← preferences + settings + dashboard routes (~150 LOC)
  admin-wiring.ts       ← adminRouter setup, RBAC wiring, admin route mounting (~100 LOC)
```

---

### 2.6 `packages/skills/src/index.ts` — 1,387 LOC 🟠

**Current state:** The entire `@weaveintel/skills` package is a single file. It mixes type definitions, semantic matching algorithms (TF-IDF/cosine similarity), prompt builders, skill activation logic, completion evaluation, a registry factory, database persistence helpers, and ~130 lines of built-in skill constants.

**Proposed split — 8 files:**

```
packages/skills/src/
  types.ts              ← All SkillDefinition interfaces + enums (lines 11–272) — ~260 LOC
  matching.ts           ← normalizeText, tokenize, termFrequency, cosineSimilarity, semanticScore, triggerPatternBoost — ~200 LOC
  overlay.ts            ← defineSkill, withSkillOverlay, applySkillOverlays — ~70 LOC
  prompt-builder.ts     ← buildSkillInvocationPrompt, buildSkillSystemPrompt, applySkillsToPrompt, collectSkillTools — ~200 LOC
  activation.ts         ← activateSkills, evaluateSkillCompletion, createSkillTelemetry — ~400 LOC
  registry.ts           ← createSkillRegistry (~50 LOC)
  persistence.ts        ← SkillRow, safeParseX helpers, skillFromRow, extractSkillExecutionContracts — ~200 LOC
  builtin.ts            ← BUILT_IN_SKILLS array — ~130 LOC
  index.ts              ← re-exports only
```

---

### 2.7 `packages/tools-enterprise/src/connectors/servicenow.ts` — 1,676 LOC 🟠

**Current state:** Entire ServiceNow connector in one file. Separate entity domains (incidents, catalog, CMDB, auth) are all mixed.

**Proposed split:**

```
packages/tools-enterprise/src/connectors/servicenow/
  index.ts              ← re-exports
  client.ts             ← HTTP client class, auth handling, request helpers
  types.ts              ← All ServiceNow-specific type definitions
  incident.ts           ← Incident CRUD operations
  catalog.ts            ← Service catalog operations
  cmdb.ts               ← CMDB / CI operations
  change.ts             ← Change request operations
```

**Note:** `servicenow-tools.ts` (1,219 LOC — the tool-layer wrapping the connector) should similarly split into `tools/servicenow-incident-tools.ts`, `tools/servicenow-catalog-tools.ts`, and `tools/servicenow-cmdb-tools.ts`, with a shared `tools/servicenow-base.ts`.

---

### 2.8 `packages/live-agents/src/action-executor.ts` — 1,193 LOC 🟠

**Current state:** Five distinct functional groups in a single file: observability helpers (`withObservedSpan`), account management (`loadPrimaryAccount`), external action adapter (`createDefaultExternalActionAdapter`, `tryExecuteExternalAction`), session tool execution (`sessionHasTool`, `executeSessionTool`), and the public `createActionExecutor` factory.

**Proposed split:**

```
packages/live-agents/src/action-executor/
  index.ts              ← createActionExecutor, TaskHandler, TaskHandlerResult (public API)
  spans.ts              ← withObservedSpan, responseSummary, responseExternalRef
  account.ts            ← loadPrimaryAccount, makeId helpers
  outbound.ts           ← saveOutboundStub, saveOutboundRecord
  external-adapter.ts   ← createDefaultExternalActionAdapter, tryExecuteExternalAction, includesEmergencyCondition
  session-tools.ts      ← sessionHasTool, executeSessionTool
```

---

### 2.9 `packages/live-agents/src/types.ts` — 832 LOC 🟡

**Current state:** All live-agents type definitions in one file: mesh topology, messaging, grants/authority, state-store variants (in-memory, Redis, Postgres, SQLite, Mongo, DynamoDB, Cloud NoSQL).

**Proposed split:**

```
packages/live-agents/src/types/
  index.ts              ← re-exports all
  mesh.ts               ← Mesh, LiveAgent, DelegationEdge, Team, TeamMembership, CrossMeshBridge, AgentContract
  messaging.ts          ← Message, BacklogItem, OutboundActionRecord, ExternalEvent, EventRoute, MessageKind/Priority/Status
  grants.ts             ← CapabilityGrant, GrantRequest, BreakGlassInvocation, GrantTrigger, PromotionRequest, Promotion
  authority.ts          ← GrantAuthorityConstraints, BreakGlassConstraints, ContractAuthorityConstraints, ContextPolicy
  accounts.ts           ← Account, AccountBinding, AccountBindingRequest, McpServerRef
  state.ts              ← StateStore interface + all 7 variant extensions (InMemory, Redis, Postgres, SQLite, Mongo, DynamoDB, CloudNoSQL)
```

---

### 2.10 `packages/provider-google/src/google.ts` — 723 LOC 🟡

**Current state:** HTTP request functions, streaming iterators, resilience callables, Gemini request/response formatters, model metadata resolver, and the public `weaveGoogleModel` API all in one file.

**Proposed split:**

```
packages/provider-google/src/
  google.ts             ← weaveGoogleModel, weaveGoogleConfig, weaveGoogle (public API ~80 LOC)
  google-client.ts      ← googleRequest, googleRequestRaw, googleStreamRequest, googleStreamFetchRaw, iterateGoogleStream, getRequestCallable, getStreamFetchCallable — ~250 LOC
  google-format.ts      ← partToGeminiPart, buildGeminiRequest, buildGeminiTools, buildGeminiToolConfig, parseCandidate, parseUsage, mapFinishReason, resolveGeminiMetadata — ~250 LOC
  google-types.ts       ← GeminiPart, GeminiModelMetadata, ParsedCandidate, GoogleProviderOptions, RequestArgs — ~100 LOC
```

---

### 2.11 `packages/provider-anthropic/src/anthropic.ts` — 684 LOC 🟡

**Current state:** Same pattern as google.ts — HTTP client, request formatters, response parsers, and public API entangled.

**Proposed split:**

```
packages/provider-anthropic/src/
  anthropic.ts          ← weaveAnthropicModel, public API (~80 LOC)
  anthropic-client.ts   ← HTTP request/streaming functions
  anthropic-format.ts   ← Request formatters, response parsers
  anthropic-types.ts    ← AnthropicProviderOptions, request/response types
```

---

### 2.12 `packages/mcp-client/src/client.ts` — 717 LOC 🟡

**Current state:** Transport adapter, tool-gathering helpers, input-merge logic, path-extraction utilities, and the full `weaveMCPClient()` factory all in one file.

**Proposed split:**

```
packages/mcp-client/src/
  client.ts             ← weaveMCPClient, weaveMCPTools (public API)
  transport.ts          ← CoreTransportAdapter, toSDKTransport
  tools.ts              ← gatherAllTools, gatherAllResources, gatherAllPrompts, normalizeMCPContent
  input.ts              ← applyMergedInput, parsePathValue, isRecord
  spans.ts              ← withObservedSpan, toExecutionContextMeta
```

---

### 2.13 `packages/workflows/src/engine.ts` — 666 LOC 🟡

**Current state:** `DefaultWorkflowEngine` class is a single 630-line class with constructor, step-resolution, sleep management, event dispatch, and run/pause/resume lifecycle all mixed.

**Proposed split:**

```
packages/workflows/src/
  engine.ts             ← DefaultWorkflowEngine class (public API), createWorkflowEngine (~150 LOC)
  engine-runner.ts      ← step execution, loop logic, error handling (~200 LOC)
  engine-events.ts      ← event dispatch, event bus wiring (~100 LOC)
  engine-sleep.ts       ← sleep management, wake conditions (~100 LOC)
  engine-types.ts       ← WorkflowEngineOptions, internal state types (~100 LOC)
```

---

## 3. Phased Implementation Plan

Phases are ordered by **risk × impact**:
- Phase A: File-system changes only (move + re-export), zero logic changes, zero callers break
- Phase B: Structural splits that touch one package at a time
- Phase C: Complex splits requiring cross-file state sharing (the db-sqlite god object)

---

### Phase A — Pure Re-exports (Zero-Risk Splits)

**Goal:** Create the directory structure and sub-files, move types/interfaces, add barrel re-exports in the original file. The original import path stays valid — all callers continue to work unchanged.

**Estimated effort:** 2–3 days

| Task | File | New Location |
|------|------|-------------|
| A1 | `db-types.ts` → split to `db-types/` | Extract per-domain interfaces; `db-types.ts` becomes `export * from './db-types/index.js'` |
| A2 | `skills/index.ts` → split types | Extract `types.ts`, `persistence.ts`, `builtin.ts`; index re-exports |
| A3 | `live-agents/types.ts` → split to `types/` | Extract per-domain type groups; types.ts becomes re-export barrel |
| A4 | `provider-google/google.ts` → extract `google-types.ts` | Only type definitions moved |
| A5 | `provider-anthropic/anthropic.ts` → extract `anthropic-types.ts` | Only type definitions moved |

**Validation:** TypeScript `tsc --noEmit` on all packages must pass with zero new errors.

---

### Phase B — Package-Level Logic Splits

**Goal:** Split the logic-bearing files within individual packages. Each task is self-contained to one package.

**Estimated effort:** 4–6 days

| Task | File | Target Files | Notes |
|------|------|-------------|-------|
| B1 | `skills/index.ts` — remaining logic | `matching.ts`, `overlay.ts`, `prompt-builder.ts`, `activation.ts`, `registry.ts` | High-value: entire package is one file |
| B2 | `connectors/servicenow.ts` | `servicenow/client.ts`, `incident.ts`, `catalog.ts`, `cmdb.ts`, `change.ts` | Each entity group becomes its own file |
| B3 | `servicenow-tools.ts` | `tools/servicenow-incident-tools.ts`, etc. | Follows B2 |
| B4 | `action-executor.ts` | `action-executor/` directory (5 files) | Use barrel `index.ts` |
| B5 | `provider-google/google.ts` | `google-client.ts`, `google-format.ts` | Extract only; public API stays in `google.ts` |
| B6 | `provider-anthropic/anthropic.ts` | `anthropic-client.ts`, `anthropic-format.ts` | Same pattern as B5 |
| B7 | `mcp-client/client.ts` | `transport.ts`, `tools.ts`, `input.ts`, `spans.ts` | Public API stays in `client.ts` |
| B8 | `workflows/engine.ts` | `engine-runner.ts`, `engine-events.ts`, `engine-sleep.ts`, `engine-types.ts` | Internal class logic only; public API unchanged |

**Validation per task:** Package-level `npm test` must pass. If no tests exist for the package, `tsc --noEmit` must pass.

---

### Phase C — Application-Level God-Object Splits

**Goal:** Break up the geneweave app files. These are the highest-impact but most complex splits because `db-sqlite.ts` is a single class where method bodies access `this.db` and private helpers cross domain boundaries.

**Estimated effort:** 10–14 days

**Recommended approach for `db-sqlite.ts`:** Use the **mixin pattern**.

Each domain file (`db-sqlite-users.ts`, etc.) exports an `applyMixin(proto: SQLiteAdapter): void` function that assigns methods to the prototype. The main `db-sqlite.ts` calls all `applyMixin` functions in `init()`. The public `SQLiteAdapter` type/interface is unchanged. No caller import changes.

```
Phase C1 — db-sqlite-migrations.ts
  Create: migrations/helpers.ts, m01-m10.ts, m11-m18.ts, m19-m22.ts, encryption.ts, index.ts
  Risk: Low (pure data, no cross-domain state)

Phase C2 — server-admin.ts
  Create: admin/routes/users.ts, prompts.ts, routing.ts, kaggle.ts, index.ts
  Risk: Low-Medium (route handlers are independent; shared context via Express router)

Phase C3 — server.ts
  Create: routes/auth.ts, chat.ts, model.ts, traces.ts, settings.ts, admin-wiring.ts, index.ts
  Risk: Medium (shared middleware and auth guards must be threaded correctly)

Phase C4 — db-sqlite.ts leaf domains (high isolation)
  Start with sections that have no cross-section helper calls:
  - db-sqlite-kaggle.ts (K3–K8 are append-heavy, no shared helpers)
  - db-sqlite-live-agents.ts (M21+M22 are isolated CRUD)
  - db-sqlite-memory.ts (semantic/entity memory, website credentials)
  - db-sqlite-seed.ts (pure INSERT statements, no method calls)
  Risk: Low-Medium per file

Phase C5 — db-sqlite.ts middle domains
  - db-sqlite-tools.ts (tool catalog + adjacent sections)
  - db-sqlite-routing.ts (anyWeave routing phases)
  - db-sqlite-prompts.ts (prompts + 10 sub-entities)
  Risk: Medium (these sections share helpers like buildDynamicSet)

Phase C6 — db-sqlite.ts core domains (highest coupling)
  - db-sqlite-users.ts, db-sqlite-chats.ts, db-sqlite-temporal.ts
  - db-sqlite-workflows.ts, db-sqlite-agents.ts, db-sqlite-admin.ts
  Risk: Medium-High (core types and helpers used everywhere)
```

**Validation per C-phase:** Full E2E test suite (`scripts/e2e-phase*.mjs`) must pass. TypeScript `tsc --noEmit` on the app. Spot-check admin UI flows.

---

### Phase D — Optional Quality Improvements

These are not pure splits but follow naturally from the refactor and can be done during C-phase work:

| Task | Description |
|------|-------------|
| D1 | Introduce `ISQLiteAdapter` interface split into domain sub-interfaces (IUserStore, IChatStore, etc.) — enables future mock testing |
| D2 | Move all migration helpers into `migrations/helpers.ts` and add a migration registry pattern |
| D3 | Create `packages/skills/src/__tests__/` — the skills package has zero tests, splits create natural test seams |
| D4 | Create `packages/live-agents-runtime/src/adapters/` — split state store adapters from runtime logic |

---

## 4. Summary Checklist

| # | File | Current LOC | Target (post-split) | Phase |
|---|------|------------|---------------------|-------|
| 1 | `db-sqlite.ts` | 7,609 | ~200 (core) + 13 sub-files | C4–C6 |
| 2 | `db-types.ts` | 3,611 | barrel re-export only | A1 |
| 3 | `db-sqlite-migrations.ts` | 3,207 | 5 migration files | C1 |
| 4 | `server-admin.ts` | 3,176 | 5 route files | C2 |
| 5 | `server.ts` | 1,980 | 7 route files | C3 |
| 6 | `connectors/servicenow.ts` | 1,676 | 6 files | B2 |
| 7 | `skills/index.ts` | 1,387 | 8 files | B1 |
| 8 | `servicenow-tools.ts` | 1,219 | 4 files | B3 |
| 9 | `action-executor.ts` | 1,193 | 6 files | B4 |
| 10 | `live-agents/types.ts` | 832 | 7 files | A3 |
| 11 | `live-agents/state-store.ts` | 725 | in Phase B review | B |
| 12 | `provider-google/google.ts` | 723 | 4 files | B5 |
| 13 | `mcp-client/client.ts` | 717 | 5 files | B7 |
| 14 | `provider-anthropic/anthropic.ts` | 684 | 4 files | B6 |
| 15 | `workflows/engine.ts` | 666 | 5 files | B8 |

**Total files affected:** 15 source files  
**Total LOC to split:** ~29,900 (of ~218K total, ~14%)  
**No functional changes required** in any phase — all splits are reorganisation only.

---

## 5. Key Architectural Constraints to Observe

1. **Package vs. Application boundary** — splits in `packages/` must not import from `apps/`. Splits in `apps/geneweave/src/` may reference any package.

2. **Public API stability** — all `index.ts` export surfaces must remain identical post-split. Any new barrel file must re-export everything the original file exported, under the same name and shape.

3. **Import paths** — where Node.js ESM resolution is in use (`.js` extension in imports), new sub-files must follow the same convention. Do not introduce `.ts` imports.

4. **SQLiteAdapter mixin pattern** — when splitting `db-sqlite.ts`, mixin functions must not close over module-level state. All state lives on `this`. Mixins may call other methods on `this` only if those methods are already applied.

5. **Migration atomicity** — migration files must not be reordered. The split in Phase C1 must preserve the exact execution order of M1→M22→encryption phases.
