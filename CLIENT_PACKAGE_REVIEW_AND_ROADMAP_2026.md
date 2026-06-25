# @weaveintel/client — Review, Gap Analysis & Phased Roadmap (Mid‑2026)

**Scope:** Review the whole `packages/client` (browser run‑client: SSE transport, stream reducer, run client, offline outbox), map how geneweave and the other clients consume it, benchmark it against the mid‑2026 state of the art for streaming LLM/agent client SDKs, and lay out a phased plan to close the gaps by **extending existing weaveIntel packages and moving run/stream configuration into the database** — not duplicating.

**Guiding principle:** Everything below is designed to *extend* what already exists (`@weaveintel/core` event contracts, `@weaveintel/ui-primitives` builders, `@weaveintel/artifacts` streaming, `@weaveintel/collaboration` run journal/registry, the geneweave `/api/me/runs` surface). Where geneweave consumes a capability, its config and data should live in DB tables.

---

## 1. What `packages/client` is today

A browser‑safe (no Node imports) run client. ~1,030 LOC across 5 modules:

| Module | Responsibility | Key exports |
|---|---|---|
| `transport.ts` | SSE over `fetch`+`ReadableStream`; JSON `get/post/del`; mock transport. Auth provider, `Idempotency-Key` header. | `sseTransport`, `fetchJsonTransport`, `mockSseTransport` |
| `reducer.ts` | **Pure** reducer: folds `RunEventEnvelope[]` → `RunViewModel`. Idempotent on sequence. | `streamReducer`, `emptyRunViewModel` |
| `run-client.ts` | `startRun / getRun / listRuns / cancelRun / attach(resume) / postEvent`. Exp. backoff array. | `createRunClient` |
| `outbox.ts` | Offline buffer of `StartRunInput`; injectable storage; idempotency keys; attempts counter. | `createRunOutbox`, `MemoryStorage` |
| `index.ts` | Public surface. | — |

**Reducer view model** (`reducer.ts:59`): `sequence, status, fullText, textChunks[], widgets:Map, toolCalls[], lastError, items[]`.

**Event kinds the reducer handles** (`reducer.ts:124`): `run.started`, `run.completed`, `run.failed`, `run.cancelled`, `text.delta`, `widget.update`, `tool.invoked`, `tool.completed`, `tool.errored` — **9 kinds.**

---

## 2. How it is used (and where it is bypassed)

```
@weaveintel/core (run + event contracts)
        │
@weaveintel/client  ──consumed by──►  clients/api-client  ──►  clients/mobile (React Native)
        │                                   (wraps + reimplements transport)
        │                              examples/139-detachable-run.ts
        │
geneweave (apps/geneweave)  ── PRODUCES run events; does NOT import the client
        ├─ routes/me.ts            (/api/me/runs surface — the server contract)
        ├─ me-run-executor.ts      (journal append, SSE fan-out, gap-free sequence)
        ├─ me-run-agent.ts         (chat→run bridge — the lossy seam)
        └─ apps/geneweave-ui       (web SPA — hand-rolls its OWN SSE against /api/chats)
```

**Key facts (file:line):**

- **Server API is solid.** All six endpoints in `apps/geneweave/src/routes/me.ts` are fully implemented: start (`:89`, idempotency `:94`), list (`:153`), get (`:167`), cancel (`:244`), **SSE attach with `?after=seq` replay + 15s keepalive** (`:176`–`:223`), postEvent (`:227`). The executor (`me-run-executor.ts`) guarantees gap‑free monotonic sequence via an append lock (`:234`) and idempotent terminal events (`:237`).
- **`api-client` does NOT extend the base client — it reimplements it.** `clients/api-client/src/client.ts:293` (`createGeneweaveClient`) reuses only `streamReducer`, `emptyRunViewModel`, `createRunOutbox` + types, then rebuilds attach/transport (`client.ts:468`, `http.ts:132`) because the base transport has no close/error seam. It adds the *working* reconnect, a 60s stall timeout, Zod validation, auth refresh, typed errors. **This is duplication forced by base‑client gaps.**
- **`apps/geneweave-ui/src/ui-client.ts` is a THIRD SSE implementation.** The web SPA ignores `@weaveintel/client`, `api-client`, the reducer, and the `/api/me/runs` surface entirely — it POSTs to `/api/chats/:id/messages` (`ui-client.ts:200`) and hand‑rolls its own SSE parser (`:320`) against a *fourth* frame vocabulary. Clear duplication; the run/reducer abstraction is bypassed by the primary web surface.

