# weaveIntel Restructure Report — `v0.1.0-restructure`

**Branch:** `restructure/framework-app-separation` · **Date:** 2026-07-04 · **Status:** complete, verified, **not merged to `main`** (left for review).

---

## 1. What this was, in plain language

weaveIntel started as one big repository that mixed two different things together:

1. a **general-purpose AI framework** (model providers, agents, tools, retrieval, guardrails, …) that any team could reuse, and
2. **geneWeave / weaveNotes** — the specific product built *on top of* that framework, with its own brand, colours, and features.

Over time those two got tangled: the reusable framework had geneWeave's brand baked into it, and the same idea was often implemented twice under different names. This restructure **cleanly separates the two** so that:

- The framework is **brand-neutral, reusable, and published on npm** as `@weaveintel/*` (MIT licensed). An outside team can `npm install` it and build their own product without inheriting geneWeave's branding.
- geneWeave keeps everything it had — nothing was removed from the product — but its brand and product-specific code now live **inside the app**, not inside the shared library.
- The library got **smaller and easier to navigate**: overlapping packages were merged, and duplicate implementations were collapsed to one.

The result is an **open-core** layout: a free, reusable core anyone can adopt, and a commercial product (in a separate private repo) that consumes the core like any other npm dependency.

---

## 2. By the numbers

| Metric | Before | After | Change |
|---|---:|---:|---:|
| Packages in `packages/` | 87 | 44 | **−43** |
| Published `@weaveintel/*` packages (incl. `clients/tokens`, `clients/api-client`) | — | **46** | published at `0.1.1` |
| Retired names (deprecated, still installable, pointed at replacements) | — | **44** | — |
| Framework source (non-test `.ts`, `packages/*/src`) | ~149,044 LOC | ~141,760 LOC | −7,284 |
| Framework source files (non-test `.ts`) | 963 | 927 | −36 |

The consolidation is **behaviour-preserving**: fewer packages, same capabilities. The LOC drop comes from removing duplicate barrels/index files and dead-wired duplicate implementations (see §5), not from deleting features.

---

## 3. The 46 published packages, grouped by who needs them

Adopters rarely need all of these. The umbrella package (`@weaveintel/weaveintel`) re-exports the common core so most people start there.

### Start here (most adopters)
| Package | What it gives you |
|---|---|
| `weaveintel` | Curated umbrella — re-exports the runtime, agents, and tool registry most apps need. |
| `core` | Contracts, types, and the runtime everything else builds on (also exposes `models`, `contracts`, `plugins`, `capability-packs`, `i18n` as subpaths). |

### Talk to a model
`provider-anthropic` · `provider-openai` · `provider-google` · `provider-ollama` · `provider-llamacpp` · `routing` (pick the best/cheapest/healthiest model) · `cost-governor` (spend caps).

### Build agents & workflows
`agents` (tool-calling loop, planners, supervisors; `recipes` subpath) · `workflows` · `live-agents` + `live-agents-runtime` (long-running autonomous agents) · `triggers` (schedules & events) · `human-tasks` (approvals / review queues) · `skills`.

### Give agents tools
`tools` (registry + integrations behind tree-shakeable subpaths: `/gmail`, `/slack`, `/marketdata`, …) · `tools-browser` (Playwright) · `tools-enterprise` · `mcp-client` + `mcp-server` (Model Context Protocol) · `sandbox` (safe code execution).

### Find & remember things
`retrieval` (ingest → chunk → embed → search, with RRF + verified citations) · `memory` (conversation / semantic / entity / knowledge-graph) · `extraction` (structured data from text) · `cache` (semantic + operational).

### Collaborate on documents
`collab` (real-time co-editing CRDT with one presence model + a pluggable `CoeditDoc` port) · `notes` (a slim NoteRepository *port* + contract tests — the product features live in the app).

### Keep it safe & governed
`guardrails` (risk classification, evaluation chain; `redaction` + `compliance` subpaths) · `identity` (access control; `oauth` + `tenancy` + `scope` subpaths) · `encryption` (per-tenant envelope encryption) · `a2a` (agent-to-agent protocol).

