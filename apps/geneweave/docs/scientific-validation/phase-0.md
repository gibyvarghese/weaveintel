# Scientific Validation — Phase 0 Discovery Report

**Date:** 2025-07-16  
**Feature:** Scientific Validation (`sv:`)  
**Track:** v1.x — Aertex series  
**Status:** ✅ Accepted — ready for Phase 1

---

## 1. Repository Orientation

### 1.1 Server Framework

The spec assumes Fastify or a similar framework. **Correction:** geneWeave uses a **hand-rolled Node.js HTTP router** in `apps/geneweave/src/server.ts` — a `Router` class built on `node:http` with `RegExp`-based path matching. Route registration follows the `router.get()` / `router.post()` / `router.del()` / `router.put()` API.

The seven Scientific Validation routes (§8.1) will be registered using this same pattern via a `registerSVRoutes(router, db, helpers)` function analogous to `registerAdminRoutes()`.

### 1.2 Migration Mechanism

The spec references four SQL migration files (`001_sv_hypothesis.sql` … `004_sv_verdict.sql`). **Correction:** geneWeave does **not** use file-based migrations. The schema is applied at startup in two steps:

1. **`SCHEMA_SQL`** in `apps/geneweave/src/db-schema.ts` — contains `CREATE TABLE IF NOT EXISTS` for all tables, executed via `db.exec(SCHEMA_SQL)`.
2. **`applySQLiteBootstrapMigrations()`** in `apps/geneweave/src/db-sqlite-migrations.ts` — handles backward-compatible `ALTER TABLE` additions via `safeExec()` (ignores errors so existing databases continue bootstrapping).

**Plan for sv_* tables:** Add all four tables to `SCHEMA_SQL` in `db-schema.ts`. No file-based migration runner is needed.

### 1.3 UUID Strategy

- **Current practice:** `randomUUID()` from `node:crypto` (UUID v4) is used consistently across all existing tables.
- **Spec requirement:** UUID v7 preferred for time-ordered sortability.
- **Decision:** Create `apps/geneweave/src/lib/uuid.ts` with a zero-dependency UUID v7 implementation. This satisfies the spec's sortability requirement and keeps the codebase dependency-free for this utility. All four `sv_*` tables use this helper for their primary keys.
- All existing tables retain `randomUUID()` (UUID v4) — no changes to current tables.

### 1.4 Playwright & E2E Tests

- Config: `apps/geneweave/playwright.config.ts`
- `testDir: './src'`, `testMatch: '**/*.e2e.ts'`
- The spec places e2e tests at `apps/geneweave/tests/scientific-validation/e2e/*.spec.ts`. **Correction:** To match the existing `*.e2e.ts` convention and `testDir: './src'`, Phase 9 e2e tests will be placed at `apps/geneweave/src/scientific-validation.e2e.ts` (or `apps/geneweave/src/sv-*.e2e.ts` per scenario). Alternatively, the `testDir` and `testMatch` in `playwright.config.ts` can be widened — Phase 9 will confirm.

### 1.5 Storybook

No Storybook is present in geneWeave. The spec note "Storybook stories for each view (if Storybook exists in geneweave; Phase 0 checks)" — **confirmed absent**. No Storybook stories will be created in Phase 7.

### 1.6 CI Test Workflow

No GitHub Actions test workflow exists (only deployment workflows: `deploy-aws.yml`, `deploy-azure.yml`, `deploy-fly.yml`, `deploy-gcp.yml`, `docker.yml`, `release.yml`). Tests are run locally via `npm run test`. **CI plan:** Phase 0 creates `.github/workflows/test.yml` that runs `turbo test` on push/PR to `main`. Playwright and container-executor integration tests are excluded from CI by default (they require Docker and a running server) and can be run locally or in a separate workflow.

---

## 2. Package Wiring Confirmation

All 28 packages listed in §2.1 exist as workspace packages under `packages/`. The table below shows which are already in geneWeave's `dependencies` and which need to be added.

| Package | Exists? | In geneweave deps? | Action |
|---|---|---|---|
| `@weaveintel/core` | ✅ | ✅ | None |
| `@weaveintel/models` | ✅ | ❌ | Add to `dependencies` |
| `@weaveintel/routing` | ✅ | ✅ | None |
| `@weaveintel/agents` | ✅ | ✅ | None |
| `@weaveintel/workflows` | ✅ | ✅ | None |
| `@weaveintel/recipes` | ✅ | ✅ | None |
| `@weaveintel/contracts` | ✅ | ✅ | None |
| `@weaveintel/replay` | ✅ | ❌ | Add to `dependencies` |
| `@weaveintel/prompts` | ✅ | ✅ | None |
| `@weaveintel/memory` | ✅ | ✅ | None |
| `@weaveintel/a2a` | ✅ | ❌ | Add to `dependencies` |
| `@weaveintel/sandbox` | ✅ | ✅ | None — container executor added in Phase 1 |
| `@weaveintel/tools` | ✅ | ❌ | Add to `dependencies` (base tool registry) |
| `@weaveintel/tools-http` | ✅ | ✅ | None |
| `@weaveintel/tools-browser` | ✅ | ✅ | None |
| `@weaveintel/cache` | ✅ | ✅ | None |
| `@weaveintel/guardrails` | ✅ | ✅ | None |
| `@weaveintel/redaction` | ✅ | ✅ | None |
| `@weaveintel/identity` | ✅ | ✅ | None |
| `@weaveintel/tenancy` | ✅ | ❌ | Add to `dependencies` |
| `@weaveintel/reliability` | ✅ | ❌ | Add to `dependencies` |
| `@weaveintel/observability` | ✅ | ✅ | None |
| `@weaveintel/evals` | ✅ | ✅ | None |
| `@weaveintel/human-tasks` | ✅ | ✅ | None |
| `@weaveintel/ui-primitives` | ✅ | ✅ | None |
| `@weaveintel/triggers` | ✅ | ❌ | Add to `dependencies` |
| `@weaveintel/collaboration` | ✅ | ❌ | Add to `dependencies` (optional Phase 9) |
| `@weaveintel/testing` | ✅ | ❌ | Add to `devDependencies` |

