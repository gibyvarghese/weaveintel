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
| `createSharedSessionManager()` | A shared "room": participants with roles (owner / collaborator / viewer) and a **presence** state (`online`, `idle`, `typing`, `away`, `offline`). |
| `createRunSubscriptionManager()` | Track who is **subscribed** to a run and broadcast status/progress changes to all of them. |
| `createHandoffManager()` | The **handoff** lifecycle — request → accept / reject / cancel / complete — for passing a session from one user to another. |

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

The managers here are **in-memory prototypes** — single-process, not yet durable,
no real-time transport wired. They are the foundation for the phased
**`COLLABORATION_PACKAGE_REVIEW_AND_ROADMAP_2026.md`** plan, which adds the
durable, DB-backed, real-time versions:

- **Phase 1** — Presence persisted (`run_presence` table) + broadcast over SSE.
- **Phase 2** — Shared sessions + invite links (`shared_sessions`).
- **Phase 3** — Durable subscriptions + offline notifications.
- **Phase 4** — Collaborative run comments / annotations.
- **Phase 5** — Unified handoff (built on `@weaveintel/human-tasks` + `@weaveintel/a2a`).

Related packages: agent↔agent handoff lives in `@weaveintel/a2a`; in-process
agent handoff in `@weaveintel/agents`; human-in-the-loop queues in
`@weaveintel/human-tasks`.
