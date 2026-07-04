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
| 2f | product modules → apps (batched by UI/server coupling) | `apps/geneweave` (+ `-ui`) | ✅ done |
| 2g | genericize `provenance.ts`, de-brand notes, drop the notes deferral from the no-app-brand allowlist | — | ✅ done |

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

**Batch B ✅ (this step):** moved 4 server-only modules (+ tests) to `apps/geneweave/src/notes/`:
`study` (FSRS/SM-2), `desktop`, `suggestions`, `svg`. **Coupling discovered mid-batch** (the
typecheck gate caught it): `note-doc.ts` (slim core, stays) imports `type PMNode/PMDoc` from
`templates`, and `creative.ts` (UI cluster) imports `type NotesTheme` from `notes-config` — so
`templates` and `notes-config` can't move to the app cleanly yet. **`notes-config` reverted** to notes
(it belongs with the UI cluster in Batch C, since creative depends on it); **`templates` reverted** to
notes pending a small extraction of the generic `PMNode/PMDoc` types into slim-core. Also split the
notes `phase0.test.ts` by concern: suggestion + config tests followed their modules (suggestions test →
app; config test stays with notes-config in notes), agency + note-node tests stay. Rewired consumers:
`note-creative-sql` (svg), `note-study-sql` (study), `me-notes` (desktop's `parseQuickCapture`),
`desktop` (its `templateByKey` now via the notes barrel).

**`templates` → app ✅ (this step):** first extracted the generic `PMNode`/`PMDoc` ProseMirror types out
of `templates.ts` into `note-doc.ts` (slim core) and re-exported them from the barrel — so `note-doc`
(which stays) no longer depends on a product module. Then `git mv`'d `templates.ts` + its 8-test suite to
`apps/geneweave/src/notes/`; `templates` now imports `PMNode/PMDoc` from `@weaveintel/notes`. Rewired 6
consumers (`note-ai-sql`, `me-notes`, `desktop`, migrations `m111`/`m147`, the phase6 test) with
correct relative paths. Gate: 267/267, notes-deferred 73→70.

**`notes-config` → app ✅ (this step):** the DB-backed capability-config schema is **server** code
(`ui≈0`, `srv`-heavy, the biggest brand offender at 13 hits). The only thing tying it to the UI cluster
was `creative → notes-config` for the trivial `NotesTheme = 'pro' | 'creative'` union. **Decoupled** by
inlining `PageTheme = 'pro' | 'creative'` directly in `creative.ts` (dropping the `NotesTheme` import).
Then `git mv`'d `notes-config.ts` + test → `apps/geneweave/src/notes/`, re-headed as app code, removed
the barrel export, rewired 4 consumers (`m104`, `note-settings-sql{,.test}`, `note-creative-sql`). Gate:
267/267; notes-deferred **70→57** (biggest single drop).

**Remaining — the UI cluster → `geneweave-ui`.** A naive "move all 5 together" was attempted and
**reverted** after the build exposed a deeper coupling than the intra-cluster edges: a **slim-core
back-dependency chain** `note-doc.ts (slim, MUST stay) → ink → creative → agency`. `note-doc`'s
`InkBlock` uses `ink`'s `validateStrokes`/`InkStroke` (ink is the note-document *data model*), `ink`
uses `creative`'s `sanitizeColor` (4×), and `creative`/`colorize` use `agency`'s `AGENCY_PALETTE`. So
the cluster can't wholesale leave notes. Verified corrected plan (all 5 modules are DOM-free; only
`note-doc` imports the cluster from slim-core):

1. **`ink` STAYS in slim-notes** — it's the ink data model note-doc needs; a generic freehand-ink
   capability (de-brand its 2 strings in 2g).
2. **Extract `sanitizeColor`** (a ~15-line generic colour-safety gate) out of `creative` into slim
   (e.g. `ink.ts` or a small slim util) + export from the barrel, breaking the `ink→creative` edge.
3. **`geneweave-ui` gains a `@weaveintel/notes` dependency** (+ tsconfig project reference) and a
   **vitest test setup** (it has none today) so the moved cluster tests still run.
