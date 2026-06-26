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

### Phase 1 — Presence (highest‑value missing capability) · C4  ✅ delivered
**Goal:** "who else is here" on every run/chat — the multiplayer baseline weaveIntel completely lacks.
- `run_presence` table (7.1) + `PresenceManager` (heartbeat upsert, TTL sweep). `POST /api/me/runs/:id/presence` (heartbeat) + a sweeper job; broadcast `presence.update` over the existing `SseSubscriber` fan‑out.
- New run‑event kind `presence.update`; extend the **client reducer** with `vm.presence` (active participants + state), mirroring the Phase 7 `file.part`/`object.delta` additions. Surface in `createRunSession`.
- Config from `collaboration_config` (heartbeat/ttl/sweep), DB‑driven like `run_stream_config`.
- **Acceptance:** two browser sessions on the same run see each other's presence appear/expire (heartbeat+TTL) in real time via Playwright; presence reconstructs in `vm.presence`; survives one client disconnect (TTL reaps it). Tested across direct/agent/supervisor/ensemble.

**What shipped (research‑anchored on the Yjs awareness protocol + Liveblocks AI‑presence):**
- **core** — `presence.update` run‑event kind + `RunPresenceParticipant`/`RunPresenceSnapshot` payloads. Presence is a **snapshot** (full participant list, idempotent + gap‑safe over SSE), carries `sequence: -1`, and is **ephemeral** (never journaled).
- **`@weaveintel/collaboration`** — `PresenceManager` PORT + in‑memory reference adapter + `presenceManagerContract` (its first durable‑pattern multiplayer primitive). Heartbeat 15s / TTL 30s (TTL = 2× heartbeat → one missed beat never drops a peer). 14 unit tests.
- **geneWeave** — `m94` `run_presence` (current‑state, UPSERT/DELETE, FK to `user_runs`, tenant column) + `collaboration_config` (DB‑driven cadence). `SqlPresenceManager` passes the **same** `presenceManagerContract` as the in‑memory adapter (11 tests). `POST/GET /api/me/runs/:id/presence` (heartbeat/leave/list) + `GET /api/me/collab/config`. Ephemeral `broadcastEphemeral` (presence fans out without journaling); a presence **snapshot on subscribe**; a TTL **sweeper** (`startPresenceSweeper`, `unref`’d). **Agent‑as‑peer**: `withAgentPeer` synthesizes the agent as a `working` participant while the run is `running` — no extra writes, no lifecycle coupling. Identity is **server‑derived** (anti‑spoof); displayName length‑capped, no PII.
- **`@weaveintel/client`** — `vm.presence` in the reducer (the `presence.update` snapshot bypasses the journal sequence dedup); `createRunSession.setPresence()` + `RunClient.setPresence()` heartbeat helpers. 6 unit tests.
- **Real‑LLM e2e** (`run-presence-phase1.e2e.ts`): heartbeat makes the human (and the running agent) appear live in `vm.presence` across direct/agent/supervisor/ensemble; explicit leave removes them; presence is ownership/tenant isolated (a different user → 404); `/collab/config` serves the cadence; web‑UI regression.

**Scope note:** Phase 1 runs are single‑owner, so genuine MULTI‑USER presence on one run (two different humans) arrives with **Phase 2** (shared sessions grant a second user access). Phase 1's "second participant" is the **agent peer**, which exercises the full multi‑participant snapshot/broadcast mechanism. TTL expiry + sweep are covered deterministically by the unit/contract tests (clock‑injected).

### Phase 2 — Shared sessions + invite links · C5  ✅ delivered
**Goal:** multi‑user shared runs/chats with roles.
- `shared_sessions` + `session_participants` (7.2) + `SessionManager`; share‑token route (reuse the artifact share‑token pattern). Roles gate write vs view. Presence (Phase 1) scopes to a session.
- Client: `useRun`/`createRunSession` accept a `sessionId`; the reducer exposes participants+roles.
- **Acceptance:** an owner shares a run via link; a second user joins as viewer, sees live output + presence, cannot send control events; roles enforced server‑side. Playwright multi‑context test.