**Added to `apps/geneweave/package.json` in Phase 0:**
- `dependencies`: `@weaveintel/a2a`, `@weaveintel/replay`, `@weaveintel/tenancy`, `@weaveintel/reliability`, `@weaveintel/triggers`, `@weaveintel/models`, `@weaveintel/tools`, `@weaveintel/collaboration`
- `devDependencies`: `@weaveintel/testing`

---

## 3. API Assumption Corrections

The spec uses several API names that do not match the current package exports. These corrections are folded into the implementation plan for each phase:

| Spec reference | Actual API | Package | Notes |
|---|---|---|---|
| `weaveWorkflow()` | `defineWorkflow()` | `@weaveintel/workflows` | `WorkflowBuilder` via `defineWorkflow` |
| `weaveContract()` | `defineContract()` / `createContract()` | `@weaveintel/contracts` | Both exported; use `defineContract` for typed DSL |
| `weaveEventBus()` | `weaveInMemoryTracer()` / `weaveConsoleTracer()` | `@weaveintel/observability` | No event bus API exists; sv.* events will be emitted via observability spans and an in-process event emitter |
| Container executor | Does not exist yet | `@weaveintel/sandbox` | Phase 1 adds `ContainerExecutor` as additive extension |
| `weaveFakeContainerRuntime()` | Does not exist yet | `@weaveintel/testing` | Phase 1 adds this fake |

---

## 4. Decisions

### 4.1 UUID Helper

**Decision:** Create `apps/geneweave/src/lib/uuid.ts` with a pure TypeScript UUID v7 implementation (no npm dependencies). UUID v7 uses a 48-bit Unix timestamp prefix, ensuring time-ordered rows in SQLite. Function exported: `newUUIDv7(): string`.

All four `sv_*` tables use `newUUIDv7()` for primary keys. Existing tables continue using `randomUUID()` from `node:crypto`.

### 4.2 Container Runtime

**Decision for v1:** Docker + Fake runtime.

- `DockerRuntime` — spawns `docker run` with `--network=none`, `--memory`, `--cpus`, `--pids-limit=256`, `--read-only` root fs, non-root uid 65534.
- `FakeRuntime` — deterministic, keyed by `(imageDigest, canonicalStdin)` → fixed result. Used by all tests.
- `PodmanRuntime` — deferred until a user requests it. The shared flag-builder makes it trivial to add.

Container executor integration tests (requiring real Docker) are skipped in CI unless `CI_DOCKER=1` is set. All unit and integration tests use `FakeRuntime` and pass in CI without Docker.

### 4.3 `@weaveintel/human-tasks` Inclusion

**Decision: In scope for inconclusive verdicts.** When the Supervisor emits an `inconclusive` verdict, the workflow optionally creates a `HumanTask` of type `review` so an operator can annotate the hypothesis with domain judgment. This is opt-in per budget envelope (`allow_human_review: boolean` on `sv_budget_envelope`). The task is created via `createReviewTask()` from `@weaveintel/human-tasks` and surfaced in the existing admin panel.

### 4.4 Evidence Layer API Keys

Evidence tools (arXiv, PubMed, Semantic Scholar, OpenAlex, Crossref, EuropePMC) use authenticated HTTP adapters via `@weaveintel/tools-http`. API keys are stored in the existing `tool_credentials` table and injected via `credentialResolver`. No API key is strictly required for public endpoints (arXiv, OpenAlex, Crossref are keyless for moderate rate limits) but recommended for PubMed and Semantic Scholar.

---

## 5. CI Plan

### 5.1 New test workflow

`.github/workflows/test.yml` — runs on push/PR to `main`:
```yaml
- npm ci
- turbo build
- turbo test  # unit + integration (vitest, FakeRuntime)
```

### 5.2 Playwright

Playwright tests run locally or in a separate `e2e.yml` workflow. They require a real server process. Not in the default CI gate.

### 5.3 Container executor integration tests

Gated behind `if: env.CI_DOCKER == '1'` in `test.yml`. Default CI uses `FakeRuntime`. Docker-required tests are opt-in for environments with Docker available.

### 5.4 Eval corpus

Run manually via `npx tsx apps/geneweave/src/features/scientific-validation/evals/run-corpus.ts`. A nightly cron trigger via `@weaveintel/triggers` is wired in Phase 8; the CI gate for cost regression is a separate `eval.yml` workflow.

---

## 6. Summary of Phase 0 Deliverables

| Deliverable | Status |
|---|---|
| This report (`phase-0.md`) | ✅ Complete |
| `apps/geneweave/src/lib/uuid.ts` (UUID v7 helper) | ✅ Created |
| `apps/geneweave/package.json` — missing deps added | ✅ Updated |
| `.github/copilot-instructions.md` — §3 principles added | ✅ Updated |
| `.github/workflows/test.yml` — CI test workflow | ✅ Created |

---

## 7. Phase 1 Entry Conditions

Phase 1 (Sandbox container executor) can start immediately. Pre-conditions:
- [x] No unjustified reinvention of existing package capability confirmed
- [x] API assumption corrections documented
- [x] All 28 packages reachable (workspace deps added)
- [x] UUID v7 helper in place
- [x] Container runtime decision: Docker + Fake
- [x] Copilot instructions updated with durable cross-cutting principles
