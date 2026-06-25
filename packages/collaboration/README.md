# @weaveintel/collaboration

**Multiplayer primitives for AI apps** — shared sessions, presence ("who else is
here"), live run subscriptions, and user handoff.

> New to this? "Collaboration" here means **more than one person (or agent)
> working on the same thing at the same time** — like seeing other people's
> cursors in a shared doc, or handing a conversation off to a teammate. This
> package holds the small building blocks for that.

## What's in the box

| Primitive | What it does |
|---|---|
| `createInMemoryPresenceManager()` | **Presence** ("who else is here"): a heartbeat-driven, TTL-expiring set of participants watching a run. The PORT + an in-memory reference adapter; geneWeave provides a SQL adapter over `run_presence`. Both pass `presenceManagerContract`. |
| `createInMemorySessionManager()` | **Shared sessions** (Phase 2): turn a single-owner run into a multi-user one — members join with a **role** (owner / collaborator / viewer). The PORT + in-memory adapter; geneWeave's SQL adapter + invite-link tokens layer on top. Both pass `sessionManagerContract`. |
| `createSharedSessionManager()` | (legacy in-memory prototype) a shared "room" with presence state. |
| `createInMemorySubscriptionManager()` | **Durable subscriptions** (Phase 3): "notify me when this run finishes, even if I close the tab." The PORT + in-memory adapter; geneWeave's SQL adapter (over `run_subscriptions`) makes it survive restarts. Both pass `subscriptionManagerContract`. Delivery is `@weaveintel/notifications`' job — this only records WHO is interested and over WHICH channels. |
| `createRunSubscriptionManager()` | (legacy in-memory prototype) live status/progress broadcast room — superseded by the durable `SubscriptionManager` above. |
| `createHandoffManager()` | The **handoff** lifecycle — request → accept / reject / cancel / complete — for passing a session from one user to another. |

### Presence (Phase 1) — how it works

> New to this? Presence is the little row of avatars showing who's viewing a
> shared thing. Each viewer sends a tiny "still here" ping (a **heartbeat**) every
> ~15s. If the pings stop for ~30s (closed tab, lost wifi), they're removed. That
> ratio — **TTL = 2× heartbeat** — means one missed ping never makes someone
> flicker out. AI **agents are first-class peers**: while a run is producing
> output, the agent shows up as present with a `working` status.

```ts
import { createInMemoryPresenceManager } from '@weaveintel/collaboration';

const presence = createInMemoryPresenceManager({ ttlMs: 30_000 });
await presence.heartbeat({ runId, tenantId }, { userId: 'alice', displayName: 'Alice', presence: 'online' });
const who = await presence.list({ runId, tenantId }); // [{ userId: 'alice', presence: 'online', peerType: 'human' }]
```

Design (mid-2026 research, anchored on the Yjs awareness protocol): **snapshot,
not delta** (each `presence.update` is the full participant list — idempotent and
gap-safe over SSE), **ephemeral** (a current-state table, never the durable run
journal), and **server-derived identity** (the user id comes from auth, never the
client — so presence can't be spoofed).

### Shared sessions + invite links (Phase 2) — how it works

> New to this? It's exactly Google-Docs sharing, for a live AI run. The owner
> clicks "share", picks a level (**view** or **edit**), and sends a link. Whoever
> opens it gets *exactly* that level — a **viewer** can watch, a **collaborator**
> can also send input, and only the **owner** can cancel the run or manage
> sharing. The rule that matters: the "manage/share" power is its own top tier —
> editing does not grant sharing.

```ts
import { createInMemorySessionManager } from '@weaveintel/collaboration';

const sessions = createInMemorySessionManager();
const s = await sessions.createSession({ id, runId, tenantId, ownerId });
await sessions.join(s.id, 'bob', 'viewer');     // join via link → membership row
await sessions.getRole(s.id, 'bob');            // 'viewer' — used to gate every request
```

Security model (mid-2026 research — Google/Notion/Figma/Liveblocks + W3C
capability-URL guidance): invite **tokens are 256-bit random and SHA-256-hashed
at rest** (the plaintext is shown once, never stored); **identity is
server-derived** (no spoofing); the **tenant gate runs before role logic** on
every request; membership is a table with `UNIQUE(session, user)` so **joining
twice is idempotent**; and **role is enforced server-side on every endpoint** —
the client's claimed role is never trusted. Only the **owner** holds the
share/cancel capability (the Notion "Full access vs Can edit" split).

```ts
import { createSharedSessionManager } from '@weaveintel/collaboration';

const sessions = createSharedSessionManager();
const room = sessions.create('Design review', 'alice');
sessions.join(room.id, { userId: 'bob', displayName: 'Bob', role: 'collaborator' });
sessions.updatePresence(room.id, 'bob', 'typing');
```

> **Security note (CVE-2026-53843).** An SSE read stream is authorized once, at
> connect. So when you remove someone from a shared run (or end sharing),
> geneWeave **force-closes their live stream immediately** (an `access.revoked`
> event) AND re-checks access on every keepalive tick — a removed viewer can
> neither act nor keep watching. Fixed end-to-end in Phase 3.

### Durable subscriptions + offline notifications (Phase 3) — how it works

> New to this? Presence (Phase 1) is "who's watching RIGHT NOW" and vanishes when
> you leave. A **subscription** is the opposite: you click "Notify me", close the
> tab, and later — when the run finishes — you get a notification (a 🔔 inbox
> entry, and optionally a webhook/push). It has to survive the server restarting,
> because a notification you're owed must not live only in memory.

```ts
import { createInMemorySubscriptionManager } from '@weaveintel/collaboration';

const subs = createInMemorySubscriptionManager();
await subs.subscribe({ runId, tenantId, userId: 'alice', channels: ['inapp', 'webhook'] });
await subs.listSubscribers(runId); // [{ userId: 'alice', channels: ['inapp','webhook'], ... }]
```

How geneWeave makes it reliable (mid-2026 research — the **transactional outbox**
pattern from Temporal/Restate/DBOS + the **Standard Webhooks** spec): the moment a
run reaches a terminal state, one durable `notification_outbox` row is written per
subscriber **in the database**. A leased relay then drains those rows — writing
the in-app feed entry (`@weaveintel/notifications`' `NotificationFeedStore`) and
firing signed webhooks — and only marks each `sent` once delivery succeeds. If the
process crashes mid-send, the row is still there on restart and is retried
(at-least-once); a stable idempotency key + the feed's dedupe collapse any
duplicate (effectively-once). Webhooks are HMAC-signed per Standard Webhooks
(`webhook-id`/`webhook-timestamp`/`webhook-signature`), CloudEvents-shaped, sent
only to **registered** endpoints over the SSRF-hardened fetch (private/link-local
ranges blocked, validated at dial time).

## What this package is NOT (read this first)

It is **not** where runs are stored or streamed. In **Collaboration Phase 0** the
*run-lifecycle substrate* — the **run registry** (what runs exist and their
status) and the **run journal** (the append-only, resumable log of run events) —
**moved to `@weaveintel/core`**, because:

1. Those are run-platform plumbing, not a "collaboration" concern, and
2. their vocabulary (`RunHandle`, `RunEventEnvelope`) already lives in core, and
3. geneWeave already implements them in SQL.

So there's now **one** registry/journal contract with two interchangeable
backends (a KV reference adapter in core, a SQL adapter in geneWeave) — no more
duplicate implementations.

**Need a run registry or journal?** Import from core instead:

```ts
import { createKvRunRegistry, createKvRunJournal } from '@weaveintel/core';
```

## Status & roadmap

**Presence is shipped (Phase 1)** — durable (`run_presence` table in geneWeave),
heartbeat/TTL-driven, broadcast live over SSE as `presence.update`, reconstructed
in `@weaveintel/client`'s `vm.presence`. The session/subscription/handoff managers
are still **in-memory prototypes** that later phases make durable. See
**`COLLABORATION_PACKAGE_REVIEW_AND_ROADMAP_2026.md`**:

- **Phase 1 ✅** — Presence persisted (`run_presence`) + SSE broadcast + agent-as-peer.
- **Phase 2 ✅** — Shared sessions + invite links (`shared_sessions`/`session_participants`) + role-gated multi-user access.
- **Phase 3 ✅** — Durable subscriptions (`run_subscriptions`) + offline notifications (transactional `notification_outbox` → in-app feed + signed webhooks), restart-safe. Plus the CVE-2026-53843 force-disconnect.
- **Phase 4** — Collaborative run comments / annotations.
- **Phase 5** — Unified handoff (built on `@weaveintel/human-tasks` + `@weaveintel/a2a`).

Related packages: agent↔agent handoff lives in `@weaveintel/a2a`; in-process
agent handoff in `@weaveintel/agents`; human-in-the-loop queues in
`@weaveintel/human-tasks`.