**What shipped (research‑anchored on Google/Notion/Figma/Liveblocks + W3C capability‑URL guidance):**
- **`@weaveintel/collaboration`** — `SessionManager` PORT + in‑memory adapter + `sessionManagerContract`. Roles `owner` ⊃ `collaborator` ⊃ `viewer` (`roleAtLeast`); idempotent join keeps the higher role ("highest permission wins"); owner‑only manage/end. 15 unit tests.
- **geneWeave** — `m95`: `shared_sessions` + `session_participants` (`UNIQUE(session,user)` idempotent membership) + `session_share_tokens` (invite links). `SqlSessionManager` passes the **same** `sessionManagerContract` (14 tests). **`resolveRunAccess`** — the single authorization chokepoint (owner → `owner`; participant → their role; else `null`=404). Endpoints: `POST /runs/:id/share` (owner mints a token), `POST /sessions/join` (authenticated join), `GET /runs/:id/session`, `POST /runs/:id/share/revoke`. Every run route is **re‑gated by role**: read SSE/presence = any participant; post control events = collaborator+; **cancel/share = owner only**. Presence snapshots are **badged with each participant's role**.
- **Security (mid‑2026 research):** invite token = **256‑bit CSPRNG, SHA‑256‑hashed at rest** (plaintext shown once); **identity server‑derived** (anti‑spoof); **tenant gate before role logic**; uniform rejection on bad/expired/revoked token (no enumeration); owner can never mint an owner link; revocation supported.
- **`@weaveintel/client`** — `RunClient.shareRun()` / `joinSession()`; the `presence.update` snapshot now carries each participant's `role` (the reducer "exposes participants + roles" via `vm.presence`).
- **Real‑LLM e2e** (`run-shared-session-phase2.e2e.ts`): owner shares → a SECOND real user joins as viewer → **two humans present, badged owner/viewer** (the genuine multi‑user presence Phase 1 set up) → the viewer can read but is **403'd on control events + cancel**; a collaborator can post events but not cancel; a non‑participant gets 404, an invalid token is rejected. Across direct/agent/supervisor/ensemble + web‑UI regression.

**CVE‑2026‑53843 — FIXED (Phase 3).** Revoking a *connected* viewer mid‑stream now force‑closes their SSE socket immediately. `SseSubscriber` carries the server‑derived `userId`; `MeRunExecutor.disconnectUnauthorized(runId, stillHasAccess)` emits a terminal `access.revoked` ephemeral event and ends every now‑unauthorized stream. Called by `POST /runs/:id/members/remove` (owner removes a member) and `POST /runs/:id/share/end` (owner ends sharing); the SSE route ALSO re‑runs `resolveRunAccess` on every keepalive tick (defense in depth — closes any revocation path, incl. cross‑process). The client treats `access.revoked` as terminal (stops reconnecting, sets `vm.accessRevoked`). Proven end‑to‑end by `run-subscriptions-phase3.e2e.ts` (guest joins → attaches live stream → owner removes → guest stream force‑closed) + 3 executor unit tests (`cve-2026-53843.test.ts`).

### Phase 3 — Durable subscriptions + offline notifications · C3  ✅ delivered
**Goal:** subscribe to a run and get notified even when not watching.
- `run_subscriptions` table (7.3); on terminal journal events, the registry emits onto core `EventBus`; `@weaveintel/notifications` `bindRunNotifications` (already exists) dispatches in‑app/email/webhook.
- Replace the volatile in‑memory subscriber list semantics for *notification routing* (keep `SseSubscriber` for live streaming).
- **Acceptance:** a user subscribes, closes the tab, the run completes → a notification is delivered (in‑app row + webhook fired). Cross‑process/restart‑safe. Real‑LLM run.