4. Move **only `{agency, colorize, creative, diagram}`** (+ tests, + the agency-colour test block from
   notes' `phase0.test.ts`) → `apps/geneweave-ui/src/notes/`; add a `./notes` subpath export.
5. Rewire: the UI's `notes-creative-extensions.ts` splits (ink symbols ← `@weaveintel/notes`; diagram/
   colorize/agency ← `./notes`); server consumers import agency/colorize/creative/diagram from
   `@weaveintel/geneweave-ui/notes`, ink stays from `@weaveintel/notes`. Agency keeps its brand (fine —
   `geneweave-ui` is an app package); the generic-`AgencyContract`-in-notes split is optional per the
   plan and can be skipped since no consumer needs it.

**UI cluster ✅ (executed as 2 commits).** (1) Extracted `sanitizeColor` → slim `color-safety.ts`
(broke `ink→creative`). (2) Gave geneweave-ui a `@weaveintel/notes` dep + tsconfig ref + **vitest** (its
first test setup), moved `{agency, colorize, creative, diagram}` (+ tests + the agency test block) →
`apps/geneweave-ui/src/notes/` with a `./notes` subpath export, and rewired consumers (the UI's
`notes-creative-extensions` split ink↔notes / rest↔`./notes`; server `note-creative-sql`/
`note-colorize-sql`/`me-notes` → `@weaveintel/geneweave-ui/notes`; ink + sanitizeColor stay from
`@weaveintel/notes`). `ink` stays in slim-notes (it's the note-document data model). geneweave-ui's
notes-editor bundler + tsc both build clean. Gate: **268/268** (geneweave-ui gained a test task — 33
cluster tests); notes-deferred **51→37**. **Phase 2f is done — all product modules relocated.**

### 2g — de-brand the slim notes package + drop the deferral ✅

The finish line for the notes split. **Genericized `provenance.ts`**: the AI-image `generator` default
`'geneWeave AI'` → `'weaveintel'` (brand-neutral; a consuming app passes its own product name — the app's
callers already pass `'geneWeave AI'` explicitly, so no behaviour change). **Swept the remaining ~35
brand mentions** (all comments/JSDoc — mostly `weaveNotes Phase N` tags + "geneWeave provides the SQL
adapter"-style phrasing) across the 12 slim modules to neutral wording, via 2 parallel agents. Then
**deleted the `packages/notes/` deferral** from `scripts/no-app-brand-allowlist.json`.

Result: **`check:no-app-brand` PASS with notes fully scanned** — the slim `@weaveintel/notes` is now
100% brand-free (only `clients/tokens/` remains deferred, to Phase 4). Notes retains only its port+doc
surface + the ink data model + the color-safety gate — a clean, generic "structured notes as a
capability" package.

---

## Phase 2 complete ✅

`@weaveintel/notes` went from **32 modules / ~6,600 LOC** (product + framework + brand tangled together)
to a **slim, brand-free port+doc layer**. Five framework concerns reconciled into their canonical homes
(spotlighting→guardrails, translate→prompts, MCP→mcp-server, cron+budget→triggers, RAG→retrieval); all
weaveNotes product modules relocated to the apps (server → `apps/geneweave`, creative/render cluster →
`apps/geneweave-ui`); and the framework is now free of geneWeave/weaveNotes brand (enforced by
`check:no-app-brand`). The Phase 2 gate — every `note-*` test green, slim notes brand-free — is met.

---

## Phase 3 — Merge `coedit` + `collaboration` → `@weaveintel/collab`

Two packages (co-editing CRDT + multiplayer collaboration) become one, with one presence vocabulary,
a `CoeditDoc` port (RGA as the reference adapter), agent-peer against the port, and `note-export` → notes.
**Research-grounded:** awareness/presence is *ephemeral* state (cursors/names/colours, auto-expiring, not
persisted to the CRDT), and Yjs's whole design is a *swappable-adapter* architecture — exactly the
`CoeditDoc` port intent (the port is the product; RGA/Yjs are adapters). Executed as gated sub-steps.

### 3a — the structural merge ✅

Verified pre-merge: **only `index.ts` collides**, **zero exported-symbol collisions**, 17 files import
from both. So a flat merge works. Created `packages/collab` (deps: `@weaveintel/core`); `git mv`'d all
31 modules + 18 test files from both packages into `collab/src`; wrote a combined `index.ts` (co-editing
section + multiplayer section); deleted `packages/coedit` + `packages/collaboration`. Rewired **190
consumer files** with a package-name swap (`@weaveintel/coedit` / `@weaveintel/collaboration` →
`@weaveintel/collab`); deduped the app manifest (it declared both); fixed root + app tsconfig references.

Gate: **collab 252 tests pass** — every RGA convergence + contract test intact (the Phase 3 gate);
app typecheck 62/62; `check:api-boundaries` + `check:workspace-topology` + `check:no-app-brand` all PASS.
(One unrelated `encryption/byok` load-flake, passes isolated.)

### 3b — `note-export` → `@weaveintel/notes` ✅

Multi-format note export (Markdown/HTML/Word/lossless JSON) is note-domain, not CRDT code. `git mv`'d
`note-export.ts` + its 11-test suite into slim-notes; its block-serializer imports (`pmToBlocks`/
`blocksToMarkdown`/`blocksToHtml`) now come from `@weaveintel/collab`, so **notes gains a
`@weaveintel/collab` dependency** (verified acyclic — collab doesn't import notes). Exported from the
notes barrel; rewired 3 app consumers. (A regex mishap briefly removed adjacent collab barrel exports;
recovered from git and verified all coedit exports intact.) Gate: 265/265; note-export.test (11) in notes.

### 3d — unify presence ✅

`AwarenessState` (ephemeral, in-doc cursors) and `PresenceHeartbeat` (durable, session heartbeat) were
two vocabularies for the same "peer + status + colour + cursor" concept, with the status expressed
three ways (`status?: string`, `presence: string`, and a `PresenceState` enum). **Research-grounded**
(collaborative systems use one participant model for both ephemeral cursor awareness and durable
heartbeat presence): created `presence-model.ts` — the ONE vocabulary: `PresenceStatus` (canonical
status union), `PeerKind`, `PeerIdentity`, `isPresenceStatus`/`normalizePresenceStatus`. Both
`AwarenessState.status` and `PresenceHeartbeat.presence` are now `PresenceStatus`; `peerType`/`kind`
are `PeerKind`; `session.ts`'s `PresenceState` collapses to a deprecated **alias** of `PresenceStatus`
(one definition, not a duplicate). The clock/TTL (Awareness) and session/participant/handoff
(PresenceManager/SharedSession) **mechanisms are untouched** — only the words are unified.
Gate: **grep proves exactly one `PresenceStatus` definition, `PresenceState` is an alias, zero
free-string peer-shape definitions**; collab 241 tests pass.

### 3c — the `CoeditDoc` port + `createRgaDoc` reference adapter ✅

**Made the port the product and the RGA an adapter behind it.** New `coedit-doc.ts` defines the
`CoeditDoc` interface — the tiny seam every collaborator talks to: `insert` / `delete` / `applyOps` /
`opsSince` / `stateVector` / `snapshot` / `fork` + `anchor`/`resolve` (awareness). **Research-grounded**
(xi-editor's CRDT engine, Zed's `Buffer`, Yjs's `Doc`, AFFiNE's storage layer all converge on this same
insert/delete/apply/snapshot shape). The hand-rolled zero-dependency RGA ships as the DEFAULT adapter via
`createRgaDoc(siteId, snapshot?)` (and `fromRgaDoc(doc)` to adapt a live replica with no snapshot
round-trip) — its buffering / tombstone / convergence / contract tests are **untouched** (`rga.test.ts`
unchanged). A different engine (Yjs update bytes, OT) is a different adapter behind the same interface.
New `coedit-doc.test.ts` (11 tests): insert/delete, commutative convergence, snapshot round-trip,
opsSince delta sync, fork independence, anchor/resolve cursor stability, + a spy-doc proving the agent
peer touches ONLY the port surface. Gotcha found + fixed: RGA `idAtVisibleIndex` **clamps** past the end
(never returns null), so the port's `delete` bounds its loop by the shrinking visible `length` instead of
relying on a null return.

### 3e — agent-peer against the port ✅

`agent-peer.ts` (`createAgentPeer` — the AI-as-editing-peer, the differentiator) now takes a `CoeditDoc`,
not an `RgaDoc`: it drives `doc.insert` / `doc.length` and, in `suggest` (HITL) mode, `doc.fork()` for the
private shadow — **zero RGA internals** (dropped the `doc.constructor as typeof RgaDoc` + `fromSnapshot` +
`localInsertText` coupling). It survives an engine swap. Call sites rewired to wrap at the boundary:
`coedit-sql.ts` `agentAppend` (`createAgentPeer(fromRgaDoc(doc))`) and the two `awareness.test.ts` agent
tests. `agent-peer` and `coedit-doc` exported from the collab barrel.

Gate: **suite green (collab 252, geneweave-api 2103); all RGA convergence/contract tests pass unchanged;
exactly ONE presence model exports; no-app-brand PASS.**

### 3f — the adapters doc + a real, testable conformance contract ✅

Documented the escape hatch AND made it enforceable. **Research-grounded** in the live Yjs API
([Document Updates](https://docs.yjs.dev/api/document-updates): `encodeStateAsUpdate`/`applyUpdate`/
`encodeStateVector`; [Relative Positions](https://docs.yjs.dev/api/relative-positions) for cursor
anchoring; tombstone-delete semantics). Three deliverables:

1. **`coedit-doc-contract.ts`** (new, exported): `coeditDocContract(make, t)` — the dependency-injected
   conformance suite EVERY `CoeditDoc` adapter must pass (insert/delete, convergence under concurrent
   cross-applied edits, idempotent `applyOps`, snapshot round-trip, `opsSince` delta, fork isolation,
   anchor/resolve cursor stability). Follows the `note-repository-contract.ts` house pattern (no
   test-runner dependency in `src`). This turns "the engine is swappable" from a claim into a
   guarantee. `coedit-doc.test.ts` now runs the RGA reference adapter THROUGH this contract (+ keeps the
   agent-peer-through-port and spy-doc tests).
2. **`packages/collab/docs/adapters.md`** (new): plain-language WHAT/WHY/WHEN, a method-by-method
   RGA↔Yjs map, a complete worked Yjs adapter (`createYjsDoc`) that lives in the ADOPTER's app (we add
   NO Yjs dependency — collab stays zero-dep), and "run the contract to prove it".
3. **`packages/collab/README.md`** (new — the package had none): full adopter-friendly README per the
   restructure doc-quality bar (WHAT one sentence / WHY as a story / WHEN + when-not / HOW runnable
   example), leading with the `CoeditDoc` port + swap-the-engine section, both co-editing and
   multiplayer surfaces tabulated, unified from the two pre-merge READMEs.

Also added one layman "the engine is swappable (a port, not a hard-wire)" callout to the app’s
`docs-html.ts`, tying into its existing "power socket" metaphor.

Gate: **collab 253 green (RGA passes the shared contract; contract exported); geneweave-api build +
typecheck green (docs-html unchanged behaviour); no Yjs dependency added.**

**Phase 3 COMPLETE.** One `@weaveintel/collab` with: a `CoeditDoc` port, the RGA as its zero-dependency
reference adapter, a shared conformance contract, `agent-peer` against the port, one presence model,
`note-export` moved to notes, and the adapters doc.

---

## Phase 4 — Consolidate the micro-packages

Eleven `→` merge groups from the map. Cleaned up two stale build-artifact dirs first (`packages/coedit`,
`packages/collaboration` — untracked `dist`/`node_modules` left over from the 3a delete). Each group is
gated (topology + api-boundaries + affected-package suites green) and committed separately.

### 4a — resilience trio (reliability + durability → resilience) ✅ [flat merge]

`resilience` (live per-call guards) absorbed `reliability` (operational durability: idempotency,
dead-letter, retry budget, health, backpressure) and `durability` (which was only a 20-line re-export
shim of reliability). **Reconciliation:** both packages defined a `createConcurrencyLimiter` with
DIFFERENT signatures — resilience's is a live per-call limiter; reliability's is a policy+queue limiter
with `getStatus()`. No consumer imported reliability's version, so rather than lose it, reliability's
module moved to `durable-concurrency.ts` with `Durable*`-prefixed symbols (`createDurableConcurrencyLimiter`
etc.) — both limiters now coexist. The other five modules moved cleanly (no collision). Rewired 6 source
consumers (`@weaveintel/reliability|durability` → `@weaveintel/resilience`: tools-kaggle, tools-marketdata,
geneweave server + durable-idempotency-store + kaggle/sci-val routes) + 7 package.json deps + 6 consumer
tsconfig references (deduped) + root tsconfig refs (91 → 89) + docs-html.ts (repointed samples, rewrote the
obsolete "canonical import" callout). Gate: topology (87 refs) + api-boundaries green; resilience 58 tests
(incl. absorbed reliability suites) + tools-kaggle/marketdata/notifications/weaveintel green; geneweave-api
build + typecheck green.

### 4b–4j — the mechanical merges ✅

Nine groups, each gated (topology + api-boundaries + affected suites) and committed separately. Pattern:
`git mv` source `src` into `target/src/<sub>` (subpath) or flat; fix moved-file imports (self → relative,
`@weaveintel/target` → relative); add the exports subpath (or fold the barrel, for flat); rewire every
consumer's `.ts` imports + `package.json` dep + `tsconfig` reference (deduped); delete the old package;
prune the root tsconfig reference. Doc-comment package-name references updated for accuracy.

| Sub | Merge | Kind | Notes |
|---|---|---|---|
| 4b | react-client → **client**/react | subpath | React is now an OPTIONAL peer of client; only comments referenced it. client 209 tests. |
| 4c | recipes → **agents**/recipes | subpath | deps (core+agents) became internal. agents 419. |
| 4d | evals → **testing**/evals | subpath | rewired agents (RubricCriterion) + geneweave; no cycle (testing⊅agents). |
| 4e | replay → **observability**/replay | subpath | added observability dep to workflows (source importer). |
| 4f | live-agents-trace-tools → **live-agents**/trace-tools | subpath | the live-agents-runtime ref was a doc comment (no cycle). live-agents 89. |
| 4g | graph → **memory** | flat | knowledge graph is a memory store; folded 5 modules + barrel (only index.ts collided). |
| 4h | redaction + compliance → **guardrails**/{redaction,compliance} | subpath | guardrails absorbed compliance's persistence dep; the core refs were JSDoc. guardrails 326. |
| 4i | oauth + tenancy + scope → **identity**/{oauth,tenancy,scope} | subpath | identity absorbed oauth's persistence dep. identity 148. |
| 4j | models + contracts + plugins + capability-packs + i18n → **core**/{…} | subpath | SUBPATH-ONLY (not in core's main barrel) so moved files' core imports go relative with NO cycle; core stays dependency-free (api-boundaries green). core 259; full framework build+typecheck + package tests (135 tasks each) green. |

Root tsconfig references: 91 → 73. Published package count: 86 → **73**.

### 4k — tokens engine/brand split ✅ [the only NON-merge]

Split `clients/tokens` (which WAS the geneWeave brand, published as `@weaveintel/tokens`) into a
brand-neutral ENGINE + an app-owned BRAND, **research-grounded** in the [W3C Design Tokens spec 2025](https://www.w3.org/community/design-tokens/)
(three-layer model: raw palette → semantic roles → platform CSS; palette is INPUT).

- **Engine (`@weaveintel/tokens`, stays)**: the machinery only — token schema/types, colour maths
  (`contrastRatio`/`meetsAA`), the CSS transform `toCssVariables(theme, { prefix })` with a
  **parameterized prefix** (was hardcoded `--gw-`; default now `wv`), the per-tenant white-label
  functions (`tenantThemeVars`/`tenantThemeCss` now take base themes as INPUT), generic scales, and a
  **neutral reference palette/theme** (slate+blue, AA-verified) so it is self-contained. Fully
  brand-word-clean.
- **Brand (`apps/geneweave-ui/src/brand/geneweave-brand.ts`, new)**: the geneWeave emerald palette,
  Plus Jakarta Sans/Inter/JetBrains Mono/Caveat fonts, assembled `geneweaveThemes`, the `--gw-*` names +
  agency/Pro-Creative/legacy stylesheet assembly — all composed on the engine. Exported via a new
  geneweave-ui `./brand` subpath.
- **Rewired**: the web build script (`gen-tokens-css.mjs`, now esbuild-bundles the brand `.ts`), the API
  app's tenant white-label (`tenant-appearance-sql.ts` → `tenantThemeVars(geneweaveThemes, …, {prefix:'gw'})`,
  importing the brand from `@weaveintel/geneweave-ui/brand`), and `clients/mobile` (engine types from
  tokens; `themes` → the shared brand). `notes` was a false-positive consumer (no real dep).
- **a11y finding**: the plan assumed `a11y` was colour/contrast maths to fold into the engine — but it is
  focus-trap/focus/scroll DOM helpers, and the contrast maths ALREADY lived in tokens' `color.ts`. Folding
  DOM helpers into a zero-dep token engine would be wrong, so `a11y` was LEFT as-is (could merge into
  `ui-primitives` later). The plan's stated rationale is already satisfied.

**Correctness bar met — VISUAL INVARIANCE**: the generated geneWeave CSS (`tokens.generated.ts`) is
**byte-identical** to before the split (only two comment strings differ). Verified end-to-end with a
Playwright screenshot: the live browser reports `--gw-color-accent: #0E9A6E` (emerald), `#F6F8F7` canvas,
Plus Jakarta Sans — the brand is intact. The existing DB-backed tenant Appearance + Builder admin +
`set_workspace_appearance` tool keep working unchanged (engine refactored underneath).

**Ratchet fully closed**: removed the last `no-app-brand` deferral (`clients/tokens/`) — the framework is
now **100% app-brand-clean (0 deferrals, 958 files)**.

Gate: topology (71 refs) + api-boundaries + no-app-brand (0 deferrals) green; tokens 35 + geneweave-ui 40
(incl. new brand test) + geneweave-api 2102 tests green; Playwright visual e2e green.

---

## Phase 4 COMPLETE

Eleven merge groups + the tokens split, all gated and pushed. **Published packages: 86 → 68.** Root
tsconfig references: 91 → 71. The framework is brand-clean with zero de-brand deferrals remaining.
Remaining restructure phases: 5 (tools subpath consolidation), 6 (apps sweep), 7 (docs), 8 (publish —
needs confirmation), 9 (private-repo sync), 10 (final report).

---

## Phase 5 — Tools consolidation ✅

**Research-grounded** in the [webpack tree-shaking guide](https://webpack.js.org/guides/tree-shaking/) +
[npm `exports`/`sideEffects` docs](https://docs.npmjs.com/files/package.json/): nested entry points with
`sideEffects: false` let a bundler drop unused subpaths.

**Merged 20 packages → `@weaveintel/tools` subpaths.** `tool-schema, tools-http, tools-time, tools-search,
tools-{gmail,gcal,gdrive,imap,outlook,outlook-cal,onedrive,dropbox,slack,webhook,filewatch,news,social,
marketdata,altdata,broker}` each `git mv`'d into `packages/tools/src/<sub>/` and exposed as
`@weaveintel/tools/<sub>` via an `exports` map (20 subpaths). `sideEffects: false` set; the ROOT barrel
(registry/policy/net-guard) imports NO integration, so importing the root or one subpath never drags the
others. tools absorbed the `mcp-server`/`mcp-client` deps (used only by integration subpaths) + `testing`
(devDep, test harnesses). Rewired every consumer: `@weaveintel/tools-X` imports → `@weaveintel/tools/X`
(providers ×5 for `/schema`, geneweave for `/http`/`/time`/`/search`, + numbered examples); deps +
tsconfig refs deduped. The routing `adapter_module` seed strings (`@weaveintel/tools/schema/openai` …) are
display metadata resolved by provider, not real imports — kept consistent.

**Tree-shaking trace test** (`tools/src/tree-shaking.test.ts`, esbuild metafile): PROVES
`@weaveintel/tools/gmail` pulls no `marketdata`/`broker`/`slack` code, `/marketdata` pulls no gmail, and the
root stays lean. Exactly the plan's gate item.

**Stay separate** (per plan): `@weaveintel/tools-browser` (Playwright), `@weaveintel/tools-enterprise`.

**Verticals → `examples/verticals/` (unpublished, `private: true`):** `mcp-statsnz` (+ geneweave's thin
`statsnz-mcp-server.ts` wrapper), `equity-scoring`, `social-growth`. Removed from workspaces/root-tsconfig;
they resolve `@weaveintel/*` via root `node_modules` and typecheck cleanly under `tsconfig.examples`
(**0 errors in `examples/verticals/`**).

**FINDING — kaggle deferred to Phase 6:** the plan lists `tools-kaggle` → examples as "zero consumers", but
geneweave has a PRODUCTION Kaggle feature (`features/kaggle-competition/` + `live-agents/kaggle/` wired into
`index.ts`/`tools.ts`, using `tools-kaggle`'s error types + `createKaggleMCPServer`). Cleanly moving it
needs untangling that app feature — Phase 6 (apps sweep) scope. Reverted its move; `tools-kaggle` stays a
package for now.

**test:examples is pre-existing RED (Phase 7 scope):** confirmed `test:examples` was already failing at
HEAD — the numbered examples reach into `../apps/geneweave/src/**` via relative imports, dragging the app
source graph under relaxed settings (~800 type errors), historically masked by a syntax error in
`161-checkpoint-resume.ts` (which I fixed — an unescaped apostrophe). **My delta is clean**: all
`@weaveintel/tools/*` subpaths RESOLVE (zero module-not-found), the residual errors are pre-existing example
API drift, and `examples/verticals/` contributes 0. Making every numbered example typecheck is explicitly
Phase 7 ("the numbered examples must all still typecheck").

Gate: main-repo build+typecheck+test **101 tasks green**; tools **161 tests** (all 20 subpaths + tree-shaking);
topology (48 refs) + api-boundaries + no-app-brand green; tree-shaking trace proven.

**Package count: 68 → 47** (20 merged + 3 relocated; kaggle deferred). Root tsconfig refs 71 → 48.

---

## Phase 6 — Apps fully on the new map ✅

**Sweep:** grepped `apps/**` + `clients/*` for all ~42 retired package names (coedit, collaboration,
reliability, durability, react-client, recipes, evals, replay, live-agents-trace-tools, graph, redaction,
compliance, oauth, tenancy, scope, models, contracts, plugins, capability-packs, i18n, the 20 merged
tools-*, mcp-statsnz, equity-scoring, social-growth) + `@geneweave/tokens` — **app/client SOURCE is 100%
clean** (each merge phase rewired its consumers inline). The only remaining hits are gitignored build
artifacts (`coverage/**`, a stale generated `docs/weaveintel-docs.html`); the docs-html.ts SOURCE emits
zero retired names. `live-agents-demo` deps (core, live-agents, persistence) are all current.

**Kaggle untangle (the Phase-5 deferral resolved):** `tools-kaggle` was consumed only by geneweave's
PRODUCTION Kaggle feature (11 files across `features/kaggle-competition/`, `live-agents/kaggle/`,
migrations, lib) — not "zero consumers". Per the restructure principle *product features live in apps*, the
6-file Kaggle integration moved from `packages/tools-kaggle/src` → **`apps/geneweave/src/kaggle/`**
(app-owned). Rewired all 12 geneweave consumers to relative imports (computed per-file depth) + the 5
numbered kaggle examples; geneweave gained the `@weaveintel/mcp-client` dep the Kaggle code needs; package
deleted; root tsconfig pruned. `@weaveintel/tools-kaggle` now appears NOWHERE.

**Gate:** full-repo **build + typecheck + test = 145 tasks green**; topology (47 refs) + api-boundaries +
no-app-brand green; **the app BOOTS and serves `/docs`** (Playwright, 200 + brand + `@weaveintel/tools`
content) + the login brand token `--gw-color-accent #0E9A6E` live; **admin-ux e2e (8, Builder/tool-sim/
policy-trace) green**; artifacts-chat real-LLM e2e run. Retired-name grep over `apps/**` source returns
nothing.

**Package count: 47 → 46** (kaggle removed from the framework — now app-owned). Root tsconfig refs 48 → 47.
Remaining: Phase 7 (docs — incl. making the numbered examples typecheck), 8 (publish — needs confirm), 9
(private-repo sync), 10 (report).

---

## Phase 7 — Documentation rewrite ✅ (core delivered)

**Research-grounded** in the [Diátaxis framework](https://diataxis.fr/) (separate tutorial / how-to /
reference / explanation), which maps onto the plan's WHAT/WHY/WHEN/HOW + API-reference structure.

**Every published package now has an adopter-friendly README (gate 4).** 43 package/client READMEs
written/rewritten (26 were missing, 17 stale) via 8 parallel authoring agents, each to the exact standard:
one-sentence WHAT, WHY-as-a-story with one everyday analogy, WHEN (+ when-not, naming the alternative), a
runnable HOW example, then API reference — layman-first in the house register (the RGA "two people typing
into the same paragraph" voice). Every export was verified against the real `src/index.ts`; the agents
caught and fixed many stale export names in old READMEs (e.g. `createConsoleTracer`→`weaveConsoleTracer`,
`createChunker`→`weaveChunker`, `createConversationMemory`→the real `weave*` names).

**Root README rewritten:** all retired package names rewired to their new home/subpath; the stale "60+
packages" Package Map replaced with a **"Which package do I need?"** audience decision table (~44 packages,
Start-here → Build-an-agent → Add-tools → Go-multiplayer → Long-lived → Knowledge → Harden → Ship → Test);
`MIGRATION.md` + `ROADMAP.md` links; zero `@geneweave/tokens` (gate 3).

**No roadmap phases in adopter docs (gate 1):** ZERO "Phase N"/roadmap refs across all package + client
READMEs. `docs-html.ts` roadmap labels stripped from delivered-feature callouts (97 → 12, and the 12 are
legitimate workflow-"phase" domain terms + real example filenames); still compiles. **64 source files'**
docstring HEADER titles (`* @weaveintel/… —`) de-phased (design-rationale prose left intact). New
**`ROADMAP.md`** holds the only forward-looking content, so every adopter doc describes the present.

**Gate:** 3 of 4 items fully met — (1) no phase in package READMEs ✅, (3) root README zero
`@geneweave/tokens` ✅, (4) every published package has a what/why/when/how README ✅. (2) docs-html.ts
samples typecheck: samples reference **zero retired package names** (they resolve) and the file compiles,
but a full per-sample extraction harness is not built. Build + typecheck green (96 tasks).

**Examples now typecheck — `npm run test:examples` is GREEN (0 errors, from a pre-existing 822):**
- **Config root-cause fix:** `tsconfig.examples` was dragging the composite geneweave app SOURCE into the
  examples typecheck (523 TS6307 "file not listed" + 43 `strict:false` discriminated-union artifacts — the
  app's own strict build passes them). Fixed by referencing the app as a built project
  (`references: [{path:'apps/geneweave'}]` + `skipLibCheck`) so app imports resolve to `.d.ts` not re-checked source.
- **Retired imports rewired** in 26 example files (redaction→guardrails/redaction, evals→testing/evals,
  tenancy/oauth→identity/*, graph→memory, reliability→resilience, recipes→agents/recipes, collaboration→collab,
  plugins/capability-packs→core/*, replay→observability/replay, openai→provider-openai,
  equity-scoring→examples/verticals, tools-{webhook,filewatch}→tools/*); installed `@anthropic-ai/sdk`+`openai`.
- **216 API-drift errors fixed** across 71 files (8 parallel agents), examples-only: Model/ModelResponse shapes,
  `createMockModel`→`weaveFakeModel`, `finishReason 'tool_use'→'tool_calls'`, ExecutionContext moved to core,
  `createHeartbeat` needs a model, renamed fields, the Anthropic-SDK namespace move.
- **Desktop build fix (install side effect):** the full `npm install` installed the Tauri CLI (a declared
  devDep), so the desktop no-op guard ran `tauri build` → failed on invalid `//` keys in `tauri.conf.json`.
  Gated the native build behind `DESKTOP_NATIVE_BUILD=1` + removed the `//` keys; turbo build green (96 tasks).

**docs-html.ts sample-typecheck harness (gate 2) — BUILT + GREEN.** `npm run test:docs-samples` extracts
every `code('typescript', …)` sample from docs-html.ts via the TS AST and type-checks it against the real
packages ([scripts/extract-docs-samples.mjs](scripts/extract-docs-samples.mjs) + tsconfig.docs-samples.json).
It accommodates illustrative code without inventing types (builder-chain fragments get an `any` receiver,
body snippets are wrapped, placeholder free vars are auto-declared per-file, every sample forced to module
scope), and a parse guard fails loudly on a stray backtick/`${`. It immediately caught genuine bugs that
also broke the DISPLAYED docs (single-escaped `\n`, unescaped apostrophes, a JSON sample mislabeled
`typescript`) and then surfaced **218 real API-drift bugs** in the samples — all fixed against current APIs
(renamed exports w/ changed signatures, removed primitives rewritten to the nearest current equivalent,
`ExecutionContext`/router/eval/retrieval/extraction/sandbox/mcp/guardrails reshapes). GREEN: 0 errors.

**Still deferred (low-risk, non-adopter-facing):** ~193 internal (non-docstring-title) source comments that
narrate design history by phase number.

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

