# @weaveintel/collab

**One package for real-time collaboration in AI apps** — co-edit a document with other people
*and* the AI agent, see who's here, share and hand off live work. Tiny, zero-dependency, and built
so the co-editing **engine is swappable**.

> New to this? "Collaboration" here means more than one person — or a person and an AI — working on
> the same thing at the same time: seeing each other's cursors in a shared document, a run you both
> watch live, handing a task to a teammate. This package holds the small, proven building blocks for
> all of that. It merges what used to be two packages (`coedit` + `collaboration`) into one.

## Why it exists (the story)

Two people typing into the same paragraph at the same moment is a genuinely hard problem: naïvely,
"insert at position 5" means something different on each screen the instant the other person types, so
the copies drift apart. The fix is a **CRDT** (Conflict-free Replicated Data Type) — the maths behind
Google Docs and Figma multiplayer — where every copy always rebuilds the *identical* result with no
central lock. Add an AI agent as just another participant, and you have a document a human and a model
write together. This package gives you that, plus the surrounding multiplayer plumbing (presence,
sharing, live subscriptions, handoff) that a collaborative AI product needs.

## When to reach for it (and when not)

- **Reach for it** when a document, note, or run is edited or watched by more than one party at once —
  including the AI — and you need it to converge, show live cursors, or be shared/handed off.
- **Don't** reach for it for a single-user draft with one writer and no live sharing — plain storage is
  simpler. And you do **not** need it just to call a model; that's `@weaveintel/runtime`.
- **Already run Yjs?** You can keep it — see *Swapping the engine* below. You do not have to adopt our
  CRDT to use the presence / sharing / agent-peer parts.

## Quick start — co-edit a document

```ts
import { createRgaDoc } from '@weaveintel/collab';

// Two replicas — different people, or a person and the AI. Each has a unique site id.
const alice = createRgaDoc('alice');
const bob = createRgaDoc('bob');

const seed = alice.insert(0, 'Hello!'); // Alice types
bob.applyOps(seed);                      // …delivered to Bob

// Now they edit the SAME spot at the SAME time:
const a = alice.insert(5, ' Alice');     // "Hello Alice!"
const b = bob.insert(5, ' Bob');         // "Hello Bob!"

bob.applyOps(a);
alice.applyOps(b);

alice.text() === bob.text();             // ✅ true — both converged, nobody's edit lost
```

Only a peer is missing part of the history? Send exactly the missing bit — bandwidth-minimal, and the
same call whether they were offline for a second or a week:

```ts
const missing = alice.opsSince(bob.stateVector()); // precisely what Bob lacks
bob.applyOps(missing);                              // caught up
```

## The AI as a co-editing peer

The differentiator: the agent is just another replica. Its streamed output merges with concurrent
human edits automatically — no locking, no "the agent overwrote my paragraph".

```ts
import { createRgaDoc, createAgentPeer, agentSiteId } from '@weaveintel/collab';

const doc = createRgaDoc(agentSiteId(runId));  // a reserved agent site id
const agent = createAgentPeer(doc);            // direct co-editor
agent.append('text the model just streamed');  // merges with whatever the human is typing
```

Research note (mid-2026): a user study found people prefer the agent as a **suggester** — tracked
changes they accept — for large or overlapping edits. Pass `{ mode: 'suggest' }` and you get the ops
back **without** applying them, so your app can gate them behind a human's ✓/✕.

## Swapping the engine — the `CoeditDoc` port