**What shipped (research‑anchored on the transactional‑outbox pattern — Temporal/Restate/DBOS — + the Standard Webhooks spec + CloudEvents 1.0):**
- **`@weaveintel/collaboration`** — durable `SubscriptionManager` PORT + in‑memory adapter + `subscriptionManagerContract`. `subscribe`/`unsubscribe`/`isSubscribed`/`get`/`listSubscribers`/`listForUser`; `inapp` channel always implied; idempotent per (run, user). 11 unit tests. (The legacy `RunSubscriptionManager` prototype is kept, re‑exported as `LegacyRunSubscription`.)
- **`@weaveintel/notifications`** — in‑app **`NotificationFeedStore`** PORT + in‑memory adapter + `notificationFeedStoreContract`, and **`createInAppChannel`** (a `NotificationChannel` that writes the feed via the SAME dispatcher fan‑out + suppression). Fan‑out‑on‑write, dedupe per principal, mark‑read / mark‑all‑read. 13 unit tests.
- **geneWeave** — `m96`: `run_subscriptions` + `notification_feed` (dedupe partial‑unique index) + `notification_outbox` (leased, crash‑safe) + `webhook_endpoints` (registered, per‑endpoint signing secret) + relay cadence/retry columns on `collaboration_config`. SQL `SubscriptionManager` + `FeedStore` pass the **same** contracts. The **transactional outbox**: on a NEW terminal event (`MeRunExecutor.onTerminal`) one outbox row is enqueued per subscriber; `createNotificationRelay` drains on a leased loop — writes the in‑app feed row + fires signed webhooks — marking each `sent`, with exponential‑backoff‑plus‑jitter retry and a dead‑letter after the budget. A startup **reconciler** backfills any terminal run whose outbox row was never written (crash between terminal + enqueue) and re‑drains pending rows (restart‑safe). Endpoints: `POST /runs/:id/subscribe` · `/unsubscribe` · `GET /runs/:id/subscription`, `GET /notifications` (+ unread badge) · `POST /notifications/:id/read` · `/notifications/read-all`, `POST /webhooks` · `GET /webhooks` · `POST /webhooks/:id/revoke`. Late‑subscribe to an already‑terminal run enqueues immediately (no lost edge).
- **Security (mid‑2026 research):** webhooks are **HMAC‑SHA256 signed per Standard Webhooks** (`webhook-id`/`webhook-timestamp`/`webhook-signature = v1,…`), CloudEvents‑shaped, sent only to **registered** endpoints over the **SSRF‑hardened fetch** (https‑only + private/loopback/link‑local/cloud‑metadata blocked at registration AND validated at dial time, redirects disabled). At‑least‑once + stable idempotency key + feed dedupe = effectively‑once. The feed is strictly per‑principal; deep links are opaque `geneweave://run/<id>` (no tenant/principal ids). Outbox + feed + subscriptions are tenant‑isolated by construction. 19 SQL/outbox unit tests (incl. retry→dead‑letter, lease‑reclaim, reconcile backfill, SSRF guard, signature).
- **`@weaveintel/client`** — `RunClient.subscribeRun()` / `unsubscribeRun()` / `getSubscription()` / `listNotifications()` / `markAllNotificationsRead()`.
- **Real‑LLM e2e** (`run-subscriptions-phase3.e2e.ts`, 8/8): subscribe → **close the tab (drop the stream)** → run completes → a durable in‑app notification arrives offline, across **direct/agent/supervisor/ensemble**; late‑subscribe still notifies; the CVE force‑disconnect; security (stranger 404 on subscribe, per‑principal feed isolation); web‑UI regression.

### Phase 4 — Collaborative run timeline: comments & annotations · C7  ✅ delivered
**Goal:** Google‑Docs‑grade review on a run.
- `run_comments` (anchored to a journal `sequence`/reducer `part id`) + `run_annotations` (score/rubric → `@weaveintel/evals` datasets). `@mentions` via notifications. Public view‑only share link (reuse 7.2 tokens).
- Client: render comments anchored to parts in the reducer's `parts[]`/timeline.
- **Acceptance:** a reviewer comments on a specific tool/step part of a finished run; an @mention notifies; an annotation with a score lands in an eval dataset; a public link renders read‑only. Playwright.

