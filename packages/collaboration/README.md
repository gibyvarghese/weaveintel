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
| `createSharedSessionManager()` | A shared "room": participants with roles (owner / collaborator / viewer) and a presence state. |
| `createRunSubscriptionManager()` | Track who is **subscribed** to a run and broadcast status/progress changes to all of them. |
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

```ts
import { createSharedSessionManager } from '@weaveintel/collaboration';

const sessions = createSharedSessionManager();
const room = sessions.create('Design review', 'alice');
sessions.join(room.id, { userId: 'bob', displayName: 'Bob', role: 'collaborator' });
sessions.updatePresence(room.id, 'bob', 'typing');
```

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
- **Phase 2** — Shared sessions + invite links (`shared_sessions`).
- **Phase 3** — Durable subscriptions + offline notifications.
- **Phase 4** — Collaborative run comments / annotations.
- **Phase 5** — Unified handoff (built on `@weaveintel/human-tasks` + `@weaveintel/a2a`).

Related packages: agent↔agent handoff lives in `@weaveintel/a2a`; in-process
agent handoff in `@weaveintel/agents`; human-in-the-loop queues in
`@weaveintel/human-tasks`.