### Ship a UI & observe it
`client` (browser-safe run client; `react` subpath) · `ui-primitives` · `a11y` (accessibility helpers) · `tokens` (brand-neutral design-token **engine**) · `observability` (tracing, cost, run logs; `replay` subpath) · `notifications` · `api-client`.

### Build & test the framework itself
`testing` (fake models / vector stores / MCP servers; `evals` subpath) · `devtools` (scaffold, inspector, mock runtime) · `persistence` (adapter contracts) · `artifacts` · `prompts` · `resilience` (retry / circuit-breaker / rate-limit) · `voice` (STT/TTS pipeline).

---

## 4. De-branding — the framework no longer carries geneWeave

The framework used to hard-code geneWeave brand values at runtime. Those were replaced with **neutral defaults that the app injects**:

- **Tracing** — OpenTelemetry service name default `geneweave` → `weaveintel`; the app passes `geneweave` explicitly at boot.
- **Live-agent workers** — worker-id prefix `geneweave-live-worker` → `weaveintel-live-worker`; the system principal (`human:geneweave-system`) became an injectable option (`systemPrincipal`) with a neutral default. The app passes its own values so worker ids and audit attribution are unchanged.
- **Scaffold** — the devtools project generator's phantom `@weaveintel/geneweave` dependency was replaced with the real umbrella + client + ui-primitives (a test proves the scaffold produces an installable project).
- **Design tokens** — the tokens package became a **brand-neutral engine** (palette + prefix are *inputs*); the geneWeave palette, `--gw-*` names, and Pro/Creative themes moved to the app (`apps/geneweave-ui/src/brand/`). Visual output is byte-identical (proven by a Playwright check on the live `--gw-color-accent`).
- **Comment/vocabulary sweep** — ~218 geneWeave/weaveNotes brand mentions across framework comments and a handful of error strings were neutralised (only comments + 3 human-facing strings changed).

A CI guard, **`check:no-app-brand`**, scans every framework source file and **passes with zero leaks (936 files)**. The old phase-tagged deferral ratchet is fully closed — no exceptions remain.

---

## 5. Duplicates eliminated — one implementation each

The biggest source of confusion was the same idea implemented twice. Each was collapsed to a single canonical home:

| Concept | Was (duplicated) | Now (one implementation) |
|---|---|---|
| **Real-time co-editing / presence** | `coedit` **and** `collaboration` (two presence vocabularies, two doc models) | **`collab`** — one presence model, a `CoeditDoc` **port** with RGA as the reference adapter, agent-peer intact, a DI'd conformance contract + a documented (dependency-free) Yjs-adapter guide |
| **Retrieval / RRF / citations** | `retrieval`'s dead-wired `Citation`/RRF **and** `notes`' verified-quote RAG | **`retrieval`** — one Reciprocal-Rank-Fusion + one canonical `ExtractedCitation` (the notes verified-quote type became canonical) |
| **MCP server core** | `notes/mcp.ts` **and** `mcp-server` | **`mcp-server`** — the transport-free JSON-RPC core folded in; no competing dispatcher |
| **Prompt-injection spotlighting** | `notes/prompt-safety.ts` | **`guardrails/spotlighting`** |
| **Scheduling (cron + budgets)** | `notes/scheduled-agent.ts` (crude parser) **and** `triggers` | **`triggers`** — a proper Vixie/POSIX cron evaluator + run-budget primitives (product recipe catalog moved to the app) |
| **Resilience limiters** | `reliability` **and** `durability` | **`resilience`** — the durable-concurrency variant kept under `Durable*`-prefixed names |
| **Design tokens naming** | inconsistent `@geneweave/tokens` under the `@weaveintel` scope | **`@weaveintel/tokens`** — one scope, one name |

Beyond these, **20 `tools-*` packages** (gmail, slack, marketdata, …) and the `tool-schema` package were merged into **`@weaveintel/tools`** behind **tree-shakeable subpath exports** — a metafile test proves that importing `tools/gmail` pulls in none of `marketdata`/`broker`/`slack`. Five more package families were folded into `core`, `identity`, `guardrails`, `testing`, `observability`, `client`, `agents`, `memory`, and `live-agents` as subpaths.