**What shipped (research‑anchored on Notion block comments + W3C Web Annotation `TextQuoteSelector` + the cross‑vendor LangSmith/Langfuse score schema + W3C Capability URLs):**
- **`@weaveintel/collaboration`** — `CommentManager` PORT + in‑memory adapter + `commentManagerContract`, and `AnnotationManager` PORT + in‑memory adapter + `annotationManagerContract`. Comments anchor to a **stable part id** (never an offset) with a staleness `seq` + optional fuzzy quote sub‑range; two‑level threads; **thread‑level resolve**; **soft‑delete tombstones** (replies preserved); author‑only edit/delete (moderator force). `renderCommentMarkdown` renders markdown to **safe html** (escape‑then‑allowlist — no raw HTML / `javascript:` survives). Annotations carry the `{name, value, stringValue, comment, source, dataType}` score schema (booleans normalise 1/0); `summarizeAnnotations` + `annotationsToEvalExamples` are the evals bridge. 32 unit tests.
- **geneWeave** — `m97`: `run_comments` + `run_annotations` + `run_public_shares`. SQL `CommentManager`/`AnnotationManager` pass the **same** contracts (16 tests). Endpoints (every one re‑gated by `resolveRunAccess`): `POST/GET /runs/:id/comments`, `POST /comments/:id/edit|delete`, `POST /threads/:id/resolve|reopen`, `POST/GET /runs/:id/annotations`, `POST /annotations/:id/delete`, `GET /annotations/export`, `POST /runs/:id/public-share|public-share/revoke`. New comments/edits/resolves broadcast **ephemeral** (`sequence:-1`) `comment.*` events so live viewers see review appear; the client reducer collects them into `vm.comments` anchored by part id.
- **@mentions** reuse Phase 3: a mention is validated against run access (mention of a non‑participant is dropped — fail closed, capped at 20 anti‑bomb) then delivered as an in‑app feed notification (`category:'mention'`).
- **Public read‑only share** — a new `/share/runs/:token` route (unauthenticated, GET‑only): resolves a 256‑bit hashed capability token, renders a **redacted** view (assistant output + comments + score summary; **display names only**, no emails/ids/system‑prompts/tool‑args), `X‑Robots‑Tag: noindex` + `Referrer‑Policy: no‑referrer`; expired/revoked → 404.
- **Security (mid‑2026 research):** object‑level authz on every comment/annotation id (must belong to the run); write‑field allowlist (clients can never set author/tenant/resolved/anchor); markdown sanitized server‑side; tenant‑isolated tables; only the OWNER mints/revokes public links.
- **`@weaveintel/client`** — `addComment`/`listComments`/`editComment`/`deleteComment`/`resolveThread`/`reopenThread`/`addAnnotation`/`listAnnotations`/`createRunPublicShare`; `vm.comments` updated live from the ephemeral `comment.*` stream.
- **Real‑LLM e2e** (`run-comments-phase4.e2e.ts`, 8/8): a reviewer comments on a part + @mentions the owner (who is notified) + scores it (summary average), across **direct/agent/supervisor/ensemble**; resolve/reopen + author‑only edit + XSS sanitized; the public link renders redacted + `noindex` and 404s after revoke; a non‑participant cannot comment/annotate (404); web‑UI regression.

### Phase 5 — Unified handoff (user ↔ user, agent ↔ user) · C6  ✅ delivered
**Goal:** one handoff model with context transfer + audit, reconciled across the three existing scopes.
- `session_handoffs` table (7.4); `HandoffManager` over it. Human side built on `@weaveintel/human-tasks` + `hitl_interrupt_requests` (Client Phase 4); agent side delegates to `@weaveintel/a2a` (A2A v1.0 context transfer + signed cards). **Persist the reject reason.** Audit every transition.
- **Acceptance:** an agent run escalates to a human (HITL handoff) who accepts, takes over the session, and hands back — full context + audit trail persisted; a rejected handoff records its reason. Across modes.

