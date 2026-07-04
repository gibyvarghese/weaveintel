# MIGRATION — weaveIntel framework/app separation + package consolidation

This document tracks the restructure described in [`docs/weaveIntel-monorepo-restructure.md`](docs/weaveIntel-monorepo-restructure.md):
turning the monorepo into a clean open-core project where `packages/*` + `clients/*` are the
MIT-licensed framework (`@weaveintel/*`, published to npm) and `apps/geneweave` + `apps/geneweave-ui`
are the community-edition apps that consume it — with **no geneWeave brand, config, or product
features leaking into the framework**.

It is written phase-by-phase. Each phase records what changed, why, and the exit-gate result.

---

## Phase 0 — Baseline & safety net

**Branch:** `restructure/framework-app-separation` (off `collab-phase-0`).
**Goal:** establish a trustworthy, reproducible **green** baseline so that every later phase can be
measured against it ("did I change geneWeave's behaviour?" is only answerable from a green start).

### What the baseline actually looked like (before any Phase 0 fix)

Running the full gate on the fresh branch surfaced that `collab-phase-0` was **not** green on its own
checks — turbo's fail-fast had been hiding several of these behind each other:

| Gate | Result on arrival | Notes |
|---|---|---|
| `turbo build` | ✅ 93/93 tasks | clean |
| `turbo typecheck` | ✅ green | |
| `turbo test` | ❌ red | two independent problems (below), the second masked by the first |
| `check:api-boundaries` | ✅ | |
| `check:no-adhoc-resilience` | ✅ | |
| `check:workspace-topology` | ❌ | 4 packages missing from root `tsconfig.json` references: `a11y`, `i18n`, `scope`, `voice` |
| `check:no-raw-fetch` | ❌ | 17 raw `fetch()` calls (see "Deferred", below) |
| `check:vocab-w9` | ❌ | 2 banned-term ("conversation") uses in `packages/collaboration/src/suggested-prompts.ts` |

**Four** independent test-suite problems, each masked behind the previous one by turbo's fail-fast
(only found by re-running with `--continue`):
1. **`@weaveintel/notes` stress test flaked under load.** `phase0.test.ts > STRESS: 5,000 suggestions`
   does genuinely O(n) work (~3.1 s in isolation) but had **no headroom** under the default 5 s vitest
   timeout when the whole monorepo suite runs in parallel with builds. It timed out at ~10 s under load,
   passed at 3.1 s isolated.
2. **`geneweave-mobile` (5 test files) could not resolve `@weaveintel/api-client`.** The workspace
   **correctly declared** the dependency and the package **built fine**, but the node_modules symlink was
   missing — the last `npm install` predated the `@geneweave/api-client → @weaveintel/api-client` rename.