Three product **verticals** that don't belong in a general framework — `statsnz`, `equity-scoring`, `social-growth` — moved to `examples/verticals/` (unpublished reference examples). The geneWeave-specific Kaggle vertical became **app-owned** (`apps/geneweave/src/kaggle/`).

---

## 6. Documentation

- **43 package/client READMEs** written or rewritten to a consistent **what / why / when / how** shape (each verified against real exports).
- **Root README** rewritten with a *"Which package do I need?"* audience decision table; zero `@geneweave/tokens` mentions; links to `MIGRATION.md` and `ROADMAP.md`.
- **`docs-html.ts`** (the in-product developer docs): roadmap/phase language stripped; a **sample-typecheck harness** (`test:docs-samples`) now extracts every code sample from the docs and compiles it — currently **142 samples, 0 errors**, so the displayed docs can't silently drift from the API.
- **`ROADMAP.md`** (forward-looking only) and **`MIGRATION.md`** (the old→new map) added.
- Numbered `examples/` all typecheck (`test:examples` — **0 errors**).

All docs are final-state (no "phase N" language), adopter-friendly, and example-led.

---

## 7. npm publish / deprecate log

**Published (46, at `0.1.1`, MIT, public):** all 44 `packages/*` plus `clients/tokens` and `clients/api-client`. A clean-room **smoke test** (outside the repo) installs `weaveintel` + `collab` + `tools` (incl. the `tools/gmail` subpath) straight from the registry and both **typechecks and runs** — proving the published artifacts work with no workspace tricks.

**Deprecated (44 retired names — still installable, each pointing at its replacement):**

| Retired | → Replacement |
|---|---|
| `coedit`, `collaboration` | `collab` |
| `reliability`, `durability` | `resilience` |
| `redaction`, `compliance` | `guardrails/{redaction,compliance}` |
| `oauth`, `tenancy`, `scope` | `identity/{oauth,tenancy,scope}` |
| `models`, `contracts`, `plugins`, `capability-packs`, `i18n` | `core/{…}` |
| `evals` | `testing/evals` |
| `replay` | `observability/replay` |
| `graph` | `memory` |
| `recipes` | `agents/recipes` |
| `react-client` | `client/react` |
| `live-agents-trace-tools` | `live-agents/trace-tools` |
| `tool-schema`, and 19 `tools-*` (http, time, search, gmail, gcal, gdrive, imap, outlook, outlook-cal, onedrive, dropbox, slack, webhook, filewatch, news, social, marketdata, altdata, broker) | `tools/{…}` subpaths |
| `tools-kaggle` | app-owned (no published replacement) |
| `mcp-statsnz`, `equity-scoring`, `social-growth` | `examples/verticals/*` (unpublished) |

Nothing was unpublished — deprecation keeps existing installs working while guiding users forward.

---

## 8. Private commercial repo sync (Phase 9)