**What shipped (research‑anchored on OpenAI Agents SDK handoffs + LangGraph interrupts + A2A v1.0 task lifecycle + EU AI Act Art. 12/14):**
- **`@weaveintel/collaboration`** — `UnifiedHandoffManager` PORT + in‑memory adapter + `handoffManagerContract`. **One explicit state machine** for all three scopes (`requested → accepted/rejected → in_progress → handed_back → completed`, plus `cancelled/failed/timed_out`), mapped onto A2A's interruptible‑vs‑terminal split; `canTransition` guards every move. `rejected` is first‑class and **requires a reason**. Context travels as a **scoped `HandoffBriefing`** (summary/decisions/openQuestions/nextAction/artifacts/confidence — NOT the raw transcript). **Anti‑loop** `depth` cap; **SLA** `expireDue`. Authorization is by ACTOR (recipient accepts/rejects/starts/hands‑back; requester cancels). 16 unit tests.
- **geneWeave** — `m98`: `session_handoffs` + append‑only `handoff_events` (one row per transition — EU AI Act Art. 12 defensible; ordered by insertion `rowid`). SQL `UnifiedHandoffManager` passes the **same** contract (14 tests). `buildRunBriefing` builds the scoped context from a run (bounded summary, never the transcript). Endpoints: `POST /runs/:id/handoff` (request, auto‑brief), `GET /runs/:id/handoffs` + `/:hid/audit`, `GET /handoffs/inbox`, and the 7 transitions `POST /runs/:id/handoffs/:hid/{accept,reject,cancel,start,hand-back,complete,fail}`. **Accepting grants the recipient collaborator access** to the run's shared session (Phase 2) — that is "taking over". Each transition notifies the other party (Phase 3 in‑app feed, `category:'handoff'`) and broadcasts an **ephemeral** `handoff.update` so watchers see it live; the client reducer collects them into `vm.handoffs`. A `startHandoffSweeper` times out overdue handoffs (Temporal HITL pattern).
- **Security (mid‑2026 research):** you cannot hand off a run you cannot see (404); only the recipient can accept/reject (403 otherwise — proven in e2e); a reason is required to request AND to reject; recipient existence is checked (no ghost‑user leak); the briefing is scoped; anti‑loop depth caps runaway delegation; tenant‑isolated tables.
- **`@weaveintel/client`** — `requestHandoff`/`listHandoffs`/`handoffAudit`/`handoffInbox`/`handoffAction`; `vm.handoffs` updated live from the ephemeral `handoff.update` stream.
- **Real‑LLM e2e** (`run-handoff-phase5.e2e.ts`, 7/7): an `agent_to_human` escalation → the reviewer (no access yet) sees it in their inbox + is notified → **accepts → takes over** (gains access, posts a collaborator comment) → starts → **hands back** with a briefing → owner **completes**, with the full **audit trail** `[requested, accepted, in_progress, handed_back, completed]` persisted — across **direct/agent/supervisor/ensemble**; a rejected handoff records its reason (audited); security (stranger 403 on accept, 404 on request for an unseen run, reason required); web‑UI regression.

**Note on agent↔agent:** A2A v1.0 has **no protocol‑level "transfer" verb** (delegation is client‑orchestrated), so this lifecycle IS the accept/reject negotiation layer A2A leaves to the host; `agent_to_agent` handoffs carry `referenceTaskIds` for wire interop.

