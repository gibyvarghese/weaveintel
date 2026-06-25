# `@weaveintel/collaboration` — Review & Roadmap (Mid‑2026)

A package‑level review of `packages/collaboration`, its (non‑)usage in geneWeave, a mid‑2026 capability scan of the real‑time / multi‑agent / multiplayer space, a gap analysis against that bar and against what other weaveIntel packages already do, and a phased plan to **extend what exists (not duplicate it)** with everything driven by DB tables/config where it makes sense.

> TL;DR — The package is **dead‑wired**: it's a declared dependency of geneWeave (`apps/geneweave/package.json:34`) but **never imported anywhere in `apps/geneweave/src`**. geneWeave **re‑implemented** the package's two strongest primitives (run registry, run journal) plus live fan‑out in SQL, and **does not implement at all** the package's genuinely differentiating capabilities — **presence, shared sessions, and user‑facing handoff**. Those missing capabilities are precisely the mid‑2026 "multiplayer for AI" frontier, and none of them has a DB representation today.

---

## 1. What `packages/collaboration` is today

`@weaveintel/collaboration` v0.0.1 (`packages/collaboration/package.json`) — ESM, single dep `@weaveintel/core`, no transport/networking/DB driver of its own. ~1,176 LOC. It splits into **two architectural generations**:

**Gen‑1 (in‑memory, single‑process, prototype‑grade):**
- **`session.ts`** — shared sessions + presence. `SharedSession`, `SessionParticipant` (role: owner/collaborator/viewer), `PresenceState` (`online|idle|typing|away|offline`), `createSharedSessionManager()` → `create/get/join/leave/updatePresence/broadcast/listSessions/close`. **`broadcast()` is a no‑op** (`session.ts:102‑104`) → there is **no real‑time transport**; presence changes go nowhere. No heartbeat/expiry (`lastActiveAt` written, never read), no tenant isolation, non‑UUID ids, lost on restart.
- **`events.ts`** — `CollaborationEvent` envelope + `createCollaborationEvent/isPresenceEvent/isHandoffEvent`. **Real but dead** — pure value constructors, never emitted or consumed in‑package.
- **`subscription.ts`** — `RunSubscription` (status + progress), `createRunSubscriptionManager()`. In‑memory `Map`. `updateStatus` mutates *all* subs for a run but returns only the first match (`subscription.ts:40‑48`). No push (depends on the no‑op broadcast).
- **`handoff.ts`** — user/agent handoff lifecycle (`requested→accepted/rejected/cancelled/completed`). In‑memory. `reject(reason?)` **drops the reason** (`handoff.ts:53`). No state‑machine guards.