---

## 3. Database inventory (run / stream system)

| Table | Migration | Purpose | Seeded |
|---|---|---|---|
| `user_runs` | m41 | Run row: `id, user_id, tenant_id, status, surface, metadata, created_at, updated_at`. **No `input` column** (input is ephemeral). | No |
| `user_run_events` | m41 | **The journal.** `id, run_id, sequence, kind, payload, created_at`; `UNIQUE(run_id, sequence)`. Powers `?after=seq` resume. **No TTL/pruning.** | No |
| `idempotency_records` | m01–m10 | Server‑side dedup of `Idempotency-Key`. | No |
| `artifacts` | m77 | Has nullable `run_id` + `idx_artifacts_run`. Already run‑aware. | No |
| `live_runs` / `live_run_events` / `api_live_runs` | m19–m22, m59 | Legacy mesh/live‑agent runs (separate lineage). | No |

**No server‑side outbox table** (outbox is client‑side: `MemoryStorage`, and `clients/mobile/.../expo-sqlite-outbox.ts` device‑local). **No run/stream CONFIG table.** The following are **hardcoded constants that should be DB‑backed** (the user's explicit goal — config in DB wherever geneweave uses it):

| Constant | Location | Value |
|---|---|---|
| Reconnect backoff | `packages/client/src/run-client.ts:161` | `[250,500,1000,2000,4000,8000,16000,30000]` |
| Max reconnects | `run-client.ts:69` | `8` |
| SSE keepalive interval | `apps/geneweave/src/routes/me.ts:218` | 15s |
| Stall timeout | `clients/api-client/src/http.ts:168` | 60s |
| Journal retention / cap | `packages/collaboration/src/run-journal.ts` | 24h / 2000 events (and `user_run_events` has *none*) |
| Terminal kinds / emitter taxonomy | `me-run-executor.ts:45,60` | hardcoded set of 9 |

---

## 4. The capability the chat pipeline produces vs. what survives to the client

The production agent (`createChatPipelineMeRunAgent`, `me-run-agent.ts:152`) runs the full web ChatEngine and parses its SSE frames in `SseCaptureResponse` (`me-run-agent.ts:270`). **The chat pipeline emits ~16 frame types; the bridge maps only 5:**

| Chat frame (server) | Bridged to run event? | Lands in reducer? |
|---|---|---|
| `text` | → `text.delta` | ✅ |
| `reasoning` | → `text.delta` `role:'reasoning'` (**folded into text**) | ⚠️ no distinct kind |
| `tool_start` | → `tool.invoked` | ✅ |
| `tool_end` | → `tool.completed` | ✅ |
| `error` | re‑thrown → `run.failed` | ✅ |
| `step` (plan/steps) | dropped (`me-run-agent.ts:299`) | ❌ |
| `done` (**usage, cost, latency, model, steps[], artifactRefs[], cognitive, contracts, ensemble**) | **dropped entirely** | ❌ |
| `guardrail`, `redaction`, `cognitive`, `contracts`, `policy_checks`, `eval`, `ensemble_result`, `screenshot`, `generation` | dropped | ❌ |
| tool **error** | no `tool_error` frame exists; `tool.errored` reducer branch is **never fed** | ❌ |
| `widget.update` | **never emitted** by the chat path → reducer branch is dead | ❌ |

> The reducer's kind table matches the executor's *emitter* exactly — so the loss is **not** at the reducer boundary; it is in the **chat→run bridge** and the **emitter taxonomy** being too small. The richest payload (`done`) is thrown away.

---

## 5. Mid‑2026 state of the art (the benchmark bar)

The reference category is browser/agent streaming SDKs: **Vercel AI SDK v5 (Jul 2025) / v6 beta**, **assistant‑ui**, **CopilotKit + AG‑UI protocol** (May 2025), **LangGraph SDK/Platform**, **OpenAI Agents SDK / AgentKit / ChatKit** (DevDay Oct 2025). Distilled capability bar:

**Table stakes (mid‑2026):**
1. SSE transport (fetch+ReadableStream, POST + headers) with manual reconnect. ✅ *we have*
2. **Typed `parts[]` message model** (text, reasoning, tool‑`<name>`, file, source‑url/source‑document, data‑`<name>`, step‑start) — the 2025 shift from `content:string`.
3. **Per‑part streaming states** — tool: `input-streaming → input-available → output-available → output-error`; text/reasoning: `streaming → done`.
4. **Streaming partial tool input args** (default‑on in v5) + per‑state tool UI.
5. **Reasoning as a distinct streamed part** (never folded into text) + provider metadata/signature passthrough (Anthropic signature; OpenAI reasoning summaries/encrypted).
6. **Client‑side tool execution + `addToolResult`** equivalent.
7. **Status enum** `submitted/streaming/ready/error`, `stop`, `regenerate`, edit‑and‑resubmit.
8. **Attachments → file parts** (multimodal round‑trip).
9. **Sources / citations parts** (`source-url`, `source-document`).
10. **Streaming usage / cost / finishReason / step metadata** via message metadata.
11. **Smooth streaming** (`smoothStream`) + **client throttle** (`experimental_throttle`).
12. **Structured / partial object streaming** (`streamObject` / `useObject`, partial‑JSON).

**Advanced / differentiating (2025–2026 frontier):**
- **Resumable / attach‑to‑in‑progress streams** — `consumeStream` + Redis `resumable-stream`, `useChat({ resume:true })`, LangGraph `joinStream`, OpenAI `background+starting_after`. Keys off stream identity + cursor, **not** SSE `Last-Event-ID`.
- **Human‑in‑the‑loop tool approval** as a first‑class state (`needsApproval`/`requires-action`, `addToolApprovalResponse`).
- **Generative UI / typed widgets** streamed from server (ChatKit widgets, CopilotKit `render`, LangGraph `push_ui_message`).
- **Bidirectional shared agent state** (AG‑UI `STATE_DELTA` JSON‑Patch; predictive state).
- **Message branching + optimistic updates** as explicit APIs (LangGraph `optimisticValues`).
- **Pure, exported stream reducer** — ours is arguably *ahead*; Vercel's internal reducer is unexported and mutates in place.
- **Offline outbox / compose‑offline → replay‑on‑reconnect** — **no major SDK ships this; our clearest differentiator.**

_Sources: ai-sdk.dev (stream-protocol, ui-message, chatbot-tool-usage, chatbot-resume-streams, transport, smooth-stream, object-generation), vercel.com/blog/ai-sdk-5 & /ai-sdk-6, github.com/vercel/resumable-stream, docs.ag-ui.com, docs.copilotkit.ai, docs.langchain.com/langgraph-platform/streaming & /double-texting, openai.github.io/openai-agents-js/guides/streaming, developers.openai.com/api (responses/streaming, reasoning, background), developer.mozilla.org (Server-sent_events, Background_Synchronization_API), upstash.com/blog/resumable-llm-streams._

---

## 6. Gap matrix — capability × status × where it already lives in weaveIntel

Status: ✅ have · 🟡 partial · 🟥 stub/dead · ⛔ missing. "Reuse" = extend this, don't duplicate.

| # | Capability | Status | Evidence | Reuse (extend, don't duplicate) |
|---|---|---|---|---|
| G1 | Auto‑reconnect / resume in base client | 🟥 **dead code** | `run-client.ts:205` `void scheduleReconnect`; transport has no close seam | Promote `api-client`'s working loop (`http.ts:132`, `client.ts:468`) into base `transport.ts`/`run-client.ts` |
| G2 | Lossless chat→run bridge | 🟡 5/16 frames | `me-run-agent.ts:270` | Extend `MeRunEmitter` (`me-run-executor.ts:60`) + bridge |
| G3 | Reducer aligned to core event taxonomy | 🟡 9 kinds, custom envelope | `reducer.ts` vs `core/src/ui-events.ts:7` `UiEventType` (10 kinds) | Adopt `StreamEnvelope`/`UiEventType` from `@weaveintel/core` |
| G4 | Typed `parts[]` + per‑part streaming states | ⛔ flat view model | `reducer.ts:59` | Build on `core` payload types |
| G5 | Reasoning as a distinct part + signatures | 🟡 folded into text | `me-run-agent.ts:276` | `provider-anthropic/src/anthropic-thinking.ts:22` (thinking blocks/signatures) |
| G6 | Generative UI / typed widgets end‑to‑end | 🟥 reducer branch dead, never emitted | `reducer.ts:171` never fed | `core/ui-events.ts:87` `WidgetPayload` (8 types+fallback+schemaVersion) + `ui-primitives/src/widgets.ts` builders |
| G7 | Citations / sources | ⛔ | no kind | `core/ui-events.ts:63` `CitationPayload` + `ui-primitives/src/citations.ts`; provider citations |
| G8 | Artifact streaming lifecycle | ⛔ in client; ✅ engine | `done.artifactRefs` dropped | `packages/artifacts/src/streaming.ts:26` `ArtifactStreamEvent/Handle`; `artifacts.run_id` already exists |
| G9 | Human‑in‑the‑loop approval | ⛔ in client; primitive exists | `postEvent` (`run-client.ts:213`) is the resume channel | `core/ui-events.ts:47` `ApprovalUiPayload` + `ui-primitives/src/approval.ts` |
| G10 | Usage / cost / finishReason streaming | ⛔ | `done.usage/cost` dropped | `core` usage types; mirror `packages/cache` metrics pattern |
| G11 | Agent step / plan events | ⛔ in client; ✅ engine | `step` frames dropped | `core/src/agents.ts:87` `AgentStepEvent`; `ui-primitives` `stepUpdateEvent` |
| G12 | Status enum / stop / regenerate / edit / branch | 🟡 only `cancelRun` | `run-client.ts:147` | Extend `run-client` + new hooks package |
| G13 | React hooks (`useRun`/`useChat`) | ⛔ no package | — | **New** `@weaveintel/react-client` *extending* `@weaveintel/client` (not a fork) |
| G14 | Web UI on the shared client | 🟥 hand‑rolled | `apps/geneweave-ui/src/ui-client.ts:200` | Converge onto `@weaveintel/client` reducer/transport |
| G15 | Attachments / multimodal round‑trip | 🟡 input only | — | `core` file/attachment types |
| G16 | Resumable streams (refresh‑proof) + config | 🟡 server ok, client dead | `me.ts:176` works; `run-client.ts:205` dead | `collaboration/src/run-journal.ts` (retention) + `@weaveintel/cache` Redis for a resumable context |
| G17 | Outbox v2 (mid‑stream, backoff, dead‑letter, online listeners) | 🟡 run‑start only | `outbox.ts:104` | Extend existing `createRunOutbox` |
| G18 | Run/stream config + taxonomy in DB | ⛔ all hardcoded | §3 | **New** `run_stream_config` table (+ optional registry) |
| G19 | Structured / partial object streaming | ⛔ | — | provider structured‑output; new reducer part |
| G20 | Smooth streaming + client throttle | ⛔ | — | reducer/transport option |

**Differentiator to protect:** the **pure reducer** (G‑pure) and the **offline outbox** (G17) are ahead of the market — extend, don't regress.

---

## 7. Proposed database additions (config & data in DB where geneweave uses it)

> Aligns with the existing single‑row config‑table pattern used by `semantic_cache_config` (m86) etc. New migrations continue the `mNN` sequence.

**7.1 `run_stream_config` (single row) — REQUIRED.** Replaces every hardcoded constant in §3.

| Column | Default | Drives |
|---|---|---|
| `heartbeat_ms` | 15000 | `me.ts` keepalive |
| `max_reconnects` | 8 | client `attach` |
| `backoff_ms_json` | `[250,500,1000,2000,4000,8000,16000,30000]` | client backoff |
| `stall_timeout_ms` | 60000 | transport stall teardown |
| `journal_retention_hours` | 24 | journal pruning |
| `journal_max_events` | 2000 | per‑run cap |
| `throttle_ms` | 50 | client UI throttle |
| `smooth_stream` / `smooth_chunking` | 0 / `word` | smoothing |
| `resume_window_seconds` | 900 | refresh‑proof resume |
| `surfaces_json` | `["web","mobile","copilot"]` | allowed surfaces / flags |

Served to clients via a small `GET /api/me/runs/config` (or embedded in the start‑run response), cached ~60s, admin‑editable via the existing admin schema/routes pattern (mirror `admin/routes/routing.ts` + `admin/schema/platform-capability-tabs.ts`).

**7.2 `run_event_kinds` (registry) — OPTIONAL/reference.** Seeds the canonical taxonomy + `schema_version` so server emitter and client reducer share one source of truth and it's introspectable. Marginal benefit; include only if taxonomy churn is expected.

**7.3 `run_approvals` (Phase 4) — REQUIRED for HITL.** `id, run_id, sequence, status('pending'|'approved'|'denied'), payload_json, requested_at, responded_at, responder_id`. Lets a paused run survive restarts and be queried.

**7.4 `user_runs.input_json` column — RECOMMENDED.** Persist the durable run input (currently only cached in `idempotency_records.result_json`) so runs are replayable/debuggable and resume can re‑drive.

**7.5 `user_run_events` retention — REQUIRED.** Add a pruning job keyed on `run_stream_config.journal_retention_hours/journal_max_events` (table currently grows unbounded).

**7.6 Outbox stays client‑side**, but add an optional `run_dead_letter` table (server) for runs that fail terminally after max attempts, for ops visibility.

---

## 8. Phased roadmap

Each phase is independently shippable, extends existing code, and ends with acceptance criteria. Phases 0–1 are the highest‑leverage (unblock everything + stop the data loss).

### Phase 0 — Contracts + reconnect + config (foundation)
**Goal:** one event contract, a working reconnect, config out of code.
- Adopt `@weaveintel/core` `StreamEnvelope`/`UiEventType` as the canonical wire/contract; make `reducer.ts` `RunEventEnvelope` a typed alias (back‑compat shim). Export a shared kind registry from `core`.
- **Fix G1:** add `onOpen/onClose/onError` to `transport.ts`; wire `run-client.attach()` reconnect for real (delete the `void` dead code); then **refactor `api-client` to extend the base** instead of reimplementing the transport.
- **DB:** add `run_stream_config` (7.1) + admin CRUD; wire `me.ts` heartbeat, journal retention, and client backoff/throttle from it. Add `user_run_events` pruning (7.5).
- **Acceptance:** api‑client no longer ships its own transport; base client reconnects + resumes from cursor in a unit test; changing `heartbeat_ms`/`backoff` in DB changes runtime behavior; journal prunes.

### Phase 1 — Lossless chat→run bridge + reducer parity
**Goal:** stop dropping 11/16 frames; reconstruct full run state from the journal.
- Extend `MeRunEmitter` (`me-run-executor.ts:60`) with: `reasoning`, `usage`, `step`, `citation`, `artifact`, `diagnostic` (guardrail/policy/eval) and a real `tool.errored` path.
- Extend `SseCaptureResponse` (`me-run-agent.ts:270`) to map every chat frame, **including the `done` payload** (usage, cost, latency, model, steps[], artifactRefs[]).
- Extend `reducer.ts` + `RunViewModel`: add `reasoning[]`, `usage`, `citations[]`, `artifacts[]`, `steps[]`; handle `progress/approval/citation/artifact/step-update` kinds (align to `core` `UiEventType`).
- **Acceptance:** replaying `/api/me/runs/:id/events` for a chat run reconstructs usage/cost, reasoning (distinct), steps, and artifact refs in the view model; golden‑file test over a recorded chat stream.

### Phase 2 — Typed `parts[]` + per‑part streaming states
**Goal:** modern message model.
- Add an ordered `parts[]` to `RunViewModel` (text/reasoning/tool/file/source/data/step/widget) with a per‑part state machine; tool parts: `input-streaming → input-available → output-available → output-error`. Add `tool.input.delta` (partial args) emission + handling. Keep `items[]/fullText` for back‑compat.
- **Acceptance:** tool UI can render per state; partial tool args stream; reasoning parts separate from text parts.

### Phase 3 — Generative UI · citations · artifacts (reuse core + ui‑primitives + artifacts)
**Goal:** wire the rich payloads that already exist but are dropped.
- Server emits widgets/citations via `@weaveintel/ui-primitives` builders; artifact lifecycle via `@weaveintel/artifacts` `ArtifactStreamHandle` → run journal; reuse `artifacts.run_id`.
- Reducer renders `WidgetView` (now actually fed), `CitationView`, `ArtifactView`.
- **Acceptance:** a run that produces a chart widget + 2 citations + 1 artifact reconstructs all three from the journal and persists artifacts with `run_id`.

### Phase 4 — Human‑in‑the‑loop approvals + bidirectional events
**Goal:** pause/resume on approval using the existing `postEvent` channel.
- Add `approval` kind + `requires-action` part state; persist to `run_approvals` (7.3); client answers via `postEvent` (the `Command(resume)` analog).
- **Acceptance:** a tool gated by approval pauses the run; client `postEvent` approve/deny resumes or aborts; state survives a server restart.

### Phase 5 — Client UX primitives + React hooks + web‑UI convergence  ✅ delivered
**Goal:** kill duplication; ship ergonomic hooks.
- **New** `@weaveintel/react-client` *extending* `@weaveintel/client`: `useRun`, `useRunStream`, `useOutbox`; status enum (`submitted/streaming/ready/error`), `stop`, `regenerate`, edit‑resubmit, branching, `experimental_throttle`, smooth streaming.
- **Fix G14:** migrate `apps/geneweave-ui` onto the shared reducer/transport (retire `ui-client.ts`'s hand‑rolled SSE), or at minimum share one SSE parser.
- **Acceptance:** geneweave‑ui renders chat via the shared client; the third SSE parser is deleted; mobile keeps working through api‑client.

**What shipped:**
- **`createRunSession`** (`packages/client/src/run-session.ts`) — the framework‑agnostic, single‑run UX controller: status state machine (`idle→submitted→streaming→ready|error`), `start`/`stop`(cancel)/`regenerate`/`approve`·`reject`(HITL)/`sendEvent`/`reset`/`done`, `getState`/`subscribe`, and `throttleMs` (smooth‑streaming coalescing; status transitions always flush). This is the canonical primitive the mobile `chat-session` and the new hook both build on (kills the hand‑rolled‑store duplication called out in G12/G14). 40 unit tests (positive/negative/stress/security).
- **`@weaveintel/react-client`** — `useRun` binds the controller with `useSyncExternalStore` (stable `start`/`stop`/… callbacks + `isStreaming`/`isLoading`), matching mobile's `useChatSession` convention. React 18/19 peer dep; typechecked against real React types.
- **One SSE parser** — extracted `parseSseStream` (`packages/client/src/sse-parser.ts`); `sseTransport` now consumes it (single byte→event decoder for the run/transport surface → api‑client → mobile → `createRunSession`). 23 unit tests.
- **App‑layer reuse** — `@geneweave/api-client` re‑exports `createRunSession` + `parseSseStream` + session types, so hosts configure the primitive through the SDK they already use.
- **Real‑LLM e2e** — `apps/geneweave/src/run-session-phase5.e2e.ts` drives the live `createRunSession` against the geneweave Run API across **direct/agent/supervisor/ensemble** (lifecycle → `ready`), plus `stop()`/`regenerate()`/concurrent‑start‑guard, plus the web‑UI streaming regression.

**G14 — partial / documented constraint:** `apps/geneweave-ui` is served as **raw ES modules** (no bundler, no import map; the bootstrap is CSP‑sha256‑hashed) and its browser source imports only relative `./` paths. A bare `@weaveintel/client` import would not resolve in the browser, and an import‑map/bundling step would have to map the whole `client→core` chain and re‑hash CSP — out of scope here. The single parser is therefore shared across every surface that *can* share a module graph; retiring geneweave‑ui's chat POST‑stream parser is tracked as a follow‑up requiring a UI build/bundle step. The web‑UI streaming path is covered by the regression test and is unchanged.

### Phase 6 — Resumable‑stream hardening + Outbox v2 + observability  ✅ delivered
**Goal:** refresh‑proof streams, robust offline, cost visibility.
- Refresh‑proof resume: persist cursor client‑side; optional Redis‑backed resumable context reusing `@weaveintel/cache` Redis + `collaboration` journal; honor `resume_window_seconds`.
- **Outbox v2:** buffer mid‑stream `postEvent`; add max‑attempts/backoff/dead‑letter (+ optional `run_dead_letter` table 7.6); `online`/`offline` listeners + Background‑Sync where available.
- Stream usage/cost to client; surface a metrics rollup (mirror `packages/cache` metrics).
- **Acceptance:** refresh mid‑run resumes from cursor; offline compose replays on reconnect; usage/cost visible in the view model and a metrics table.

**What shipped:**
- **Refresh‑proof resume** — `createRunCursorStore` (`packages/client/src/cursor.ts`) persists `{ runId, lastSequence, surface, updatedAt }` per run over the injectable `OutboxStorage` KV. `createRunSession` now persists the cursor on every event, clears it on terminal/stop/reset, and gains **`resume(runId)`**: it validates the cursor against the resume window (`isCursorResumable`), then re‑attaches with a full journal replay (`after=-1`) to rebuild the complete view model and live‑tail to terminal. `resumeWindowMs` is sourced from `GET /api/me/runs/config`'s `resumeWindowSeconds` (DB‑driven). Out‑of‑window → `RunResumeExpiredError` (host re‑drives). The server already replays via `?after=` + prunes by `journal_retention_hours` (Phase 0). 16 unit tests.
- **Outbox v2** — `createRunOutbox` extended (back‑compatible): mid‑stream `enqueueEvent(runId, payload)` buffering (not just run starts), bounded retries (`maxAttempts` + `backoffMs` with per‑item `nextAttemptAt`), a **dead‑letter queue** (`deadLettered()` / `clearDeadLetter()` / `onDeadLetter`), and `attachAutoFlush` wiring `online`/`offline` events. 11 unit tests.
- **Observability** — usage/cost already fold onto `vm.usage` (bridge emits `usage.update`); added **`createRunMetrics`** (`packages/client/src/metrics.ts`) mirroring `@weaveintel/cache`'s `createCacheMetrics` shape: run counts by outcome, error rate, token totals, USD cost, avg latency — `recordRun`/`recordSession`/`snapshot`/`reset`. 8 unit tests.
- **SDK fix** — `RunClient.listRuns` now unwraps the server's `{ runs: [...] }` envelope (it previously always returned `[]`).
- **App‑layer reuse** — `@geneweave/api-client` re‑exports `createRunCursorStore` / `createRunMetrics` / `createRunOutbox` + cursor/metrics types.
- **Real‑LLM e2e** (`apps/geneweave/src/run-resume-phase6.e2e.ts`): a run streams, the tab "closes" mid‑stream, a **fresh** session `resume(runId)`s to `ready` (full model rebuilt) across **direct/agent/supervisor/ensemble**; usage/cost surfaces on the view model + folds into a metrics rollup; an outbox start enqueued offline replays on flush and reaches terminal; web‑UI streaming regression.

### Phase 7 — Structured object streaming · multimodal · wire interop (optional)
**Goal:** round out the long tail.
- `streamObject`‑style partial‑object events + reducer part; file parts (multimodal) round‑trip; **optional** wire adapter to UI‑Message‑Stream / AG‑UI for ecosystem interop.
- **Acceptance:** partial structured object renders progressively; an image attachment round‑trips; (optional) an AG‑UI client can consume a run.

---

## 9. Sequencing & dependencies

```
Phase 0 ─► Phase 1 ─► Phase 2 ─► Phase 3 ─► Phase 4
   │                       └─────────────► Phase 5 ─► Phase 6 ─► Phase 7
   └─ (config + reconnect unblock everything)
```
- **0 and 1 first** — they remove duplication risk and the data loss; every later phase reduces against the aligned contract.
- 2 depends on 1 (needs the richer events). 3/4 depend on 2's part model. 5 can start after 2. 6/7 are hardening/long‑tail.

## 10. Non‑goals / risks
- **Do not fork** the reducer or transport into api‑client/geneweave‑ui again — Phase 0/5 collapse the existing forks.
- **Keep the reducer pure** and the outbox — they are differentiators.
- Wire‑protocol interop (AG‑UI/UI‑Message‑Stream) is **optional** (Phase 7); only pursue if external interop is a real requirement.
- Anthropic reasoning **signatures must round‑trip** or multi‑step tool loops break (known upstream bug) — cover in Phase 5 provider passthrough.
- Journal growth is a real risk **today** (`user_run_events` has no TTL) — Phase 0 addresses it.

---

## 11. Implementation status (delivered)

| Phase / item | Commit | Status |
|---|---|---|
| Phase 0 — contracts + reconnect + `run_stream_config` | `019ae82` | ✅ |
| Phase 1 — lossless chat→run bridge + reducer parity | `2247f82` | ✅ |
| Phase 2 — typed `parts[]` + per-part streaming states | `1de5b58` | ✅ |
| Reasoning request flag (m92) — Anthropic thinking / OpenAI effort, gated | `c4f5de9` | ✅ wired + unit-tested; reasoning *text* needs a producer (see follow-ups) |
| Phase 3 — generative UI · citations · artifacts (run-scoped) | `800a08d` | ✅ |
| Phase 4 — HITL tool approvals (pause → approve/deny → resume) | `ae207ca` | ✅ |
| Phase 5 — UX primitives (`createRunSession`) + `@weaveintel/react-client` (`useRun`) + single `parseSseStream` | `62cd99a` | ✅ (G14 web‑UI convergence partial — raw‑ESM serving; see Phase 5 note) |
| Phase 6 — refresh‑proof resume (cursor + `resume()`) + Outbox v2 (backoff/dead‑letter/online‑offline/events) + `createRunMetrics` | `81b1b3e` | ✅ |

## 12. Deferred follow-ups (scoped, with plans)

These surfaced during the reasoning + Phase 3 work and are **standalone sub-projects**, not quick edits. The contracts/consumers are already in place (the reducer handles `reasoning.delta` and `widget.update`); each needs a *producer* change.

### F1 — Stream OpenAI reasoning **text** (Responses adapter)
**Why:** the reasoning flag (m92) is correctly wired — `reasoningEffort` reaches OpenAI — but geneweave routes OpenAI through the chat-completions adapter (`weaveOpenAIModel`), which makes o-series *think* but never streams reasoning summary text. Only the Responses adapter (`openai-responses.ts`, `response.reasoning.delta`) yields it.
**Blocker:** `weaveOpenAIResponseModel` returns a different interface (`ResponseModel`/`streamResponse`/`ResponseStreamEvent`), and the request shape (`input`/`instructions`, flat function tools, `function_call_output` round-trip) differs — so it is **not** drop-in for `getOrCreateModel`, and has **no tool-call parity** with the agent pipeline.
**Plan (smallest safe):** add a `Model`-shaped wrapper `weaveOpenAIReasoningModel(modelId, opts)` in `packages/provider-openai` that holds a `weaveOpenAIResponseModel`, translates `ModelRequest`→`ResponseRequest` (messages→input; set `reasoning:{ effort: metadata.reasoningEffort, summary:'auto' }` — `summary:'auto'` is mandatory or no text streams), and maps `ResponseStreamEvent`→`StreamChunk` (`response.output_text.delta`→text, `response.reasoning.delta`→`{type:'reasoning'}`, completed→usage+done). Wire it in `chat-runtime.ts:127` **only for OpenAI reasoning models on direct/non-tool turns** (the wrapper has no tool round-trip). Verify the live event name (some API versions emit `response.reasoning_summary_text.delta`). Anthropic thinking already works end-to-end (blocked here only by the CI account having no credits).

### F2 — `emit_widget` tool (autonomous generative UI)
**Why:** Phase 3 derives a widget from `web_search` results deterministically, but there is **no autonomous widget producer** — the model can't choose to render a table/chart.
**Plan:** add an `emit_widget` tool mirroring `emit_artifact` (`tools.ts`): args `{ type:'table'|'chart'|…, title, data }`, validated + built via `@weaveintel/ui-primitives` (`tableWidget`/`chartWidget`), returning the `WidgetPayload`. In the bridge (`me-run-agent.ts` `#handleFrame` `tool_end`), detect `name==='emit_widget'` and `emit.widget(payload.id, payload, schemaVersion)`. Seed it into the tool catalog + the agent/supervisor default tool sets. Then a real run that calls `emit_widget` reconstructs a widget part end-to-end (no `web_search` dependency).

---

### Appendix A — Canonical event kinds (target taxonomy)
`run.started · run.completed · run.failed · run.cancelled` · `text.delta` · `reasoning.delta` · `tool.input.start · tool.input.delta · tool.invoked · tool.completed · tool.errored` · `step.update` · `widget.update` · `citation.add` · `artifact.update` · `approval.request` · `usage.update` · `file.part` · `progress.update` · `data.<name>`

### Appendix B — Primary evidence (file:line)
- Client: `packages/client/src/{transport.ts:59, reducer.ts:59/124, run-client.ts:151/161/205/213, outbox.ts:104}`
- Server: `apps/geneweave/src/routes/me.ts:{89,176,218,227,244}`, `me-run-executor.ts:{45,60,234}`, `me-run-agent.ts:{152,270,299}`
- Duplication: `clients/api-client/src/{client.ts:293/468, http.ts:132/168}`, `apps/geneweave-ui/src/ui-client.ts:{200,320}`
- DB: `migrations/m41-platform-foundation.ts` (`user_runs`, `user_run_events`), `m77-artifacts.ts`, `m01-m10.ts` (idempotency)
- Reuse targets: `packages/core/src/ui-events.ts:{7,26,47,63,87}`, `packages/core/src/agents.ts:87`, `packages/ui-primitives/src/{events.ts,widgets.ts,citations.ts,approval.ts}`, `packages/artifacts/src/streaming.ts:26`, `packages/collaboration/src/{run-journal.ts,run-registry.ts}`, `packages/provider-anthropic/src/anthropic-thinking.ts:22`
