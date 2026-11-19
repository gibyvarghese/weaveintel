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

Plain-text local insertion uses Unicode code points as sequence elements, not UTF-16 offsets or
grapheme clusters. Block-document positions and mark ranges also use code points; the ProseMirror
and Markdown adapters translate their text representation to and from those ranges. Hosts must
translate editor offsets before using positional APIs directly. This assumes every remote text
insert also contains one code point: hosts using positional APIs must configure
`maxCharsPerOp: 1` on their client-operation validator and migrate any older multi-code-point
operations. The validators retain their more permissive default for existing integrations.
Persisted block specs produced by older adapters may use UTF-16 mark offsets and need conversion
against their text before replay.
Out-of-range deletes do not remove another character or a block marker; `BlockDoc.deleteText`
requires non-negative safe-integer indices and counts.
The client-operation validators require positive safe-integer counters in operation IDs and
references, and a non-empty authenticated site namespace. Hosts with historical operations that
do not meet these requirements must repair or migrate them before using these validators.
Local editing refuses to mint counters beyond JavaScript's safe-integer limit. A peer can still
submit a very high valid counter that exhausts this clock, so hosts need an authenticated counter
allocation or bounded-jump policy appropriate to their document and recovery protocol.

For causally complete, in-order histories, a peer can request a delta:

```ts
const missing = alice.opsSince(bob.stateVector()); // precisely what Bob lacks
bob.applyOps(missing);                              // caught up
```

The built-in vectors record the **largest** counter seen per site, not gaps. If a later independent
operation arrives before an earlier one, this delta can omit the earlier operation. Do not use the
vector alone as a reconnect cursor for arbitrary delivery order; replay a complete retained history
or use a host protocol that proves its checkpoint is gap-free.

### Opt-in full-history reconnect

`createRgaSyncJournal` and `createBlockSyncJournal` retain a complete set of operations rather than
guessing missing operations from counter maxima. Exchange **all** `entries()` on reconnect and
`append()` them at each peer; identical operations deduplicate, while an ID with different content
rejects the entire batch. Each site ID must be globally unique, and the same operation ID must never
be reused for different content. This protocol is deliberately O(total history) in memory, storage
and transfer; it is not a compact checkpoint or a scalable production transport.

```ts
import { createRgaSyncJournal } from '@weaveintel/collab';

// Each journal must contain every local and received op, including buffered ops.
const aliceHistory = createRgaSyncJournal(aliceOps);
const bobHistory = createRgaSyncJournal(bobOps);
const aliceEntries = aliceHistory.entries();
const bobEntries = bobHistory.entries();
aliceHistory.append(bobEntries);
bobHistory.append(aliceEntries);
// Persist the complete entries, then reconstruct each document with a NEW globally unique site ID.
const recovered = aliceHistory.rebuild('new-unique-site');
```

Capture and durably retain **every** accepted operation from document inception, including pending
operations; `opsSince({})`, ordinary snapshots, and starting a journal after edits are not substitutes.
The host must authenticate/validate operations before appending, scope and persist histories, coordinate
local edits and durable writes, and avoid acknowledging or broadcasting before durable storage. On an
apply or persistence failure, recover from the last complete committed history before proceeding.
`rebuild()` replays the history including pending dependencies and rejects a site ID already in that
history; the host must also ensure the new ID has never been used elsewhere. Do not rebuild from an
untrusted or incomplete history. History alone does not provide authorization or durability.

Journal entries are copied and must be losslessly JSON-compatible (no `undefined`, non-finite
numbers, negative zero, sparse arrays, accessors, hidden/symbol properties, cycles or non-plain
objects); this may exclude some otherwise valid `BlockDoc` attribute values. Host payload-size/rate
limits still apply. The old vector, snapshot and merge APIs are unchanged.

## Document-agnostic receiving boundary

`createCollaborationReceiver` routes an operation batch to one tenant, session, document and
versioned operation format. It does not define document operations or merge them: use `RgaDoc` /
`CoeditDoc` for text, `BlockDoc` for rich text, or a separately implemented and tested adapter for
another document type. No canvas merge semantics are provided by this package.

```ts
import { createCollaborationReceiver, RgaDoc, validateClientOps } from '@weaveintel/collab';

const doc = new RgaDoc('server-replica');
const receiver = createCollaborationReceiver({
  scope: { tenantId: 'tenant', sessionId: 'session', documentId: 'note', documentKind: 'rga/v1' },
  maxOperations: 500,
  // This principal comes from the authenticated host, never from the message.
  authorize: (principal: { site: string; canWrite: boolean }) => principal.canWrite,
  validate: (ops, principal) => validateClientOps(ops, { expectedSiteId: principal.site }),
  apply: (ops) => { doc.applyMany(ops); },
});
// host: receiver.receive(verifiedPrincipal, untrustedDelivery)
```

The host must authenticate every caller, bind the scope to the correct replica, check current
session/document write access on every delivery, validate authorship and payload sizes, and enforce
limits on message bytes and rates. Authorization and validation callbacks are trusted, synchronous
host code; exceptions propagate and never constitute acceptance. Read access, secure transport,
broadcast, persistence, lifecycle, replay and revocation are host responsibilities. `accepted` means
only that the adapter was invoked, not that changes were persisted, broadcast or fully integrated.
An adapter that throws may have applied part of a batch; retries require idempotent operations.

For reconnects, the host must retain and replay all missing operations (including local unsent
edits), or use a verified gap-free checkpoint and tail, with authorization for historical replay.
The adapter must itself handle duplicates and out-of-order delivery, including dependencies; the
receiver does not deduplicate, buffer or track checkpoints. Snapshots must preserve whatever
pending operations and deduplication state the selected adapter needs; do not assume the existing
text or block snapshots are complete replay checkpoints. This boundary alone does not provide live
collaboration or authorize use of a network endpoint.

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
| `createInMemoryPresenceManager`, `createPostgresPresenceManager` | **Presence** — a heartbeat-driven, TTL-expiring "who's here" set (agents are first-class peers). The PostgreSQL adapter shares snapshots across servers using the application's database connection. Authorization and identity are supplied by the host. |
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