**Gen‑2 (durable, the genuinely‑engineered layer):**
- **`run-registry.ts`** — durable `RunHandle` registry over `runtime.persistence.kv`. **The most production‑grade module**: strict tenant isolation (key `ns:tenantId:runId` + `assertTenantMatch`), idempotent status updates (TTL'd idempotency keys), optional lifecycle events on an `EventBus`, restart‑survival. 7 passing tests. Gaps: `register` skips the tenant assertion + silently overwrites; `listByPrincipal` is a full KV scan with no pagination/ordering; idempotency only within a 5‑min TTL; last‑write‑wins on update.
- **`run-journal.ts`** — append‑only `StreamEnvelope` journal for **stream resume**, padded‑sequence keys (lexical == sequence order), cursor resume, `retentionMs=24h`, `maxEnvelopesPerRun=2000`. Durable, TTL‑evicted. Gaps: **no tenant isolation** (takes an `ExecutionContext` but ignores it — `run-journal.ts:71‑77`); resume **not gap‑safe** vs the size‑cap prune for laggy clients; O(N) `list`+prune on every append.
- **`durable.ts`** — KV‑backed variants of the three Gen‑1 managers. **Real but dormant** (exported, **zero runtime callers**). No tenant isolation (global namespace), no TTL, read‑modify‑write races (LWW, no locking/CRDT), O(N) full‑namespace scans.

**Maturity at a glance**

| Capability | Module | Real / Stub / Dead | In‑mem / Durable | Tenant‑isolated | Headline gap |
|---|---|---|---|---|---|
| Shared sessions + presence | `session.ts` | Real (single‑proc) | In‑memory | ❌ | `broadcast()` no‑op → no realtime; no presence expiry; lost on restart |
| Collaboration event helpers | `events.ts` | Real but **dead** | n/a | n/a | never emitted/consumed |
| Run subscriptions | `subscription.ts` | Real | In‑memory | ❌ | no push; `updateStatus` returns wrong handle; volatile |
| User/agent handoff | `handoff.ts` | Real | In‑memory | ❌ | drops reject reason; no guards; volatile |
| Durable handoff/session/sub | `durable.ts` | Real but **dormant** | Durable KV | ❌ | no tenant prefix; no TTL; LWW races; O(N) scans |
| **Durable run registry** | `run-registry.ts` | **Real, most mature** | Durable KV | ✅ | `register` skips tenant assert; no pagination; LWW |
| Run event journal | `run-journal.ts` | Real | Durable KV (TTL) | ❌ | ignores `ctx`; resume not gap‑safe; O(N) per append |

**Two cross‑cutting truths:** (1) **No real‑time transport exists anywhere** in the package — `broadcast` is a no‑op, nothing opens a socket/SSE/pub‑sub; the only event surface is the optional `EventBus` in `run-registry`. (2) Tenant isolation is present **only** in `run-registry`.

---

## 2. How it's used in geneWeave (and where it's bypassed)

**It isn't.** The single most important finding:

- `@weaveintel/collaboration` is declared in `apps/geneweave/package.json:34` but **never imported in `apps/geneweave/src`** — nor anywhere in `apps/` or `packages/`. The only importer in the whole repo is the standalone demo `examples/115-collaboration.ts` (Gen‑1 managers only). `createRunRegistry`, `createRunJournal`, all three `createDurable*`, and the entire `events.ts`/presence API have **zero production callers**.
- `RunStatus`/`RunHandle` were **promoted out** of collaboration into `@weaveintel/core` (`packages/core/src/runs.ts:16`), so even the shared vocabulary now lives elsewhere — the package is left a thin, unused wrapper.

**geneWeave forked the two best primitives into SQL** instead of reusing them:

| Concept | `@weaveintel/collaboration` (KV) | geneWeave's own (SQL) |
|---|---|---|
| Run registry | `createRunRegistry` (`run-registry.ts`) | `user_runs` table (`m41`) + `getUserRun`/`updateUserRunStatus`/`listUserRuns`; tenant via `tenant_id`; ownership re‑checked (`me-run-executor.ts:334`) |
| Run journal | `createRunJournal` (`run-journal.ts`) | `user_run_events` table (`m41`) + `MeRunExecutor.appendEvent` (`me-run-executor.ts:256`) — gap‑free monotonic `sequence`, per‑run lock, idempotent terminal events, `UNIQUE(run_id,sequence)` |
| Live subscriptions | `createRunSubscriptionManager` (`subscription.ts`) | `SseSubscriber` + `subscribe()`/`#broadcast()` (`me-run-executor.ts:126‑246`) — SSE fan‑out with buffered replay→live handoff, dedup‑by‑sequence |

**Smoking gun of deliberate duplication:** `run_stream_config` (`m91`) defaults `journal_retention_hours = 24` and `journal_max_events = 2000` — an **exact numeric clone** of `RunJournal`'s documented defaults (`run-journal.ts:38‑44`). geneWeave copied the journal's semantics into SQL rather than importing it.

**Important nuance — this is the foundation the Client Roadmap (Phases 0–7) built on.** The whole `@weaveintel/client` run‑streaming stack (`createRunSession`, reducer, cursor resume, AG‑UI adapter) consumes geneWeave's **SQL** journal/registry via `/api/me/runs`. So the SQL fork is the *de‑facto canonical* implementation; the KV package is the unused one. Any reconciliation must treat **geneWeave's SQL as the source of truth** and make the package's *interfaces* (not its KV storage) the reusable contract.

---

## 3. Database inventory (collaboration concepts)

| Table (migration) | Represents | Status |
|---|---|---|
| `user_runs` (`m41`) | Run registry (RunHandle) | ✅ backed (geneWeave's own) |
| `user_run_events` (`m41`, `UNIQUE(run_id,sequence)`) | Run journal | ✅ backed |
| `run_stream_config` (`m91`) | Journal retention / resume / heartbeat policy | ✅ backed (config) |
| `live_runs` / `live_run_steps` / `live_run_events` (`m19‑m22`, `m59`) | Run registry+journal for the **mesh** subsystem | ✅ backed (separate feature) |
| `api_live_runs` (`m59`) | API‑started live runs | ✅ backed |
| `agent_handoff_log` (`m64`) | **Agent→agent** handoff (lateral) | ✅ backed — but **not** the package's *user* handoff model |
| `hitl_interrupt_requests` (`m64`) | HITL approvals/interrupts | ✅ backed (used by `runApprovals`) |
| **Shared sessions** | `SharedSession`/participants | ❌ **no table** |
| **Presence** | `PresenceState` — who's watching a run/chat | ❌ **no table**; nothing persists watchers |
| **Run subscriptions** | `RunSubscription` | ⚠️ in‑memory only (`SseSubscriber`); no row, lost on restart, invisible cross‑process |
| **User handoff** | `HandoffRequest` (user↔user / agent↔user) | ❌ **no table** |
| **Run comments / annotations** | collaborative run review | ❌ **no table** |

**Net:** geneWeave reuses **none** of the package; it re‑implements three concepts in SQL and the other three (sessions, presence, user‑handoff) are absent and unpersisted.

---

## 4. Mid‑2026 state of the art (the benchmark bar)

The defining 2025→2026 shift: **agents are co‑equal real‑time peers**, sharing the same rooms/presence/awareness/conflict‑resolution as humans. A three‑layer interop stack crystallized — **MCP** (agent↔tools), **A2A** (agent↔agent), **AG‑UI** (agent↔user) — mostly under the Linux Foundation's **Agentic AI Foundation (AAIF, formed Dec 9 2025)**.

1. **Multiplayer / co‑presence for AI** — a distinct product category (Liveblocks "apps and agents", PartyKit/Cloudflare Durable‑Object rooms <30 ms, tldraw `@tldraw/sync` + Agent Starter Kit, Figma's parallel human+agent canvas May 2026, Convex/Supabase/Ably). **Bar:** edge per‑room compute; **presence heartbeat + TTL expiry** on an ephemeral LWW channel (re‑broadcast ~15 s, reap ~30 s); durable content via CRDT; agents as co‑equal peers (awareness identity, live cursor/status, @mentionable); multiple agents + humans in parallel; connection‑state recovery; per‑room multi‑tenant auth.
2. **CRDTs & conflict‑free shared state** — Yjs (default, ~920K wk), Automerge 3 (>10× memory cut), Loro 1.x (fastest). Agent‑as‑CRDT‑peer (server‑side Yjs replica with awareness entry + relative‑position anchored streaming) vs agent‑as‑suggester (HITL via comments). **Bar:** convergent merge, tombstone GC/compaction, snapshot+incremental, awareness‑with‑timeout, offline sync, per‑actor undo.
3. **A2A & handoff** — Google **A2A v1.0** (LF; **Signed Agent Cards**, multi‑tenancy, JSON‑RPC+gRPC+SSE, Task/Message/Part/Artifact, 150+ orgs), **MCP** as the complementary tool layer, OpenAI Agents SDK handoffs (control‑of‑loop transfer + context filters), supervisor/sub‑agent orchestration, agent gateways/mesh. **Bar:** bounded context transfer, capability discovery, **per‑agent identity (OAuth/OIDC/mTLS + signed cards)**, audit/provenance, durable task lifecycle, first‑class human escalation.
4. **Real‑time transports** — **SSE→WebSocket migration for agents** (SSE for token streaming; WS/durable sessions for control + multi‑device + fan‑out), Cloudflare Durable Objects + **WebSocket Hibernation**, Vercel `resumable-stream` (reload‑only), Ably AI Transport (survives tab switches), WebTransport (progressive enhancement). **Bar:** **resumability is table stakes; reload‑only is below bar**; heartbeat ~15 s / dead ~25 s; resume mid‑generation via event IDs.
5. **Run/session registries & journals** — every invocation a **durable run** with an append‑only replayable journal and **crash resume** ("durable agents"): Temporal (Workflow Streams, May 2026), Restate, Inngest (zero‑cost suspend), DBOS (Postgres lib, start/stop/resume/**fork**), LangGraph (durability modes; *bare checkpointers ≠ durable execution*), OpenAI/Vercel SDK 6 (`DurableAgent`, `needsApproval`, resumable streams). **Bar:** durable execution (not just checkpoints) + idempotent exactly‑once + zero‑cost deploy‑surviving HITL + durable resumable streaming + multi‑tenant by construction + lifecycle surface (start/stop/resume/fork, increasingly via MCP) + journal hygiene (compaction + large‑payload offload).
6. **Observability / collaboration overlap** — shared **live** run timelines, **Google‑Docs‑grade anchored comments** + @mentions (Langfuse, Braintrust), annotation queues with assignment/rubrics/pairwise feeding eval datasets (LangSmith), **public view‑only trace links**, **time‑travel replay that re‑runs the real agent loop** (LangSmith/LangGraph), OTel GenAI conventions (still experimental mid‑2026). **Bar:** live multi‑viewer traces (static is below bar) + anchored comments + annotation queues + public links + checkpoint replay.
7. **Standards** — speak MCP+A2A+**AG‑UI** composably; AG‑UI's 17 typed events incl. **`StateDelta` = JSON Patch RFC 6902** (the protocol layer's nearest analog to shared collaborative state). **The most relevant gap: there is NO ratified presence/awareness or CRDT‑sync interop standard** — multiplayer‑with‑AI is solved by *library conventions* (Yjs awareness). **A coherent presence/journal layer therefore puts weaveIntel ahead of, not behind, the standards.**

---

## 5. Capabilities already implemented in *other* weaveIntel packages (extend, don't duplicate)

| Capability | Where it already lives | Relationship | Action |
|---|---|---|---|
| Run journal / registry / live fan‑out | **geneWeave SQL** (`user_runs`, `user_run_events`, `SseSubscriber`) + `@weaveintel/client` (reducer, cursor) | **Duplicate** of collaboration's KV registry/journal | Make geneWeave SQL the canonical store behind collaboration's *interfaces* |
| SSE parse/transport | `@weaveintel/client` `parseSseStream`/`sseTransport` (Phase 5) **and** `@weaveintel/a2a` `sse-parser` | **Duplicate** parser in client+a2a | Promote one `parseSseStream`/`EventTransport` to `core`; reuse everywhere |
| Agent→agent handoff + identity | `@weaveintel/a2a` (A2A client/bus/task‑store; the A2A v1.0 bridge) | **Complementary** (cross‑network) | Reuse A2A for the *agent* side of handoff; collaboration owns the *user/session* side |
| In‑process agent handoff | `@weaveintel/agents` `handoff.ts` (`HandoffSignal`) | Complementary (peer routing) | Keep; link from collaboration handoff |
| HITL interrupts / approvals | `@weaveintel/agents` `interrupt.ts`, `@weaveintel/human-tasks`, geneWeave `runApprovals` + `hitl_interrupt_requests` (Client Phase 4) | **Overlapping** with collaboration handoff | Build user‑handoff *on top of* human‑tasks + the existing HITL tables |
| Event bus + run→notification mapping | `@weaveintel/core` `EventBus`, `@weaveintel/notifications` `bindRunNotifications` (`bus.onAll`) | Complementary | Emit collaboration lifecycle/presence onto `EventBus`; notifications already dispatches it |
| Realtime WebSocket | `@weaveintel/voice` `ws-handler`/`realtime-proxy` | Complementary (voice) | Reuse its WS patterns if/when collaboration needs a WS control channel |
| Mesh runs (multi‑agent) | `@weaveintel/live-agents*` + `live_runs*` tables | Complementary (agent topology ≠ user presence) | Keep separate; cross‑link |

---

## 5b. Package placement & de‑duplication verdict (should this be its own package?)

**Finding: the package conflates two unrelated responsibilities.** It bundles (a) the **run‑lifecycle substrate** — run registry, run journal, live subscription — with (b) genuine **multiplayer collaboration** — shared sessions, presence, user handoff. These have different reasons to change and different owners.

- **(a) is mis‑homed.** Its vocabulary already lives in `@weaveintel/core` (`RunHandle`, `RunStatus` in `core/src/runs.ts:19,40`; `RunEventEnvelope` in `core/src/run-events.ts:18`). The platform standardized the journal on **`RunEventEnvelope`** (client reducer + geneWeave), yet collaboration's `run-journal.ts` still stores the **legacy `StreamEnvelope`/`UiEvent`** (`core/src/ui-events.ts:26`) — a second, older run‑event format. And geneWeave already owns the canonical **SQL** implementation. So the registry/journal in `collaboration` are a *legacy fork of platform substrate*, not a collaboration concern.
- **(b) is the real, non‑duplicative reason for a collaboration package to exist** — presence/sessions/comments/user‑handoff have no other home and are the mid‑2026 multiplayer frontier.

### Verdict — where each capability belongs

| Capability | Today | Should live in | Why |
|---|---|---|---|
| Run registry | collaboration (KV) + geneWeave (SQL) | **`core` interface** + geneWeave SQL impl | `RunHandle` already in core; substrate, not collaboration |
| Run journal | collaboration (KV, legacy `StreamEnvelope`) + geneWeave (SQL) | **`core` interface (on `RunEventEnvelope`)** + geneWeave SQL impl | platform standardized on `RunEventEnvelope`; collaboration speaks the legacy envelope |
| Live run subscription (SSE fan‑out) | collaboration (in‑mem) + geneWeave `SseSubscriber` | **`core`/transport interface** + geneWeave impl | a transport/run concern |
| **Presence** | collaboration (stub) | **`collaboration`** (extend) | genuine multiplayer — the package's reason to exist |
| **Shared sessions** | collaboration (stub) | **`collaboration`** (extend) | genuine multiplayer |
| **Run comments / annotations** | nowhere | **`collaboration`** (new) + `evals` for scores | collaborative review |
| User / session handoff | collaboration (stub) | **`collaboration`** coordination **on `human-tasks`** | user‑facing; reuse HITL, don't reimplement |
| Agent↔agent handoff | `a2a` / `agents` | **stay** in `a2a` (cross‑net) + `agents` (in‑proc) | different layers — do **not** add a 4th |
| Durable / notify subscription | collaboration (dormant) | **`notifications`** | it already maps run events → notifications via `bus.onAll` |
| SSE parse | `client` + `a2a` (dup) | **`core`** (one primitive) | true duplicate (see below) |
| Collaboration event helpers (`events.ts`) | collaboration (dead) | **delete** / fold into core `EventBus` | unused vocabulary, never emitted |
| Durable KV variants (`durable.ts`) | collaboration (dormant) | **delete** → ports+adapter | superseded by interface + SQL adapter |

### True duplicates to consolidate (doing *exactly* the same thing)
1. **SSE byte→event parser.** `client/src/sse-parser.ts` (`parseSseStream` → `SseEvent`; richer: stall timeout + abort + `event:` names) **and** `a2a/src/sse-parser.ts` (`parseSseStream<T>` → typed JSON) run the same `getReader → decode → split('\n') → buffer‑incomplete‑line → skip comments` loop. **Action:** one `parseSseStream` in `core` returning `SseEvent`; `a2a` layers a JSON `.map` on top; `client` keeps the stall/abort options. Retire the `a2a` copy. (This is the same "share one parser" item already noted in the Client Roadmap G14.)
2. **Run registry + run journal.** collaboration (KV) vs geneWeave (SQL). **Action:** Phase 0 — one interface in `core`, geneWeave SQL as the impl; delete the KV ones (or keep them behind the same interface for non‑SQL hosts).
3. **Run‑event envelope.** `core` carries **both** `StreamEnvelope` (legacy, `ui-events.ts`) and `RunEventEnvelope` (`run-events.ts`); the collaboration journal uses the legacy one, everything else uses `RunEventEnvelope`. **Action:** standardize the journal on `RunEventEnvelope`; deprecate `StreamEnvelope` for run journaling.

### NOT duplicates — keep separate, layered (needed)
- **Handoff at three scopes:** `a2a` (agent↔agent, cross‑network, A2A v1.0) · `agents` (in‑process peer routing via `HandoffSignal`) · `collaboration` (user/session, presence‑aware). Different layers — document a decision tree instead of merging.
- **HITL granularities:** `agents/interrupt` (tool‑call) · `human-tasks` (generic queue) · `collaboration` handoff (presence) · `workflows` approval (step). Collaboration builds **on** `human-tasks`, it doesn't reimplement it.
- **Subscription vs session vs task‑store:** `RunSubscription` (multi‑user tracking) · `client` `RunSession` (single‑user UX controller) · `a2a` `A2ATaskStore.subscribe` (task iterable) — different mental models.
- **`Mesh`/`live_runs` (agent topology)** vs **shared sessions (user presence)** — different concerns; cross‑link only.
- **`EventBus`** is already canonical in `core` (`createEventBus`); the `devtools` mock + `triggers` `MinimalEventBus` subset are not duplicate implementations.

### Bottom line
**Yes — keep `@weaveintel/collaboration` as its own package, but re‑scope it to multiplayer only** (presence, shared sessions, run comments, user‑handoff *coordination*), and **lift the run substrate (registry / journal / live‑subscription) into `core`** on the `RunEventEnvelope` contract (geneWeave SQL as the implementation). That gives the package a single defensible responsibility and removes every true duplicate. (A dedicated `@weaveintel/runs` package is an acceptable alternative home for the substrate if `core` grows too large — but the types already sit in `core`, so start there.)

---

## 6. Gap matrix — capability × status × where it should live

Status: ✅ have · 🟡 partial · 🟥 stub/dead · ⛔ missing. "Reuse" = extend this, don't fork.

| # | Capability | Status in geneWeave | Status in collaboration pkg | Mid‑2026 bar | Reuse / extend |
|---|---|---|---|---|---|
| C1 | Durable run registry | ✅ SQL (`user_runs`) | 🟡 KV, unused | durable‑execution + tenant isolation | geneWeave SQL behind a `RunRegistry` port |
| C2 | Resumable run journal | ✅ SQL (`user_run_events`) + client cursor | 🟡 KV, unused | gap‑safe resume + compaction + offload | geneWeave SQL behind a `RunJournal` port |
| C3 | Live run subscriptions | 🟡 in‑memory `SseSubscriber` | 🟥 in‑memory | durable + cross‑process + notify offline | new `run_subscriptions` table + EventBus + notifications |
| C4 | **Presence (who's watching)** | ⛔ none | 🟥 in‑mem, no‑op broadcast | heartbeat+TTL on ephemeral channel, agent peers | **new `run_presence` table + SSE `presence.update` + client `vm.presence`** |
| C5 | **Shared sessions (multi‑user)** | ⛔ none | 🟥 in‑mem | rooms with roles, multi‑tenant auth | **new `shared_sessions` + `session_participants`** |
| C6 | **User / agent→user handoff** | 🟡 agent↔agent log + HITL | 🟥 in‑mem, drops reason | context transfer + audit + escalation | extend `agent_handoff_log` → `session_handoffs`; build on human‑tasks + A2A |
| C7 | **Collaborative run timeline (comments/annotations)** | ⛔ none | ⛔ none | anchored comments + annotation queues + public links | **new `run_comments` + `run_annotations`** |
| C8 | Real‑time transport | ✅ SSE fan‑out | 🟥 no‑op broadcast | SSE default + WS for control; resume beyond reload | extend `SseSubscriber`; share one `parseSseStream`/`EventTransport` |
| C9 | CRDT shared state (agent‑as‑peer) | ⛔ none | ⛔ none | Yjs/Loro merge + awareness + relative anchors | **optional** new `@weaveintel/coedit` (Yjs) — frontier |
| C10 | Standards (AG‑UI presence/state, A2A handoff) | 🟡 AG‑UI adapter (client Phase 7) | ⛔ none | AG‑UI `StateDelta`/presence; A2A signed cards | extend `toAGUIEvents`; reuse A2A |

---

## 7. Proposed database additions (config & data in DB where geneWeave uses it)

Continue geneWeave's single‑row config + per‑entity table convention (`mNN` sequence, mirror `run_stream_config`/`semantic_cache_config`). All new behaviour admin‑editable via the existing admin schema/routes pattern.

- **7.1 `run_presence` (REQUIRED, C4).** `id, run_id→user_runs, chat_id, user_id, tenant_id, display_name, presence('online'|'idle'|'typing'|'away'|'offline'), cursor_json, last_heartbeat_at, expires_at, created_at`. Heartbeat‑driven; a sweeper reaps `expires_at < now`. Ephemeral‑LWW semantics; broadcast as a `presence.update` run event over the existing SSE fan‑out.
- **7.2 `shared_sessions` + `session_participants` (REQUIRED, C5).** `shared_sessions(id, tenant_id, name, owner_id, kind('run'|'chat'|'canvas'), target_id, metadata_json, created_at, closed_at)`; `session_participants(session_id, user_id, role('owner'|'collaborator'|'viewer'), joined_at, last_active_at, UNIQUE(session_id,user_id))`. A share token row for invite links (reuse the artifact share‑token pattern from Client Phase 7 era).
- **7.3 `run_subscriptions` (REQUIRED, C3).** `id, run_id, user_id, tenant_id, channel('inapp'|'email'|'webhook'), status, created_at, UNIQUE(run_id,user_id,channel)`. Durable replacement for the in‑memory subscriber list; drives `@weaveintel/notifications` on terminal events even when the client is offline.
- **7.4 `session_handoffs` (RECOMMENDED, C6).** `id, session_id|run_id, tenant_id, from_user_id, from_agent, to_user_id, to_agent, status('requested'|'accepted'|'rejected'|'cancelled'|'completed'), reason, context_json, requested_at, resolved_at`. Unifies the *user* handoff model with the existing `agent_handoff_log`; **persist the reject reason** (the package drops it). Build the human side on `@weaveintel/human-tasks` + `hitl_interrupt_requests`; the agent side on `@weaveintel/a2a`.
- **7.5 `run_comments` + `run_annotations` (RECOMMENDED, C7).** `run_comments(id, run_id, tenant_id, author_id, anchor_sequence, anchor_part_id, body, mentions_json, resolved, created_at)` (Google‑Docs‑style anchoring to a journal sequence / reducer part id); `run_annotations(id, run_id, reviewer_id, label, score, rubric_json, created_at)` feeding eval datasets (reuse `@weaveintel/evals`).
- **7.6 `collaboration_config` (single row, REQUIRED).** `presence_heartbeat_ms(15000), presence_ttl_ms(30000), presence_sweep_ms(10000), max_participants_per_session(50), share_link_ttl_seconds, comments_enabled, annotation_queue_enabled, surfaces_json`. Served via a small `GET /api/me/collab/config` (mirror `GET /api/me/runs/config`), cached ~60 s, admin‑editable.

---

## 8. Phased roadmap

Each phase extends existing code (geneWeave SQL, `@weaveintel/client`, core `EventBus`, a2a, human‑tasks), ends with acceptance criteria, and is independently shippable. **Principle: the package supplies the interfaces/contracts; geneWeave's DB supplies the storage; the client surfaces it.** Real‑LLM + Playwright UI tested across chat modes, per the Client‑Roadmap house style.

### Phase 0 — Re‑home the substrate + reconcile the fork (stop duplicating; make the package real)
**Goal:** one canonical run registry/journal living in the right package, and `@weaveintel/collaboration` re‑scoped to multiplayer only. (Implements the §5b verdict.)
- **Lift the run substrate into `core`:** move the `RunRegistry` / `RunJournal` / live‑`Subscription` **interfaces** to `@weaveintel/core` (alongside `RunHandle`/`RunStatus`/`RunEventEnvelope`), standardized on **`RunEventEnvelope`** (deprecate the legacy `StreamEnvelope` for journaling). `collaboration` keeps only presence/sessions/comments/user‑handoff.
- **One SQL implementation:** provide a SQL adapter (in geneWeave) implementing the core `RunRegistry`/`RunJournal` interfaces over the existing `user_runs`/`user_run_events` tables; wire `me-run-executor` to depend on the *interface*. Delete the dormant KV variants (`durable.ts`) and the dead `events.ts`, or keep KV behind the same interface for non‑SQL hosts.
- **Consolidate the SSE parser** (true duplicate #1): one `parseSseStream` in `core` returning `SseEvent`; `client` and `a2a` consume it; retire `a2a/src/sse-parser.ts`'s copy.
- Fix the real bugs surfaced in §1 (registry `register` tenant assertion; journal tenant scoping + gap‑safe resume; subscription `updateStatus` correctness; handoff reject‑reason).
- **Acceptance:** geneWeave's run pipeline runs through the **core** `RunRegistry`/`RunJournal` interfaces with **no behavioural change** (all Client Phase 0–7 e2e still green); `@weaveintel/collaboration` no longer contains run‑substrate code; the duplicate SSE parser is deleted; `run_stream_config`'s 24h/2000 are sourced from one place; the previously‑dead geneWeave dependency on `collaboration` is removed until Phase 1 re‑adds it for presence.

### Phase 1 — Presence (highest‑value missing capability) · C4
**Goal:** "who else is here" on every run/chat — the multiplayer baseline weaveIntel completely lacks.
- `run_presence` table (7.1) + `PresenceManager` (heartbeat upsert, TTL sweep). `POST /api/me/runs/:id/presence` (heartbeat) + a sweeper job; broadcast `presence.update` over the existing `SseSubscriber` fan‑out.
- New run‑event kind `presence.update`; extend the **client reducer** with `vm.presence` (active participants + state), mirroring the Phase 7 `file.part`/`object.delta` additions. Surface in `createRunSession`.
- Config from `collaboration_config` (heartbeat/ttl/sweep), DB‑driven like `run_stream_config`.
- **Acceptance:** two browser sessions on the same run see each other's presence appear/expire (heartbeat+TTL) in real time via Playwright; presence reconstructs in `vm.presence`; survives one client disconnect (TTL reaps it). Tested across direct/agent/supervisor/ensemble.

### Phase 2 — Shared sessions + invite links · C5
**Goal:** multi‑user shared runs/chats with roles.
- `shared_sessions` + `session_participants` (7.2) + `SessionManager`; share‑token route (reuse the artifact share‑token pattern). Roles gate write vs view. Presence (Phase 1) scopes to a session.
- Client: `useRun`/`createRunSession` accept a `sessionId`; the reducer exposes participants+roles.
- **Acceptance:** an owner shares a run via link; a second user joins as viewer, sees live output + presence, cannot send control events; roles enforced server‑side. Playwright multi‑context test.

### Phase 3 — Durable subscriptions + offline notifications · C3
**Goal:** subscribe to a run and get notified even when not watching.
- `run_subscriptions` table (7.3); on terminal journal events, the registry emits onto core `EventBus`; `@weaveintel/notifications` `bindRunNotifications` (already exists) dispatches in‑app/email/webhook.
- Replace the volatile in‑memory subscriber list semantics for *notification routing* (keep `SseSubscriber` for live streaming).
- **Acceptance:** a user subscribes, closes the tab, the run completes → a notification is delivered (in‑app row + webhook fired). Cross‑process/restart‑safe. Real‑LLM run.

### Phase 4 — Collaborative run timeline: comments & annotations · C7
**Goal:** Google‑Docs‑grade review on a run.
- `run_comments` (anchored to a journal `sequence`/reducer `part id`) + `run_annotations` (score/rubric → `@weaveintel/evals` datasets). `@mentions` via notifications. Public view‑only share link (reuse 7.2 tokens).
- Client: render comments anchored to parts in the reducer's `parts[]`/timeline.
- **Acceptance:** a reviewer comments on a specific tool/step part of a finished run; an @mention notifies; an annotation with a score lands in an eval dataset; a public link renders read‑only. Playwright.

### Phase 5 — Unified handoff (user ↔ user, agent ↔ user) · C6
**Goal:** one handoff model with context transfer + audit, reconciled across the three existing scopes.
- `session_handoffs` table (7.4); `HandoffManager` over it. Human side built on `@weaveintel/human-tasks` + `hitl_interrupt_requests` (Client Phase 4); agent side delegates to `@weaveintel/a2a` (A2A v1.0 context transfer + signed cards). **Persist the reject reason.** Audit every transition.
- **Acceptance:** an agent run escalates to a human (HITL handoff) who accepts, takes over the session, and hands back — full context + audit trail persisted; a rejected handoff records its reason. Across modes.

### Phase 6 — Real‑time transport hardening + AG‑UI/A2A standards · C8/C10
**Goal:** control‑plane realtime + standards alignment.
- Share one `parseSseStream`/`EventTransport` (promote from client to `core`; retire the a2a copy). Optional WebSocket control channel (reuse `@weaveintel/voice` WS patterns) for presence + cancel/steer with resume‑beyond‑reload.
- Extend `toAGUIEvents` (client Phase 7) to emit **presence** + `StateDelta` (RFC 6902) events; expose handoff via A2A.
- **Acceptance:** presence + control signals survive a tab switch (not just reload); an AG‑UI client consumes a run *with* presence/state events; the duplicate SSE parser is deleted.

### Phase 7 — CRDT shared state / agent‑as‑peer (optional, frontier) · C9
**Goal:** collaborative co‑editing of artifacts/canvas with the agent as a peer.
- New optional `@weaveintel/coedit` (Yjs or Loro) — shared doc CRDT + awareness; the agent is a server‑side replica streaming into relative‑position‑anchored rich text; HITL "agent‑as‑suggester" fallback. Persist snapshots; reuse `@weaveintel/artifacts` for storage.
- **Acceptance:** a human and the agent co‑edit one artifact concurrently with convergent merge + awareness cursors; offline edits reconcile. (Optional / spike‑first.)

---

## 9. Sequencing & dependencies

```
Phase 0 (reconcile) ─► Phase 1 (presence) ─► Phase 2 (sessions) ─► Phase 4 (comments)
        │                      └─────────────► Phase 3 (subscriptions)
        └─ unblocks everything (one canonical registry/journal)
Phase 5 (handoff) depends on 2 + existing HITL/a2a · Phase 6 (transport/standards) after 1–2
Phase 7 (CRDT) is an optional frontier spike, independent of 3–6
```
- **0 first** — it removes the duplication risk and makes the package live; every later phase extends the same contract.
- 1→2 are the multiplayer core (and where weaveIntel can lead the standards). 3 reuses notifications. 4 reuses evals. 5 reuses human‑tasks + a2a. 6 consolidates transport. 7 is optional.

## 10. Non‑goals / risks
- **Do not fork** the registry/journal a third time — Phase 0 collapses the existing KV‑vs‑SQL fork onto one contract. Treat geneWeave SQL as canonical (the Client Roadmap already depends on it).
- **Presence/CRDT have no ratified interop standard** (mid‑2026) — ship the library convention (Yjs awareness / AG‑UI `StateDelta`) and keep it adapter‑isolated so a future standard can slot in.
- Keep **tenant isolation by construction** in every new table (the package's biggest inconsistency); mirror `run-registry`'s `tenantId` scoping, not the journal's omission.
- Don't let presence/comment write volume bloat the journal — presence is ephemeral (own table + TTL), not journal events persisted forever.

---

## 11. Appendix — primary evidence (file:line)
- Package: `packages/collaboration/src/{session.ts, events.ts, subscription.ts, handoff.ts, durable.ts, run-registry.ts, run-journal.ts, index.ts}`; tests `w3-run-registry.test.ts`.
- Dead‑wire: `apps/geneweave/package.json:34` (declared) with **no** `apps/geneweave/src` importer; only `examples/115-collaboration.ts`; doc mention `apps/geneweave/src/docs-html.ts:189`; type promotion `packages/core/src/runs.ts:16`.
- geneWeave fork: `user_runs`/`user_run_events` (`migrations/m41-platform-foundation.ts`), `MeRunExecutor.appendEvent`/`SseSubscriber` (`apps/geneweave/src/me-run-executor.ts:126‑256,334`), `run_stream_config` 24h/2000 (`migrations/m91-run-stream-config.ts:30‑31`) == `run-journal.ts:38‑44`.
- Related tables: `live_runs*` (`m19‑m22`, `m59`), `agent_handoff_log`/`hitl_interrupt_requests` (`m64`).
- Adjacent packages: `@weaveintel/a2a` (A2A bridge + `sse-parser`), `@weaveintel/agents` (`handoff.ts`, `interrupt.ts`), `@weaveintel/human-tasks`, `@weaveintel/client` (`transport.ts`, `cursor.ts`, `run-session.ts`, `ag-ui.ts`), `@weaveintel/notifications` (`subscriptions.ts` `bus.onAll`), `@weaveintel/core` (`events.ts` EventBus, `runs.ts`), `@weaveintel/voice` (`ws-handler.ts`).
- Mid‑2026 sources: A2A v1.0 (a2a-protocol.org), AG‑UI 17 events / `StateDelta` (docs.ag-ui.com), AAIF (linuxfoundation.org), Liveblocks/PartyKit/tldraw/Figma multiplayer, Yjs/Automerge 3/Loro CRDTs, Temporal/Restate/Inngest/DBOS/LangGraph durable execution, Langfuse/LangSmith collaborative observability. Full cited scan: `scratchpad/collab-soa-report.md`.