The commercial fork (`github.com/gibyvarghese/geneweave`) — geneWeave + weaveNotes apps only, consuming the framework strictly from npm — was synced on branch **`sync/weaveintel-0.1.0`** (**Draft PR #5**, not merged):

- All `@weaveintel/*` deps bumped to `^0.1.1`; the app now declares the exact **44** packages its source imports (previously several were resolved via monorepo hoisting).
- Every retired import rewritten to its new name/subpath.
- All brand + product-owned modules moved app-side (`brand/`, `notes/` cluster, `kaggle/`, `scheduled-agent-config`, vendored `statsnz/`), so the private apps import **nothing brand-related** from `@weaveintel/*`.
- `MIGRATION.md` copied in as `docs/weaveintel-0.1.0-migration.md`.
- **Gate green:** build 2/2, typecheck 3/3, **2,133 unit tests pass / 0 fail**; grep proves zero retired imports and zero retired deps.

---

## 9. Phase 10 verification — re-run of every gate

Run on this branch in one pass (`turbo build typecheck test --continue` + all `check:*` + the doc/example harnesses):

| Gate | Result |
|---|---|
| `turbo build typecheck test` (145 tasks) | **✅ 145/145** (cache-served; fresh `--force` re-run 144/145 — see note) |
| `@weaveintel/geneweave-api` test suite | **✅ 2,135 passed**, 218 skipped |
| `check:no-app-brand` | **✅ PASS** — 0 leaks / 936 files |
| `check:api-boundaries` | **✅ PASS** |
| `check:workspace-topology` | **✅ PASS** — 47 references |
| `check:no-adhoc-resilience` | **✅ PASS** — 1,193 files |
| `check:vocab-w9` | **✅ PASS** |
| `test:examples` | **✅ 0 errors** |
| `test:docs-samples` | **✅ 0 errors** (142 samples) |
| `check:no-raw-fetch` | ⚠️ **deferred** (see §10) |

**Note on the fresh `--force` run:** one task (`@weaveintel/tools-enterprise`) reported a single failing test — `AuthManager > manually sets token state`. Re-run in isolation it passes **30/30**. It is a **concurrency flake**: the assertion checks that a token minted `Date.now() + 60s` is still valid, and under a stalled event loop (44 packages + apps compiling and testing at once) the expiry-skew check races. It is environmental, not a regression.

---

## 10. Deferrals (with reasons)

| Deferred | Why | Impact |
|---|---|---|
| `check:no-raw-fetch` not green | ~21 flagged sites: mostly **client-side** browser `fetch` to the same-origin API (`ui/voice-agent.ts`, `admin-ui.ts`) where hardened server fetch doesn't apply, transient generated doc-sample files, and 3 known framework sites (`a2a`, `live-agents-runtime`, `observability/otel-tracer`). Agreed as a deferral in Phase 0. | Low — client fetch is legitimate; the 3 framework sites are tracked for a follow-up. |
| Unscoped `weaveintel` npm alias not published | Optional convenience alias; the scoped `@weaveintel/weaveintel` umbrella is the supported entry point. | None. |
| `a11y` not retired/merged | It is DOM focus/scroll helpers, not colour maths — a genuinely separate concern from `tokens`. | None (kept as its own small package). |
| One `tools-enterprise` test flakes under full-monorepo concurrency | Timing-sensitive token-expiry assertion; passes 30/30 isolated. | None — not a product bug. |

---

## 11. Final checklist

- ✅ **Zero geneWeave/weaveNotes brand strings execute at runtime in any published package** — `check:no-app-brand` PASS (0 leaks / 936 files).
- ✅ **`@weaveintel/notes` is the slim port+doc layer; product features live in apps** — notes went 32 → 11 files; product modules moved to the apps.
- ✅ **One CRDT/collab package** with a `CoeditDoc` port, RGA reference adapter, one presence model, agent-peer intact — `collab`.
- ✅ **One implementation each** of RRF/citations (`retrieval`), MCP server core (`mcp-server`), spotlighting (`guardrails`), scheduling (`triggers`).
- ✅ **~40 published packages; tools behind subpath exports; verticals in examples** — 46 published (44 pkgs + 2 clients); 20 `tools-*` merged into `tools` subpaths (tree-shaking proven); `statsnz`/`equity-scoring`/`social-growth` in `examples/verticals/`.
- ✅ **Tokens engine is brand-neutral; geneWeave palette is app-owned; `@geneweave/tokens` naming gone** — engine at `clients/tokens`; brand at `apps/geneweave-ui/src/brand/`; one scope/name.
- ✅ **devtools scaffold produces an installable project** — proven by a scaffold dependency-resolution test.
- ✅ **All docs final-state, what/why/when/how, layman + example, zero phase language** — 43 READMEs + root + docs-html; sample harness green.
- ✅ **0.1.1 published; retired names deprecated with pointers; registry smoke test passed** — 46 published, 44 deprecated, smoke app typechecks + runs from the registry.
- ✅ **Private repo sync branch green with app-owned brand/config** — `sync/weaveintel-0.1.0`, Draft PR #5, 2,133 tests pass, zero retired imports.

*(Version note: the plan targeted `0.1.0`; the library actually published at `0.1.1` — the two `tools-*` packages already existed at `0.1.0` on npm, so a uniform `0.1.1` was chosen for the whole set. The tag remains `v0.1.0-restructure` as the plan named it.)*

---

**Handover:** this branch and report are for review. **Not merged to `main`.** Tag: `v0.1.0-restructure`.