Everything above talks to a small interface, **`CoeditDoc`** (`insert` / `delete` / `applyOps` /
`snapshot` / `fork` / `anchor`). The built-in RGA (`createRgaDoc`) is the **default, zero-dependency**
engine — but it is an *adapter behind the port*, not welded in. If your stack already runs
[Yjs](https://github.com/yjs/yjs), or you want a different CRDT/OT engine, you write one small adapter
and **everything else — the sync loop, the live cursors, the AI peer — keeps working unchanged.**

We do **not** add a Yjs dependency; the adapter lives in your app. To prove a swapped-in engine behaves
identically, run the shipped conformance contract against it:

```ts
import { describe, it, expect } from 'vitest';
import { coeditDocContract } from '@weaveintel/collab';
import { createYjsDoc } from './my-yjs-adapter.js';

// The exact suite the built-in RGA passes: convergence, idempotent merge,
// snapshot round-trip, state-vector deltas, fork isolation, cursor anchoring.
coeditDocContract(createYjsDoc, { describe, it, expect });
```

👉 **Full worked Yjs adapter + method-by-method map: [`docs/adapters.md`](./docs/adapters.md).**

## What's in the box

### Co-editing (the CRDT side)

| Primitive | What it does |
|---|---|
| **`CoeditDoc`** (port) + `createRgaDoc` / `fromRgaDoc` | The co-editing seam and its zero-dependency RGA reference adapter. `insert`/`delete` return ops to broadcast; `applyOps` merges; `opsSince`/`stateVector` sync; `snapshot` persists; `fork` makes a speculative shadow; `anchor`/`resolve` pin cursors. |
| `coeditDocContract` | The conformance suite **every** adapter must pass (RGA today, Yjs tomorrow) — the guarantee behind "the engine is swappable". |
| `RgaDoc` | The raw RGA text CRDT, if you want it directly. Convergent, idempotent, causal-buffered; verified against the Kleppmann/Gomes proof. |
| `Awareness` + `cursorFromIndex`/`indexFromCursor` | Ephemeral **live cursors** anchored to a character (not an integer offset), so they don't jump when others edit. Last-write-wins per peer, TTL-expired (Yjs-convention). |
| `createAgentPeer` | The **AI as a co-editing peer** — `direct` or `suggest` (human-in-the-loop) mode. |
| `peerColor` / `AI_PARTICIPANT` / `sanitizeAwarenessState` | Live-presence helpers: a stable, accessible per-peer cursor colour; the synthetic "weaveIntel AI" participant; and a strict sanitiser the server runs over incoming cursor frames (bounded + inert — presence is un-authenticated chatter). |
| `BlockDoc` (+ `pmToBlocks`, `blocksToMarkdown`/`blocksToHtml`, `validateClientBlockOps`, `diffBlocks`) | The **rich-text / block-document** CRDT on the same RGA — co-edit a *structured* note (headings, lists, to-dos, code) with inline marks, convert to/from Tiptap JSON, and diff-on-save. |
| `validateClientOps` | The trusted-relay op validator — anti-forgery (a peer can't author ops as another site), size/flood caps, shape checks. |

### Multiplayer (the session/presence side)

| Primitive | What it does |
|---|---|
| `createInMemoryPresenceManager` | **Presence** — a heartbeat-driven, TTL-expiring "who's here" set (agents are first-class peers). Port + in-memory adapter; your app supplies a SQL adapter. Snapshot-not-delta, ephemeral, server-derived identity. |
| `createInMemorySessionManager` | **Shared sessions** — turn a single-owner run multi-user with roles (owner / collaborator / viewer); invite links layer on top. |
| `createInMemorySubscriptionManager` | **Durable subscriptions** — "notify me when this finishes, even if I close the tab." |
| `createInMemoryCommentManager` / `AnnotationManager` | **Run comments** (threaded, anchored to a stable part) and **annotation scores** (the bridge to eval datasets). |
| `createInMemoryHandoffManager` | **Unified handoff** — one durable, audited lifecycle for passing the baton user↔user, agent↔human (escalation), agent↔agent. |
| `PresenceStatus` / `PeerKind` / `PeerIdentity` | The **one** shared presence vocabulary both the ephemeral (cursor) and durable (session) layers speak. |

Every manager ships as a **port + in-memory reference adapter + a shared contract test**, so an app's
SQL adapter is provably behaviour-identical. That's the same port-is-the-product pattern as `CoeditDoc`.

## The algorithm (RGA), briefly

Chosen after a mid-2026 survey — it's what Automerge ships and the simplest sequence CRDT that is
*provably* convergent (verified against the Kleppmann/Gomes Isabelle proof + Sypytkowski's reference):

- **Element id** = `(counter, siteId)` — globally unique, totally ordered.
- **Insert-after-reference**: an insert records the id of the element it follows, never an absolute index.
- **The one convergence rule**: among elements sharing a reference, order by descending id. Every replica
  sorts the same way, so applying the same ops in *any* order yields byte-identical text.
- **Delete = tombstone** (hidden, not erased, so it still anchors others). **Causal buffering** holds an
  op until its dependency arrives.

## License

MIT.