### Phase 6 — Real‑time transport hardening + AG‑UI/A2A standards · C8/C10  ✅ delivered
**Goal:** control‑plane realtime + standards alignment.
- Share one `parseSseStream`/`EventTransport` (promote from client to `core`; retire the a2a copy). Optional WebSocket control channel (reuse `@weaveintel/voice` WS patterns) for presence + cancel/steer with resume‑beyond‑reload.
- Extend `toAGUIEvents` (client Phase 7) to emit **presence** + `StateDelta` (RFC 6902) events; expose handoff via A2A.
- **Acceptance:** presence + control signals survive a tab switch (not just reload); an AG‑UI client consumes a run *with* presence/state events; the duplicate SSE parser is deleted.

**What shipped (research‑anchored on the AG‑UI event spec, A2A v1.0 streaming, RFC 6902/6901, WHATWG SSE, and the OWASP WebSocket cheat sheet):**
- **`@weaveintel/core`** — the transport is now consolidated: the canonical SSE **writer** (`formatSseFrame`/`writeSseFrame`/`writeSseComment`/`SSE_RESPONSE_HEADERS`/`resolveResumeCursor`) joins the already‑shared **reader** (`parseSseStream`, which the a2a + client copies were folded into back in Phase 0 — there is now ONE byte decoder AND one frame writer). The reader now also surfaces `id:` (for `Last‑Event‑ID`). Plus **JSON Patch (RFC 6902) + JSON Pointer (RFC 6901)** — `applyJsonPatch` (atomic — a failed op rejects the whole batch so a client re‑snapshots, never half‑applies) + `diffJsonPatch`. 42 unit tests (round‑trip diff↔apply, atomicity, immutability, Last‑Event‑ID precedence, writer↔reader round‑trip).
- **`@weaveintel/client`** — `toAGUIEvents` now emits the multiplayer signals the AG‑UI‑conformant way: a one‑time `STATE_SNAPSHOT` of the shared state `{ status, presence, comments, handoffs }`, then a `STATE_DELTA` (a real RFC 6902 JSON Patch) on each change, **plus** a `CUSTOM` event per raw signal (`name: presence|handoff|comment|access.revoked`). A plain run is byte‑identical to before (snapshot is lazy). New `createRunControlChannel` — the bidirectional control‑channel client (cancel/steer/presence, idempotent via `requestId`, transport‑agnostic via an injected `WebSocketImpl`). 18 unit tests.
- **geneWeave** — the run SSE route is now **resumable via the standard `Last‑Event‑ID` header** (precedence: header → `?after` → start), every journaled event is written with `id: <sequence>` through the core writer, and a `retry:` hint is sent. A new **WebSocket control channel** `/api/me/runs/:id/control`: single‑use **ticket** auth (never a cookie), **Origin allowlist (CSWSH defense)** on the handshake, a `state.snapshot` on every (re)connect (**resume‑beyond‑reload** — survives a tab switch), app‑level ping/pong heartbeat, a 16 KB max‑message guard, and **idempotent** cancel/steer/presence (a duplicate `requestId` is acked but never re‑actioned — fixed a real same‑millisecond race by reserving the id synchronously). Role‑gated: owner cancels, collaborator+ steers, any participant heartbeats presence; access is re‑checked per message (TOCTOU‑safe).
- **Security (mid‑2026 research):** Origin checked on the WS handshake (the primary CSWSH defense); identity is server‑derived from the ticket, never trusted from the client; control messages carry a `requestId` for safe retries; max message size (close 1009); presence/cancel/steer all role‑gated through `resolveRunAccess`.
- **Real‑LLM e2e** (`run-realtime-phase6.e2e.ts`, 9/9): an AG‑UI client consumes a real run **with** presence as `STATE_SNAPSHOT` + `STATE_DELTA` (valid JSON Patch) + `CUSTOM` across **direct/agent/supervisor/ensemble**; the WS channel sends a `state.snapshot` on connect, cancels a live run idempotently (same `requestId` twice → one cancel + one `duplicate` ack), and re‑sends a fresh snapshot on reconnect (tab‑switch resume); a collaborator steers but a viewer cannot cancel; SSE resumes gap‑free from `Last‑Event‑ID`; a cross‑site Origin is rejected (403) and a missing ticket is rejected; web‑UI regression.