3. **`geneweave-api` `w9-me.test.ts` (3 tests) — incomplete test double.** The suite's hand-rolled
   `buildDb()` fake (cast to the full adapter type, so TS didn't catch it) was missing
   `getSharedSessionByRun`, which `resolveRunAccess()` calls on the not-found path → `TypeError`. The
   real adapter (`db-sqlite.ts`) implements it; only the fake lagged.
4. **`geneweave-api` `a2a-skills-v2.test.ts` (1 test) flaked under load.** "15 parallel INITs" spins up
   15 fully-migrated DBs (~5 s of real work) against the same 5 s ceiling — no headroom.

### Safe fixes applied (to reach a genuine green baseline)

Per the agreed scope ("green the safe, zero/low-risk items now; defer the 17 raw-fetch sites"):

| Fix | File(s) | Risk | Why it's safe |
|---|---|---|---|
| Give the notes stress test a 30 s ceiling | `packages/notes/src/phase0.test.ts` | none | test-robustness only; still fails fast if the impl regresses to O(n²) |
| Give the a2a "15 parallel INITs" stress test a 30 s ceiling | `apps/geneweave/src/a2a-skills-v2.test.ts` | none | same — a data-integrity check that was losing a race under load |
| Add missing `getSharedSessionByRun` stub (returns `null`) to the test double | `apps/geneweave/src/routes/w9-me.test.ts` | none | test-only; matches the real adapter's not-found behaviour |
| Re-link workspaces (`npm install`) so `@weaveintel/api-client` resolves | `package-lock.json` | none | restores a workspace symlink that a rename had orphaned; no version changes |
| Add the 4 missing project references | root `tsconfig.json` | none | pure build metadata; those packages already build |
| Replace 2 banned-term prompt strings with neutral wording | `packages/collaboration/src/suggested-prompts.ts` | low | framework packages must avoid interaction-model terms ("conversation"/"chat"); reworded to "pick up where we left off" / "opening prompts" |

After these fixes: `build` ✅, `typecheck` ✅, `test` ✅ (all workspaces), `check:api-boundaries` ✅,
`check:workspace-topology` ✅, `check:no-adhoc-resilience` ✅, `check:vocab-w9` ✅.
(`check:no-raw-fetch` remains red **by design** — see below.)

> **Note on all four test failures:** none were product bugs — three were test-harness fragility
> (two under-margined stress timeouts, one incomplete fake DB) and one was an orphaned workspace symlink.
> No geneWeave runtime behaviour was changed. They mattered only because turbo's fail-fast had been
> hiding them, so the suite could never be trusted as a regression oracle for the restructure.

### Deferred to Phases 1–5 — `check:no-raw-fetch` (17 sites)

These are pre-existing raw `fetch()` calls that should go through each package's `_fetch.ts` wrapper
(server-side) or carry a sanctioned `// no-raw-fetch: allow (reason: …)` opt-out (legitimate
client-side browser fetches). Mass-editing them in a snapshot phase would muddy the baseline and touch
behaviour, so they are cleared **as each file is touched anyway** during the de-brand/split/consolidate
phases:

**Framework packages (route through the `_fetch` wrapper — do during that package's phase):**
- `packages/observability/src/otel-tracer.ts:199` → Phase 1 (this file is de-branded in Phase 1)
- `packages/a2a/src/push-notification-delivery.ts:74` → Phase 4/6
- `packages/live-agents-runtime/src/handlers/external-mcp-tool.ts:119` → Phase 4/6

**Apps (mostly legitimate client-side browser fetches — annotate with opt-out during Phase 2/6):**
- `apps/geneweave/src/routes/artifacts.ts:417`
- `apps/geneweave/src/run-notifications-outbox.ts:156`
- `apps/geneweave-ui/src/ui/admin-ui.ts:132,136,148,162,171,187`
- `apps/geneweave-ui/src/ui/voice-agent.ts:141,149,209,252,264,537`

### Additional findings (recorded per the plan's "Additional findings" rule)

- **Apps are not marked `private: true`.** `@weaveintel/geneweave-api`, `@weaveintel/geneweave-ui`, and
  `@weaveintel/live-agents-demo` are publishable by accident (only `clients/desktop` and `clients/mobile`
  are private). The community-edition apps should not be npm packages. **Action (later phase):** add
  `"private": true` to the app manifests so they can never be published. Recorded here; not changed in
  Phase 0 (no behaviour impact today).
- **`@weaveintel/api-client` vs `@weaveintel/client`.** `api-client` (in `clients/`) depends on `client`
  and is consumed only by `geneweave-mobile`. The plan (Clients & UI) asks to verify whether it
  duplicates `client` and merge if so — flagged for Phase 4.
- **26 leaf packages** (zero internal consumers) — the merge/example candidates that motivate the
  87 → ~40 consolidation. Listed in the inventory below.

### Phase 0 exit gate

- **Green baseline achieved and verified with `--continue` (so no failure can hide behind another):**
  `npx turbo build typecheck test --continue` → **267/267 tasks successful, 4533 test cases passing, exit 0.**
- Checks: `check:api-boundaries` ✅, `check:workspace-topology` ✅, `check:no-adhoc-resilience` ✅,
  `check:vocab-w9` ✅. `check:no-raw-fetch` intentionally deferred and fully documented (17 sites above).
- Dependency inventory (below) generated by `scripts/gen-dependency-inventory.mjs` (re-runnable;
  machine-readable copy at `scripts/dependency-inventory.json`) and committed as the "before" snapshot.

> **Lesson for later phases:** always run the gate with `--continue`. Turbo's default fail-fast hid
> four independent failures behind one another here; a phase gate that stops at the first red gives a
> false "one thing to fix" picture.

---

## Phase 1 — De-brand the framework

**Goal:** an outsider who installs `@weaveintel/*` must never find a consuming app's brand
(geneWeave / weaveNotes / …) in the source or its doc comments — while geneWeave keeps its exact
behaviour by injecting its own brand values.

### Runtime brand defaults neutralised (framework) + injected by the app

| Framework file | Was | Now (neutral default) | App injects |
|---|---|---|---|
| `observability/src/otel-tracer.ts` | `serviceName ?? 'geneweave'` | `?? 'weaveintel'` | app already passes `serviceName: 'geneweave'` (`apps/geneweave/src/index.ts`) — no change needed |
| `live-agents-runtime/src/heartbeat-supervisor.ts` | `workerIdPrefix ?? 'geneweave-live-worker'` | `?? 'weaveintel-live-worker'` | `generic-supervisor-boot.ts` now passes `workerIdPrefix: 'geneweave-live-worker'` |
| `heartbeat-supervisor.ts` | hardcoded `userId: 'human:geneweave-system'` | new injectable `systemPrincipal` option, default `'human:weaveintel-system'` | `generic-supervisor-boot.ts` passes `systemPrincipal: 'human:geneweave-system'` |
| `weave-live-mesh-from-db.ts` | forwarded `workerIdPrefix` only | now also forwards `systemPrincipal` to the supervisor | — |
| `devtools/src/scaffold.ts` | `full-stack` template depended on non-existent `@weaveintel/geneweave` | depends on real published `@weaveintel/weaveintel` + `client` + `ui-primitives` | — |

**Research note (OTel):** the OpenTelemetry spec says an unset `service.name` should fall back to
`unknown_service`, not a brand name. We follow the plan's explicit `'weaveintel'` default (the
framework's own identity, not the app's) and document the convention in the option's JSDoc so adopters
override it. Grounded via the OTel semantic-conventions docs.

### The guard: `check:no-app-brand`

New `scripts/check-no-app-brand.mjs` (+ `npm run check:no-app-brand`, wired into
`.github/workflows/test.yml` next to `check:api-boundaries`). Scans every `packages/<name>/src` tree +
`clients/tokens/src` (excludes tests / `.d.ts` / build output) for `geneweave|weavenotes|rentweave|weavestrike`
(case-insensitive). Allowlist `scripts/no-app-brand-allowlist.json` supports a **phase-tagged deferral
ratchet**: `packages/notes/` → Phase 2, `clients/tokens/` → Phase 4 (those are de-branded when they're
restructured; the deferral entry is deleted then). Result after this phase:
**PASS — 0 leaks in 972 framework files** (96 hits deferred to Phase 2, 18 to Phase 4).

### The comment sweep (~183 occurrences, 95 files)

Every geneWeave/weaveNotes mention in framework source (outside the deferred packages/tests) reworded to
neutral, adopter-teaching phrasing ("a consuming application", "the host application", "the reference
app"). Done via 6 parallel agents, each on a disjoint file set, then verified: the diff touched **only
comments and 3 human-facing error-message strings** (`'Geneweave must supply X'` → `'The host
application must supply X'`) — no identifiers, imports, exports, keys, enum/config/DB values, or logic
changed (confirmed by grepping the diff for any removed non-comment brand line: none).

### Tests added

- `devtools/src/scaffold.test.ts` (10 tests) — every scaffold template dependency resolves (in-workspace
  or known npm); explicitly guards against another phantom like `@weaveintel/geneweave`.
- `observability/src/otel-tracer.test.ts` — default `service.name` is the neutral `'weaveintel'`; an
  injected value (e.g. `'geneweave'`) wins.
- `live-agents-runtime/src/weave-live-mesh-from-db.test.ts` — an app-injected `workerIdPrefix` +
  `systemPrincipal` flow through the mesh entry point into the supervisor.

### Phase 1 exit gate ✅

- `turbo build typecheck test --continue` → **267/267 tasks, 4546 test cases, exit 0** (+13 new tests).
- `check:no-app-brand` → **PASS**. Other checks unchanged from Phase 0 (`no-raw-fetch` still deferred).
- **geneWeave app boots** from source with the de-branded framework: booted on a spare port, `/` → 200,
  `/docs` → 200, `/api/models` → 401 (auth-gated, alive), the live-agent supervisor started with the
  app-injected `geneweave-live-worker` / `human:geneweave-system` values, zero errors/throws.

### Not applicable to this phase (flagged, not skipped silently)

Real-LLM e2e, Playwright/`dc.html` screenshot comparison, new agents/tools, README/`docs-html.ts`
rewrites, npm publish, and private-repo sync do **not** belong to a de-brand refactor: there is no new
capability, no UI surface change, and the plan schedules all publishing for Phase 8, docs for Phase 7,
and the private-repo sync for Phase 9.

---

## Phase 2 — Split `notes` (the big one)

`@weaveintel/notes` today is 32 modules / ~6,600 LOC mixing three things: a genuine generic
"structured notes" capability, framework concerns duplicated elsewhere, and weaveNotes **product**
features + brand. It's consumed by **28 `apps/geneweave` files + 7 `apps/geneweave-ui` files**. Too big
and interdependent for one commit — executed as **gated sub-steps**, each moving one coherent unit,
rewiring every consumer, and leaving the suite green.

**Target end-state of `@weaveintel/notes` (slim):** `note-repository{,-contract}`, `note-doc`,
`note-nodes`, `wiki-links`, `entities`, `extract`, `note-database`, `note-memory`, `provenance`
(genericized) — plus `note-export` arriving from coedit in Phase 3.

### Sub-step plan & status

| Sub-step | Move | Destination | Status |
|---|---|---|---|
| 2a | `prompt-safety.ts` (spotlighting) | `guardrails` (+ `/spotlighting` subpath) | ✅ done |
| 2b | `translate.ts` | `prompts` | ✅ done |
| 2c | `mcp.ts` (transport-free JSON-RPC core) | `mcp-server` | ✅ done |
| 2d | `scheduled-agent.ts` (split: cron+budget→triggers, recipes→app) | `triggers` + app | ✅ done |
| 2e | `rag.ts` (+ rag-citations) | `retrieval` (reconcile RRF `hybrid.ts` + `citations.ts`) | ✅ done |
| 2f | product modules → apps (batched by UI/server coupling) | `apps/geneweave` (+ `-ui`) | 🔵 in progress (Batch A done) |
| 2g | slim `index.ts`, genericize `provenance.ts`, drop the notes deferral from the no-app-brand allowlist | — | ⏳ |

### 2a — `prompt-safety.ts` → `@weaveintel/guardrails/spotlighting` ✅

Injection-defence spotlighting (instruction–data separation, OWASP LLM01) is a **framework-wide**
guardrail, not a notes feature. Moved `makeFence`/`fenceUntrusted`/`spotlightPreamble`/`spotlight`
(zero-dep, brand-free) into `packages/guardrails/src/spotlighting.ts`, exported both from the barrel
and as the subpath `@weaveintel/guardrails/spotlighting`. Guardrails already owned the prompt-injection
*seed rules*; this adds the *defensive wrapper* to the same package. De-branded the module header
(dropped "note AI"/"Phase 0-D"). Test moved + **enhanced** (added multi-fence-forgery security case,
task/payload-separation case, and a 2 MB stress case). Rewired **4 app consumers** (note-ai-sql,
note-colorize-sql, note-creative-sql, note-scheduled-agent-sql) from `@weaveintel/notes` →
`@weaveintel/guardrails/spotlighting` — the typecheck gate caught 3 my initial grep missed
(multi-line imports). Removed the notes barrel re-export + deleted the notes module/test.

Gate: guardrails 314 tests (+8 spotlighting), notes 339, app typecheck 62/62, `check:no-app-brand`
PASS. Full suite: 266/267 tasks — the lone failure is a **network-flaky `arxiv_search` test** in
scientific-validation that passes in isolation (pre-existing external-API flakiness, unrelated to this
move; noted alongside the Phase 0 flakes).

### 2b — `translate.ts` → `@weaveintel/prompts` ✅

Faithful, structure-preserving translation is prompt-construction + span protection (mask
code/URLs/@mentions/[[wiki-links]] so the model can't mangle them, spotlight against injection, verify
the round-trip) — reusable by any app, not a notes feature. `git mv`'d `translate.ts` + its 18-test
suite into `packages/prompts/src/`, re-headed the module for prompts, de-branded the one comment, and
exported from the prompts barrel. Rewired the 2 real app consumers (`i18n-sql.ts`,
`note-translate-sql.ts` — both import translate-only blocks) `@weaveintel/notes` → `@weaveintel/prompts`;
removed the notes barrel block. Gate: **267/267 tasks, exit 0** (translate.test now runs in prompts).

### 2c — `mcp.ts` → `@weaveintel/mcp-server` (`jsonrpc.ts`) ✅

The transport-free JSON-RPC 2.0 core (`handleMcpMessage` handling `initialize`/`tools/list`/
`tools/call`/…) is the MCP wire protocol — it belongs with the framework's one MCP implementation, not
in notes. Confirmed mcp-server had **no competing dispatch** (clean fold-in, not a merge). `git mv`'d
`mcp.ts` + its 10-test suite to `mcp-server/src/jsonrpc.ts`, re-headed + de-branded, exported from the
barrel (pairs with the batteries-included `weaveMCPServer`). Rewired the one consumer
(`mcp-notes-sql.ts`) — split its import so `extractPlainText` stays from notes and the MCP symbols come
from `@weaveintel/mcp-server`. Gate: **267/267 tasks, exit 0**.

### 2d — `scheduled-agent.ts` → split (`triggers` + app) ✅

Not a clean move — the module mixed **generic** primitives with **note-product** recipes. Rather than
make slim-notes depend on `triggers` (which drags in aws-sdk/mongodb/pg/redis), split it fully:
- **generic → `@weaveintel/triggers`:** the timezone-aware 5-field cron evaluator became
  `cron-schedule.ts` (`isValidCron`/`isValidTimezone`/`cronMatches`/`cronNextRun`) — this replaces
  triggers' crude internal `parseCronToMs` interval hack with a *correct* evaluator; and the run budget
  became `run-budget.ts` (`newRunBudget`/`chargeBudget`/`budgetExhausted`/`budgetRemaining`, signature
  genericized off `ScheduledAgentConfig`). **Research-grounded:** the day-of-month/day-of-week
  OR-vs-intersection rule matches the Vixie/POSIX standard (validated against the crontab spec).
- **product → app:** the recipe catalog + `ScheduledAgentConfig` + validator moved to
  `apps/geneweave/src/scheduled-agent-config.ts` (imports the cron/budget primitives from triggers).
- `scheduled-agent.{ts,test.ts}` deleted from notes; the one consumer (`note-scheduled-agent-sql.ts`)
  rewired three ways (extractPlainText←notes, cron/budget←triggers, config←local). Tests split by
  concern (cron+budget → triggers, config → app). Gate: **267/267 tasks, exit 0** (triggers +10 tests,
  app scheduled-agent-config +5).

### 2e — `rag.ts` (+ rag-citations) → `@weaveintel/retrieval` ✅

RAG (retrieval-augmented generation) belongs with the retrieval package, not notes. Reconciliation
findings: retrieval's `weaveCitationExtractor` + its `Citation`/`CitationResult` types had **no real
consumers** (dead-wired), while rag's citation suite (character-verified quotes: `locateQuote`,
`verifyCitations`, `buildCitedAnswerPrompt`, `answerCitationCoverage`, …) is the rich, used one. So:
- **`Citation` name collision** resolved by renaming retrieval's unused chunk-citation model
  `Citation` → `ExtractedCitation`; rag's verified-quote `Citation` becomes the package's canonical one.
- **RRF:** rag's standalone `reciprocalRankFusion` (general, unweighted, N-list) is now the canonical
  exported helper; `hybrid.ts` keeps its internal *weighted 2-list* variant (vector vs keyword) with a
  cross-reference comment. One exported RRF; no lost behaviour.
- **No collision** with retrieval's `query-rewriter.ts`/`chunker.ts` (different concerns), and **no
  notes-internal module used rag** — so notes gains no dependency and stays slim (retrieval is
  core-only, light).
- `git mv`'d `rag.ts` + both test files (40 tests) into retrieval; de-branded the header. Rewired the 2
  app consumers (`chat-citations-sql.ts` all-rag → retrieval; `note-workspace-sql.ts` split:
  extractPlainText+Note←notes, rag←retrieval) and added `@weaveintel/retrieval` to the app manifest.

Gate: **267/267 tasks, exit 0**; `check:api-boundaries` PASS; `check:no-app-brand` PASS.

### 2f — product modules → the apps (batched by UI/server coupling) 🔵 in progress

**Key architecture constraint discovered:** `apps/geneweave-ui` does **not** depend on `apps/geneweave`,
but the app **does** depend on the UI package (`geneweave-api` → `geneweave-ui`). So: modules used only
by the server → `apps/geneweave`; modules used by the UI (or by both) → `apps/geneweave-ui`. The UI's
entire `@weaveintel/notes` surface is just 6 symbols from **colorize / ink / diagram**, and those form a
coupled cluster (`ink→creative`, `diagram→colorize→agency`) that must move to `geneweave-ui` together
(with agency's palette split per the plan). That's a later batch.

**Decisions taken:** `study.ts` (FSRS/SM-2) → **app** (not kept in the framework): the exception rule
*permits* keeping brand-free reusable maths, but flashcard scheduling would stretch slim-notes' scope
beyond "note documents"; default "when in doubt, app" applies. `agency.ts` → **split** later (generic
`AgencyContract` type stays in notes; geneWeave palette + byline → app).

**Batch A ✅ (this step):** moved 5 self-contained **server-only** modules (+ their tests) to
`apps/geneweave/src/notes/`: `governance`, `capture`, `meeting`, `visual-verify`, `image-search`.
Removed their notes-barrel exports; rewired 6 consumers with correct relative paths
(`note-creative-sql` split visual-verify+image-search out from the still-in-notes diagram/ink/svg
imports; `admin/api/tenant-governance` at `../../notes/`; an inline `import('…').TranscriptSegment`
type in `me-notes` retargeted). These modules' brand strings leave the framework (fewer notes-deferred
hits in `check:no-app-brand`).

**Remaining 2f batches:** Batch B — `notes-config`, `templates`, `study`, `desktop`, `suggestions`,
`svg` (server-only, larger/some cross-refs). Batch C — the UI cluster `colorize`/`ink`/`diagram`/
`creative`/`agency` → `geneweave-ui` (+ agency split). Then **2g**.

---

## Before snapshot — dependency inventory

Generated by `scripts/gen-dependency-inventory.mjs` on branch `restructure/framework-app-separation` (baseline off `collab-phase-0`).

### Counts

| Metric | Count |
|---|---|
| Total workspaces | 94 |
| `packages/*` | 87 |
| `clients/*` | 4 |
| `apps/*` | 3 |
| Published (non-private) | 92 |
| Private (not published) | 2 |

### Published package names (the `@weaveintel/*` surface today)

| Package | Version | Internal deps | Dependents (reverse-deps) |
|---|---|---|---|
| `@weaveintel/a11y` | 0.0.1 | — | **(no internal consumers)** |
| `@weaveintel/a2a` | 0.0.1 | @weaveintel/core | @weaveintel/agents, @weaveintel/geneweave-api, @weaveintel/live-agents-runtime |
| `@weaveintel/agents` | 0.0.1 | @weaveintel/a2a, @weaveintel/compliance, @weaveintel/core, @weaveintel/cost-governor, @weaveintel/evals, @weaveintel/graph, @weaveintel/human-tasks, @weaveintel/models, @weaveintel/prompts | @weaveintel/geneweave-api, @weaveintel/live-agents, @weaveintel/live-agents-runtime, @weaveintel/recipes, @weaveintel/weaveintel |
| `@weaveintel/api-client` | 0.0.1 | @weaveintel/client, @weaveintel/core | geneweave-mobile |
| `@weaveintel/artifacts` | 0.0.1 | @weaveintel/core | **(no internal consumers)** |
| `@weaveintel/cache` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/capability-packs` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/client` | 0.0.1 | @weaveintel/core | @weaveintel/api-client, @weaveintel/react-client |
| `@weaveintel/coedit` | 0.0.1 | — | @weaveintel/geneweave-api |
| `@weaveintel/collaboration` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/compliance` | 0.0.1 | @weaveintel/core, @weaveintel/persistence | @weaveintel/agents |
| `@weaveintel/contracts` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/core` | 0.0.1 | — | @weaveintel/a2a, @weaveintel/agents, @weaveintel/api-client, @weaveintel/artifacts, @weaveintel/cache, @weaveintel/capability-packs, @weaveintel/client, @weaveintel/collaboration, @weaveintel/compliance, @weaveintel/contracts, @weaveintel/cost-governor, @weaveintel/devtools, @weaveintel/encryption, @weaveintel/equity-scoring, @weaveintel/evals, @weaveintel/extraction, @weaveintel/geneweave-api, @weaveintel/graph, @weaveintel/guardrails, @weaveintel/human-tasks, @weaveintel/identity, @weaveintel/live-agents, @weaveintel/live-agents-demo, @weaveintel/live-agents-runtime, @weaveintel/live-agents-trace-tools, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/mcp-statsnz, @weaveintel/memory, @weaveintel/models, @weaveintel/notifications, @weaveintel/oauth, @weaveintel/observability, @weaveintel/persistence, @weaveintel/plugins, @weaveintel/prompts, @weaveintel/provider-anthropic, @weaveintel/provider-google, @weaveintel/provider-llamacpp, @weaveintel/provider-ollama, @weaveintel/provider-openai, @weaveintel/recipes, @weaveintel/redaction, @weaveintel/reliability, @weaveintel/replay, @weaveintel/resilience, @weaveintel/retrieval, @weaveintel/routing, @weaveintel/sandbox, @weaveintel/skills, @weaveintel/social-growth, @weaveintel/tenancy, @weaveintel/testing, @weaveintel/tool-schema, @weaveintel/tools, @weaveintel/tools-altdata, @weaveintel/tools-broker, @weaveintel/tools-browser, @weaveintel/tools-dropbox, @weaveintel/tools-enterprise, @weaveintel/tools-filewatch, @weaveintel/tools-gcal, @weaveintel/tools-gdrive, @weaveintel/tools-gmail, @weaveintel/tools-http, @weaveintel/tools-imap, @weaveintel/tools-kaggle, @weaveintel/tools-marketdata, @weaveintel/tools-news, @weaveintel/tools-onedrive, @weaveintel/tools-outlook, @weaveintel/tools-outlook-cal, @weaveintel/tools-search, @weaveintel/tools-slack, @weaveintel/tools-social, @weaveintel/tools-time, @weaveintel/tools-webhook, @weaveintel/triggers, @weaveintel/ui-primitives, @weaveintel/voice, @weaveintel/weaveintel, @weaveintel/workflows |
| `@weaveintel/cost-governor` | 0.0.1 | @weaveintel/core, @weaveintel/tools | @weaveintel/agents, @weaveintel/geneweave-api |
| `@weaveintel/devtools` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/durability` | 0.0.1 | @weaveintel/reliability | @weaveintel/geneweave-api, @weaveintel/notifications |
| `@weaveintel/encryption` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/equity-scoring` | 0.1.0 | @weaveintel/core, @weaveintel/tools-altdata, @weaveintel/tools-marketdata, @weaveintel/tools-news | **(no internal consumers)** |
| `@weaveintel/evals` | 0.0.1 | @weaveintel/core | @weaveintel/agents, @weaveintel/geneweave-api |
| `@weaveintel/extraction` | 0.0.1 | @weaveintel/core | **(no internal consumers)** |
| `@weaveintel/geneweave-api` | 1.0.0 | @weaveintel/a2a, @weaveintel/agents, @weaveintel/cache, @weaveintel/capability-packs, @weaveintel/coedit, @weaveintel/collaboration, @weaveintel/contracts, @weaveintel/core, @weaveintel/cost-governor, @weaveintel/devtools, @weaveintel/durability, @weaveintel/encryption, @weaveintel/evals, @weaveintel/geneweave-ui, @weaveintel/guardrails, @weaveintel/human-tasks, @weaveintel/i18n, @weaveintel/identity, @weaveintel/live-agents, @weaveintel/live-agents-runtime, @weaveintel/live-agents-trace-tools, @weaveintel/mcp-server, @weaveintel/mcp-statsnz, @weaveintel/memory, @weaveintel/models, @weaveintel/notes, @weaveintel/notifications, @weaveintel/oauth, @weaveintel/observability, @weaveintel/persistence, @weaveintel/prompts, @weaveintel/provider-anthropic, @weaveintel/provider-google, @weaveintel/provider-llamacpp, @weaveintel/provider-ollama, @weaveintel/provider-openai, @weaveintel/recipes, @weaveintel/redaction, @weaveintel/reliability, @weaveintel/replay, @weaveintel/resilience, @weaveintel/routing, @weaveintel/sandbox, @weaveintel/scope, @weaveintel/skills, @weaveintel/tenancy, @weaveintel/testing, @weaveintel/tokens, @weaveintel/tools, @weaveintel/tools-browser, @weaveintel/tools-enterprise, @weaveintel/tools-http, @weaveintel/tools-search, @weaveintel/tools-time, @weaveintel/triggers, @weaveintel/ui-primitives, @weaveintel/workflows | **(no internal consumers)** |
| `@weaveintel/geneweave-ui` | 1.0.0 | @weaveintel/tokens, @weaveintel/ui-primitives | @weaveintel/geneweave-api |
| `@weaveintel/graph` | 0.0.1 | @weaveintel/core | @weaveintel/agents, @weaveintel/memory |
| `@weaveintel/guardrails` | 0.0.1 | @weaveintel/core, @weaveintel/testing | @weaveintel/geneweave-api |
| `@weaveintel/human-tasks` | 0.0.1 | @weaveintel/core | @weaveintel/agents, @weaveintel/geneweave-api, @weaveintel/memory, @weaveintel/workflows |
| `@weaveintel/i18n` | 0.0.1 | — | @weaveintel/geneweave-api |
| `@weaveintel/identity` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api, @weaveintel/live-agents |
| `@weaveintel/live-agents` | 0.0.1 | @weaveintel/agents, @weaveintel/core, @weaveintel/identity, @weaveintel/mcp-client, @weaveintel/memory, @weaveintel/observability, @weaveintel/replay, @weaveintel/tools | @weaveintel/geneweave-api, @weaveintel/live-agents-demo, @weaveintel/live-agents-runtime |
| `@weaveintel/live-agents-demo` | 0.1.0 | @weaveintel/core, @weaveintel/live-agents, @weaveintel/persistence, @weaveintel/testing | **(no internal consumers)** |
| `@weaveintel/live-agents-runtime` | 0.0.1 | @weaveintel/a2a, @weaveintel/agents, @weaveintel/core, @weaveintel/live-agents, @weaveintel/tools | @weaveintel/geneweave-api |
| `@weaveintel/live-agents-trace-tools` | 0.0.1 | @weaveintel/core, @weaveintel/tools | @weaveintel/geneweave-api |
| `@weaveintel/mcp-client` | 0.0.1 | @weaveintel/core, @weaveintel/mcp-server | @weaveintel/live-agents, @weaveintel/tools-altdata(dev), @weaveintel/tools-broker(dev), @weaveintel/tools-dropbox, @weaveintel/tools-filewatch, @weaveintel/tools-gcal, @weaveintel/tools-gdrive, @weaveintel/tools-gmail, @weaveintel/tools-imap, @weaveintel/tools-kaggle(dev), @weaveintel/tools-marketdata(dev), @weaveintel/tools-news(dev), @weaveintel/tools-onedrive, @weaveintel/tools-outlook, @weaveintel/tools-outlook-cal, @weaveintel/tools-slack, @weaveintel/tools-webhook |
| `@weaveintel/mcp-server` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api, @weaveintel/mcp-client(dev), @weaveintel/mcp-statsnz, @weaveintel/sandbox, @weaveintel/tools-altdata, @weaveintel/tools-broker, @weaveintel/tools-dropbox, @weaveintel/tools-filewatch, @weaveintel/tools-gcal, @weaveintel/tools-gdrive, @weaveintel/tools-gmail, @weaveintel/tools-imap, @weaveintel/tools-kaggle, @weaveintel/tools-marketdata, @weaveintel/tools-news, @weaveintel/tools-onedrive, @weaveintel/tools-outlook, @weaveintel/tools-outlook-cal, @weaveintel/tools-slack, @weaveintel/tools-webhook |
| `@weaveintel/mcp-statsnz` | 0.0.1 | @weaveintel/core, @weaveintel/mcp-server, @weaveintel/tools-http | @weaveintel/geneweave-api |
| `@weaveintel/memory` | 0.0.1 | @weaveintel/core, @weaveintel/graph, @weaveintel/human-tasks | @weaveintel/geneweave-api, @weaveintel/live-agents, @weaveintel/persistence |
| `@weaveintel/models` | 0.0.1 | @weaveintel/core | @weaveintel/agents, @weaveintel/geneweave-api, @weaveintel/provider-anthropic, @weaveintel/provider-google, @weaveintel/provider-llamacpp, @weaveintel/provider-ollama, @weaveintel/provider-openai |
| `@weaveintel/notes` | 0.0.1 | @weaveintel/tokens | @weaveintel/geneweave-api, geneweave-mobile |
| `@weaveintel/notifications` | 0.0.1 | @weaveintel/core, @weaveintel/durability, @weaveintel/resilience | @weaveintel/geneweave-api |
| `@weaveintel/oauth` | 0.1.0 | @weaveintel/core, @weaveintel/persistence | @weaveintel/geneweave-api |
| `@weaveintel/observability` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api, @weaveintel/live-agents, @weaveintel/weaveintel |
| `@weaveintel/persistence` | 0.0.1 | @weaveintel/core, @weaveintel/memory | @weaveintel/compliance(dev), @weaveintel/geneweave-api, @weaveintel/live-agents-demo, @weaveintel/oauth(dev), @weaveintel/reliability(dev), @weaveintel/weaveintel |
| `@weaveintel/plugins` | 0.0.1 | @weaveintel/core | **(no internal consumers)** |
| `@weaveintel/prompts` | 0.0.1 | @weaveintel/core | @weaveintel/agents, @weaveintel/geneweave-api |
| `@weaveintel/provider-anthropic` | 0.0.1 | @weaveintel/core, @weaveintel/models, @weaveintel/resilience, @weaveintel/tool-schema | @weaveintel/geneweave-api(peer) |
| `@weaveintel/provider-google` | 0.0.1 | @weaveintel/core, @weaveintel/models, @weaveintel/resilience, @weaveintel/tool-schema | @weaveintel/geneweave-api(peer) |
| `@weaveintel/provider-llamacpp` | 0.0.1 | @weaveintel/core, @weaveintel/models, @weaveintel/tool-schema | @weaveintel/geneweave-api(peer) |
| `@weaveintel/provider-ollama` | 0.0.1 | @weaveintel/core, @weaveintel/models, @weaveintel/tool-schema | @weaveintel/geneweave-api(peer) |
| `@weaveintel/provider-openai` | 0.0.1 | @weaveintel/core, @weaveintel/models, @weaveintel/resilience, @weaveintel/tool-schema | @weaveintel/geneweave-api(peer) |
| `@weaveintel/react-client` | 0.0.1 | @weaveintel/client | **(no internal consumers)** |
| `@weaveintel/recipes` | 0.0.1 | @weaveintel/agents, @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/redaction` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/reliability` | 0.0.1 | @weaveintel/core, @weaveintel/persistence | @weaveintel/durability, @weaveintel/geneweave-api, @weaveintel/tools-broker, @weaveintel/tools-kaggle, @weaveintel/tools-marketdata, @weaveintel/tools-news, @weaveintel/weaveintel |
| `@weaveintel/replay` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api, @weaveintel/live-agents |
| `@weaveintel/resilience` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api, @weaveintel/notifications, @weaveintel/provider-anthropic, @weaveintel/provider-google, @weaveintel/provider-openai, @weaveintel/tools, @weaveintel/tools-http, @weaveintel/tools-kaggle, @weaveintel/tools-marketdata, @weaveintel/weaveintel |
| `@weaveintel/retrieval` | 0.0.1 | @weaveintel/core | **(no internal consumers)** |
| `@weaveintel/routing` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/sandbox` | 0.0.1 | @weaveintel/core, @weaveintel/mcp-server | @weaveintel/geneweave-api, @weaveintel/testing, @weaveintel/tools-kaggle |
| `@weaveintel/scope` | 0.0.1 | @weaveintel/testing | @weaveintel/geneweave-api |
| `@weaveintel/skills` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/social-growth` | 0.0.1 | @weaveintel/core, @weaveintel/workflows | **(no internal consumers)** |
| `@weaveintel/tenancy` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/testing` | 0.0.1 | @weaveintel/core, @weaveintel/sandbox | @weaveintel/geneweave-api(dev), @weaveintel/guardrails(dev), @weaveintel/live-agents-demo(dev), @weaveintel/scope(dev), @weaveintel/tools-altdata(dev), @weaveintel/tools-broker(dev), @weaveintel/tools-dropbox(dev), @weaveintel/tools-filewatch(dev), @weaveintel/tools-gcal(dev), @weaveintel/tools-gdrive(dev), @weaveintel/tools-gmail(dev), @weaveintel/tools-imap(dev), @weaveintel/tools-kaggle(dev), @weaveintel/tools-marketdata(dev), @weaveintel/tools-news(dev), @weaveintel/tools-onedrive(dev), @weaveintel/tools-outlook(dev), @weaveintel/tools-outlook-cal(dev), @weaveintel/tools-slack(dev), @weaveintel/tools-webhook(dev) |
| `@weaveintel/tokens` | 0.0.1 | — | @weaveintel/geneweave-api, @weaveintel/geneweave-ui, @weaveintel/notes(dev), geneweave-mobile |
| `@weaveintel/tool-schema` | 0.1.0 | @weaveintel/core | @weaveintel/provider-anthropic, @weaveintel/provider-google, @weaveintel/provider-llamacpp, @weaveintel/provider-ollama, @weaveintel/provider-openai |
| `@weaveintel/tools` | 0.0.1 | @weaveintel/core, @weaveintel/resilience | @weaveintel/cost-governor, @weaveintel/geneweave-api, @weaveintel/live-agents, @weaveintel/live-agents-runtime, @weaveintel/live-agents-trace-tools, @weaveintel/tools-altdata, @weaveintel/tools-broker, @weaveintel/tools-browser, @weaveintel/tools-dropbox, @weaveintel/tools-enterprise, @weaveintel/tools-filewatch, @weaveintel/tools-gcal, @weaveintel/tools-gdrive, @weaveintel/tools-gmail, @weaveintel/tools-http, @weaveintel/tools-imap, @weaveintel/tools-kaggle, @weaveintel/tools-marketdata, @weaveintel/tools-news, @weaveintel/tools-onedrive, @weaveintel/tools-outlook, @weaveintel/tools-outlook-cal, @weaveintel/tools-search, @weaveintel/tools-slack, @weaveintel/tools-social, @weaveintel/tools-webhook, @weaveintel/weaveintel |
| `@weaveintel/tools-altdata` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | @weaveintel/equity-scoring |
| `@weaveintel/tools-broker` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/reliability, @weaveintel/testing, @weaveintel/tools, @weaveintel/tools-marketdata | **(no internal consumers)** |
| `@weaveintel/tools-browser` | 0.1.0 | @weaveintel/core, @weaveintel/tools | @weaveintel/geneweave-api |
| `@weaveintel/tools-dropbox` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-enterprise` | 0.1.0 | @weaveintel/core, @weaveintel/tools | @weaveintel/geneweave-api |
| `@weaveintel/tools-filewatch` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-gcal` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-gdrive` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-gmail` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-http` | 0.1.0 | @weaveintel/core, @weaveintel/resilience, @weaveintel/tools | @weaveintel/geneweave-api, @weaveintel/mcp-statsnz |
| `@weaveintel/tools-imap` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-kaggle` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/reliability, @weaveintel/resilience, @weaveintel/sandbox, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-marketdata` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/reliability, @weaveintel/resilience, @weaveintel/testing, @weaveintel/tools | @weaveintel/equity-scoring, @weaveintel/tools-broker |
| `@weaveintel/tools-news` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/reliability, @weaveintel/testing, @weaveintel/tools | @weaveintel/equity-scoring |
| `@weaveintel/tools-onedrive` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-outlook` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-outlook-cal` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-search` | 0.0.1 | @weaveintel/core, @weaveintel/tools | @weaveintel/geneweave-api |
| `@weaveintel/tools-slack` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-social` | 0.1.0 | @weaveintel/core, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/tools-time` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/tools-webhook` | 0.1.0 | @weaveintel/core, @weaveintel/mcp-client, @weaveintel/mcp-server, @weaveintel/testing, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/triggers` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api |
| `@weaveintel/ui-primitives` | 0.0.1 | @weaveintel/core | @weaveintel/geneweave-api, @weaveintel/geneweave-ui |
| `@weaveintel/voice` | 0.0.1 | @weaveintel/core | **(no internal consumers)** |
| `@weaveintel/weaveintel` | 0.0.1 | @weaveintel/agents, @weaveintel/core, @weaveintel/observability, @weaveintel/persistence, @weaveintel/reliability, @weaveintel/resilience, @weaveintel/tools | **(no internal consumers)** |
| `@weaveintel/workflows` | 0.0.1 | @weaveintel/core, @weaveintel/human-tasks | @weaveintel/geneweave-api, @weaveintel/social-growth |

### Private workspaces (apps + non-published clients)

| Workspace | Dir | Internal deps (count) |
|---|---|---|
| `@geneweave/desktop` | clients/desktop | 0 |
| `geneweave-mobile` | clients/mobile | 3 |

### Leaf packages (zero internal consumers — merge/example candidates)

- `@weaveintel/a11y`
- `@weaveintel/artifacts`
- `@weaveintel/equity-scoring`
- `@weaveintel/extraction`
- `@weaveintel/geneweave-api`
- `@weaveintel/live-agents-demo`
- `@weaveintel/plugins`
- `@weaveintel/react-client`
- `@weaveintel/retrieval`
- `@weaveintel/social-growth`
- `@weaveintel/tools-broker`
- `@weaveintel/tools-dropbox`
- `@weaveintel/tools-filewatch`
- `@weaveintel/tools-gcal`
- `@weaveintel/tools-gdrive`
- `@weaveintel/tools-gmail`
- `@weaveintel/tools-imap`
- `@weaveintel/tools-kaggle`
- `@weaveintel/tools-onedrive`
- `@weaveintel/tools-outlook`
- `@weaveintel/tools-outlook-cal`
- `@weaveintel/tools-slack`
- `@weaveintel/tools-social`
- `@weaveintel/tools-webhook`
- `@weaveintel/voice`
- `@weaveintel/weaveintel`

