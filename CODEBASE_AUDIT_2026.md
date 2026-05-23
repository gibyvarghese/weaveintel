# CODEBASE_AUDIT_2026

Audit date: 2026-05-15
Scope: `/Users/gibyvarghese/weaveintel` (read-only). No fixes applied.
Method: parallel deep-dives on apps/geneweave, `@weaveintel/encryption`, packages/*, and build/CI/scripts/observability, plus prior discovery audit. Sampling-based — not exhaustive across all 219K LOC.

## 1. Executive Summary

Severity counts (consolidated):
- CRITICAL: 5
- HIGH: 11
- MEDIUM: 15
- LOW: 8

Top 5 themes:
1. **God-object data layer** — `db-sqlite.ts` (7,884 lines) holds 200+ near-identical CRUD blocks. No repository pattern. Every schema change ripples here.
2. **Process-lifecycle hygiene** — 9+ `setInterval` calls without `.unref()` keep Node alive during shutdown/tests across encryption, triggers, workflows, sandbox, runtime, browser-tools.
3. **Operational blind spots** — 1,864 `console.log` calls; the `@weaveintel/observability` package exists but is only wired as a default tracer. CI runs Turbo build but not `tsc -b`/typecheck. 88 `process.env` reads have no startup validation.
4. **Test coverage cliff at the edges** — 54 admin API route files with 0 dedicated tests; 26/71 packages with zero tests; key encryption modules (attestation, alert-evaluator, break-glass, kms-resolver) untested.
5. **Platform maturity drift** — 71 packages at 0.0.1/0.1.0 vs. VERSIONING.md "Aertex" v1.0.0 plan; 46/71 packages have no external importers (orphan or pre-wiring); copilot-instructions.md overstates observability deployment.

Build health: `npx tsc -b apps/geneweave --pretty false` completes clean.

## 2. Codebase Map

```
weaveintel/
├── apps/
│   ├── geneweave/              ~60K LOC — admin server, chat, encryption, live-agents, UI
│   │   └── src/
│   │       ├── db-sqlite.ts            7,884   (CRITICAL: god object)
│   │       ├── db-types.ts             3,612
│   │       ├── db-sqlite-migrations.ts 3,167
│   │       ├── server-admin.ts         3,132
│   │       ├── server.ts               1,916
│   │       ├── ui-client.ts            1,478
│   │       ├── admin-ui.ts             1,739
│   │       └── admin/api/*.ts          54 files, 0 dedicated tests
│   └── live-agents-demo/       Kaggle live-agents harness
├── packages/                   71 packages
│   ├── encryption/             14 test files, ~83% coverage; BYOK/HYOK Phase 10
│   ├── workflows/              setInterval issue
│   ├── triggers/               4 files w/ setInterval, unsafe casts
│   ├── sandbox/                CSE session timer issue
│   ├── tools-*/                kaggle 1,596 LOC; browser automation timer
│   ├── live-agents-runtime/    heartbeat-supervisor timer
│   ├── observability/          exists; underused
│   ├── providers/* (5)         all orphan (no external imports)
│   └── 26 packages with zero tests; 30 missing READMEs
├── scripts/                    32 e2e-phase*.mjs (duplicated boilerplate)
└── docs/                       includes WEAVEINTEL_CODE_REVIEW_PHASE_PLAN.md
```

Key longest files (LOC): db-sqlite 7,884 · db-types 3,612 · db-sqlite-migrations 3,167 · server-admin 3,132 · live-agents.test 3,002 · api.test 2,572 · server 1,916 · admin-ui 1,739 · e2e.e2e 1,598 · kaggle 1,596 · ui-client 1,478 · db-schema 1,315 · key-manager 748.

## 3. Findings by Category

### Redundancy / Duplication
- **CRIT** `apps/geneweave/src/db-sqlite.ts:1-7884` — 200+ identical CRUD/UPDATE blocks (e.g. lines 7521-7532, 7565-7576, 7602-7613). XL.
- **MED** `scripts/e2e-phase*.mjs` (21 files) — duplicated jfetch/cookie/csrf bootstrap. M.

### File size / Modularity
- **CRIT** `db-sqlite.ts` 7,884 LOC; **HIGH** `db-types.ts` 3,612; `db-sqlite-migrations.ts` 3,167; `server-admin.ts` 3,132. No repository pattern. XL.

### Architectural integrity
- **MED** `apps/geneweave/src/server.ts:338` — permission check inline in main server, not in auth layer. M.
- **HIGH** 46/71 packages have no importers outside their own dir (all 5 providers, artifacts, compliance, contracts, evals, extraction, graph, guardrails, oauth, cache, capability-packs, …). M.
- **GOOD** `@weaveintel/encryption` reusability boundary preserved (only `node:crypto` + `@weaveintel/core`).

### Naming
- **GOOD** `provider-*` and `tools-*` conventions consistent.
- **LOW** `apps/geneweave/src/db-types.ts:740`, `apps/geneweave/src/index.ts:476` — deprecated `ToolConfigRow` alias retained. S.

### Error handling
- **HIGH** Error message leakage: `apps/geneweave/src/admin/api/tenant-byok.ts:68`, `encryption-observability.ts:247`, `tenant-encryption-policies.ts:327` — 8+ handlers return `(err as Error).message` to client. S.
- **MED** `packages/triggers/src/dispatcher.ts:557` — `recordInvocation` failures logged and swallowed → audit-trail loss. M.

### Testing
- **HIGH** `apps/geneweave/src/admin/api/*.ts` — 54 files, 0 dedicated tests. XL.
- **HIGH** `@weaveintel/encryption` — `attestation.ts`, `alert-evaluator.ts`, `break-glass.ts`, `kms-resolver.ts` lack unit tests. M.
- **MED** 26/71 packages have zero tests (a2a, agents, artifacts, collaboration, compliance, devtools, evals, extraction, graph, mcp-server, …). L.

### Security (OWASP)
- **CRIT** `apps/geneweave/src/server.ts:2659-2686` — path traversal documented as unpatched in `docs/WEAVEINTEL_CODE_REVIEW_PHASE_PLAN.md` (status unverified). S.
- **CRIT** 88 `process.env` reads in `apps/geneweave/src` without startup validation; JWT_SECRET / OAuth keys accepted blindly. S.
- **HIGH** `apps/geneweave/src/server-admin.ts:3110` — SSRF via `connector.base_url` flowed directly to `fetch()`. S.
- **HIGH** `apps/geneweave/src/admin/api/tool-simulation.ts:358` — `BUILTIN_TOOLS[toolName]` bypasses enabled-catalog source-of-truth. M.
- **MED** `packages/encryption/src/byok/attestation.ts:237-244` — audit chain verification only checks internal hash. M.
- **GOOD** SQL fully parameterized in sampled routes; no hardcoded secrets; OAuth env vars correctly consumed.

### Performance / Concurrency
- **CRIT** Missing `.unref()` on 9+ background timers:
  - `packages/encryption/src/purge-scheduler.ts:25`
  - `packages/encryption/src/rewrite-scheduler.ts:45` (2x)
  - `packages/live-agents-runtime/src/heartbeat-supervisor.ts:31, 41`
  - `packages/sandbox/src/cse/session.ts:25, 102`
  - `packages/tools-browser/src/automation.ts:85`
  - `packages/triggers/src/queue.ts:42`, `cron.ts:48`, `dispatcher.ts:41`
  - `packages/workflows/src/scheduler.ts:31`
  S.

### Type safety
- **HIGH** 221 `as any` in `apps/geneweave/src` (e.g. `admin/api/tools.ts:83`); 15 admin routes affected. M.
- **MED** Unsafe double-casts: `packages/workflows/src/engine.ts:658`, `packages/triggers/src/{cron,queue,webhook,change}.ts` config parsing. M.
- **MED** `@weaveintel/encryption` SDK lazy-load casts: `kms-resolver.ts:47`, `providers/{aws-kms.ts:47, azure-kv.ts:55-56, gcp-kms.ts:51}`. S.
- **MED** `apps/geneweave/src/ui-client.ts:315` — `any` in render/error helpers. M.
- **LOW** `apps/geneweave/src/ui/parsers.ts:24` — `@ts-ignore`. S.

### Configuration
- **CRIT** No central config struct; envs read ad-hoc in 88 places. L.

### Documentation
- **HIGH** `.github/copilot-instructions.md` overstates observability deployment. S.
- **MED** 30/71 packages missing READMEs. M.
- **LOW** `VERSIONING.md` describes mature scheme; reality is 53 pkgs at 0.0.1, 18 at 0.1.0. S.

### Dependency / Versioning
- **HIGH** 71 packages at pre-release vs. VERSIONING.md "Aertex" v1.0.0. M.

### Build / CI
- **CRIT** `package.json` build script Turbo-only; `.github/workflows/test.yml:24` lacks `turbo typecheck` / `tsc -b`. M.

### Data layer / Schema
- **HIGH** `apps/geneweave/src/db-sqlite.ts:6586` — hardcoded model capability mapping (`modelId === 'claude-opus-4-20250514' || …`) drifts from routing intent. M.
- **MED** `apps/geneweave/src/db-sqlite-migrations.ts:2922` — `tenant_encryption_policy` uses TEXT timestamps while sibling tables use INTEGER ms epoch. S.
- **LOW** No `INTEGER PRIMARY KEY AUTOINCREMENT` regressions found. —

### Observability
- **HIGH** 1,864 `console.log` occurrences; no pino/winston; `@weaveintel/observability` only wired as default tracer in `apps/geneweave/src/index.ts`. L.
- **MED** `apps/geneweave/src/live-agents/kaggle/handlers/strategist.ts:77`, `chat-enterprise-tools-utils.ts:29` — direct `console.log` in runtime flow. S.

### Missing capabilities
- **HIGH** `packages/encryption/src/key-manager.ts:681` — Phase 8 TODO: per-BIK `kekId` tracking missing for KEK rotation. M.
- **MED** `packages/encryption/src/kms-resolver.ts:52` — `JSON.stringify` config hash only sorts top-level keys → cache-coherence risk. M.
- **LOW** `packages/tools-kaggle/src/kaggle.ts:88` — TODO on template parameterization. S.

### Concurrency
- See Performance/Concurrency above.

### Language smells
- **LOW** `packages/encryption/src/register-builtins.ts:105, 182` — Azure SDK casts. S.

## 4. Findings by Severity

### CRITICAL (5)
1. `db-sqlite.ts` 7,884-line god object — XL
2. 9+ unref-less `setInterval` across encryption/triggers/workflows/sandbox/runtime/browser — S
3. 88 unvalidated `process.env` reads — S
4. CI lacks typecheck step — M
5. Documented-but-unverified path traversal at `server.ts:2659-2686` — S

### HIGH (11)
1. SSRF via `connector.base_url` (`server-admin.ts:3110`) — S
2. Tool-simulation `BUILTIN_TOOLS` bypass (`tool-simulation.ts:358`) — M
3. Hardcoded model capability map (`db-sqlite.ts:6586`) — M
4. 221 `as any` in geneweave src — M
5. 0 dedicated tests across 54 admin/api routes — XL
6. 46/71 orphan packages — M
7. 71 packages stuck at pre-release versions — M
8. 1,864 `console.log`; observability package not wired — L
9. copilot-instructions.md overstates observability — S
10. `key-manager.ts:681` per-BIK kekId tracking gap — M
11. Encryption modules without unit tests (attestation/alert-evaluator/break-glass/kms-resolver) — M

### MEDIUM (15)
1. Error message leakage in admin handlers (8 instances) — S
2. e2e-phase*.mjs duplicated boilerplate (21 files) — M
3. `kms-resolver.ts:52` shallow JSON.stringify config hash — M
4. 30 packages missing READMEs — M
5. 26 packages with zero tests — L
6. Attestation chain verification incomplete (`byok/attestation.ts:237-244`) — M
7. Unsafe double-casts in triggers/workflows engine — M
8. SDK lazy-load casts in encryption KMS providers — S
9. `ui-client.ts:315` `any` in render path — M
10. Permission check in `server.ts:338` not in auth layer — M
11. Swallowed `recordInvocation` errors (`triggers/dispatcher.ts:557`) — M
12. Direct `console.log` in strategist + enterprise-tools-utils — S
13. Mixed timestamp conventions in encryption tables — S
14. No central config struct — L
15. Background timer in `sandbox/cse/session.ts:25` (also flagged CRIT) — S

### LOW (8)
1. Deprecated `ToolConfigRow` alias — S
2. `@ts-ignore` in `ui/parsers.ts:24` — S
3. VERSIONING.md vs reality drift — S
4. `tools-kaggle/src/kaggle.ts:88` TODO — S
5. `register-builtins.ts:105,182` Azure casts — S
6. No SQL injection / auth bypass in sampled paths (observation)
7. No PK regressions in migrations (observation)
8. `key-manager.ts:681` re-wrap TODO (also tracked as HIGH capability) — informational duplicate

## 5. Refactor Roadmap

### Phase A — Quick wins (≤1 sprint)
1. Add `.unref()` to all 9+ background timers.
2. Add startup `process.env` validation (zod schema) for JWT_SECRET, OAuth keys, KMS creds.
3. Add `turbo typecheck` (or `tsc -b`) to `.github/workflows/test.yml`.
4. Replace `(err as Error).message` returns with sanitized error envelope across admin handlers.
5. Patch `server-admin.ts:3110` SSRF: enforce allowlist/scheme/host validation on `connector.base_url`.
6. Verify and (if needed) patch path traversal at `server.ts:2659-2686`; close out the doc tracker.
7. Strip `console.log` from runtime paths (strategist, enterprise-tools-utils).

### Phase B — Stabilization (1–2 sprints)
8. Fix `kms-resolver.ts:52` config hash (deep canonicalization).
9. Add unit tests for `attestation.ts`, `alert-evaluator.ts`, `break-glass.ts`, `kms-resolver.ts`.
10. Implement per-BIK `kekId` tracking (`key-manager.ts:681`) to unblock KEK rotation.
11. Route tool simulation through enabled-catalog policy (kill `BUILTIN_TOOLS` lookup at `tool-simulation.ts:358`).
12. Move hardcoded model capability map (`db-sqlite.ts:6586`) into routing/capability config.
13. Extract shared `apiClient.mjs` for e2e-phase*.mjs.

### Phase C — Strategic (multi-sprint)
14. Carve `db-sqlite.ts` into per-domain repositories (encryption, tools, tenants, agents, …). Begin with encryption + tenants (smallest blast radius).
15. Stand up real logger (pino) and adopt `@weaveintel/observability` end-to-end; retire `console.log`.
16. Define admin-route test harness; backfill tests for the 54 admin/api files in priority order (BYOK, encryption, tools, tenants first).
17. Decide fate of 46 orphan packages: wire, archive, or extract.
18. Reconcile VERSIONING.md with package state — either bump packages or revise scheme.
19. Centralize config (single typed struct injected from env at boot).
20. Tighten type safety: replace `as any` and double-casts in geneweave + triggers/workflows.

## 6. Metrics Snapshot

- Apps: 2 (geneweave, live-agents-demo)
- Packages: 71 (53 @ 0.0.1, 18 @ 0.1.0)
- Orphan packages: 46/71
- Packages w/o tests: 26/71
- Packages w/o README: 30/71
- E2E scripts: 32 (`scripts/e2e-phase*.mjs`)
- Admin API route files: 54 (0 dedicated tests)
- `console.log` occurrences: 1,864
- `as any` in `apps/geneweave/src`: 221
- `process.env` reads in `apps/geneweave/src`: 88 (unvalidated)
- Background timers without `.unref()`: 9+
- Largest source files (LOC): db-sqlite 7,884 · db-types 3,612 · db-sqlite-migrations 3,167 · server-admin 3,132
- Encryption package tests: 14 files, ~83% coverage
- Build health: `npx tsc -b apps/geneweave` ✅
- Type density (any) in `@weaveintel/encryption`: <1%

## 7. Open Questions

1. Is the `server.ts:2659-2686` path traversal flagged in `docs/WEAVEINTEL_CODE_REVIEW_PHASE_PLAN.md` already patched? Doc dates 2 months back; needs human verification.
2. Are the 46 orphan packages intentional (pre-wiring for upcoming phases) or candidates for archive?
3. Is the Aertex v1.0.0 release plan still active? If so, what unblocks bumping the 71 pre-release packages?
4. Should the mixed timestamp convention in `tenant_encryption_policy` (TEXT) be standardized to INTEGER epoch ms, or is TEXT chosen for human-readability?
5. Is the `BUILTIN_TOOLS` simulation path a deliberate dev-only fallback or a production bug?
6. Does the encryption package's lazy SDK loading need typed wrappers, or is the cast pattern acceptable given the optional-deps strategy?
7. Is there an owner / SLO for the `@weaveintel/observability` rollout, or is it parked?
8. Should admin-API tests live alongside routes (`admin/api/*.test.ts`) or in a sibling `admin/api/__tests__/` tree?

## Constraints Followed
- Discovery only; no code changes applied.
- Sampling-based across 219K LOC; not exhaustive.
- File:line citations preserved for every actionable finding.