### Phase 7 — CRDT shared state / agent‑as‑peer (optional, frontier) · C9  ✅ delivered
**Goal:** collaborative co‑editing of artifacts/canvas with the agent as a peer.
- New optional `@weaveintel/coedit` (Yjs or Loro) — shared doc CRDT + awareness; the agent is a server‑side replica streaming into relative‑position‑anchored rich text; HITL "agent‑as‑suggester" fallback. Persist snapshots; reuse `@weaveintel/artifacts` for storage.
- **Acceptance:** a human and the agent co‑edit one artifact concurrently with convergent merge + awareness cursors; offline edits reconcile. (Optional / spike‑first.)

**What shipped (research‑anchored on the Kleppmann/Gomes RGA Isabelle proof + Sypytkowski's reference impl + the Yjs awareness protocol + the agent‑as‑CRDT‑peer pattern):** built a **zero‑dependency RGA** rather than pulling in Yjs/Loro — the simplest *provably convergent* sequence CRDT (what Automerge ships), so it is fully owned + testable.
- **`@weaveintel/coedit`** (new package) — `RgaDoc`: insert‑after‑reference, **descending‑id sibling order** (the one rule that makes it converge), tombstones, causal buffering, idempotency by unique per‑op id. `stateVector()`/`opsSince()` for **state‑vector diff offline sync**; `snapshot()`/`fromSnapshot()` for persistence. `Awareness`: ephemeral cursors as **relative positions** (anchored to a char id, not an offset, so they survive concurrent edits), last‑write‑wins per peer, 30s TTL. `createAgentPeer` (direct *or* HITL `suggest` mode). `validateClientOps` (the trusted‑relay validator: anti‑forgery namespace check + size/flood caps). **34 unit tests** incl. a **fuzz convergence** proof (N replicas × random concurrent ops, applied in shuffled order, all converge) + permutation order‑independence + offline reconcile + the subtle delete‑sync fix (a delete carries its own author opId, never the target's, or it gets filtered out of an offline sync).
- **geneWeave** — `m99`: `coedit_docs` (full RGA snapshot + state vector + `agent_written` for idempotent agent streaming) + `coedit_ops` (append‑only op log for diff sync). `coedit-sql.ts` is the **TRUSTED RELAY**: it holds the canonical replica, validates every edit, applies + persists + appends to the op log, and returns the ops to broadcast. Endpoints: `POST/GET /runs/:id/coedit`, `POST /coedit/ops`, `GET /coedit/ops?since=<vector>`, `POST /coedit/awareness`, `POST /coedit/agent-sync`. New co‑edit ops broadcast **ephemerally** (`coedit.op`/`coedit.awareness`) over the run SSE stream. The **agent co‑edits as a server‑side peer**: on terminal (and on demand) the run's output is merged into the doc under the agent site id — concurrently with human edits, converging automatically.
- **Security (mid‑2026 research — CRDTs are NOT Byzantine‑tolerant):** the server is the single authority; a user edits under a server‑derived **site namespace** (`u:<userId>`) with a unique device site per tab, so replicas stay distinct yet **no peer can forge an op as another user**; ops are shape/size/flood validated; only collaborator+ may edit (viewers 403); tenant‑scoped.
- **`@weaveintel/client`** — `coeditEnsure`/`coeditGet`/`coeditSubmitOps`/`coeditOpsSince`/`coeditAwareness`/`coeditAgentSync`.
- **Real‑LLM e2e** (`run-coedit-phase7.e2e.ts`, 8/8): a human types a heading into a local CRDT replica while the **agent's real LLM output is merged in as a peer**, the server converges them, and an **independent replica reconstructs byte‑identical text** — across **direct/agent/supervisor/ensemble**; two humans + the agent all converge through the relay; an **offline** device reconciles via the state‑vector diff; awareness cursors broadcast; security (forged site rejected, viewer 403, stranger 404); web‑UI regression.

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
