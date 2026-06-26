# @weaveintel/coedit

**CRDT co-editing for AI apps** — a tiny, zero-dependency toolkit so a human and
an AI agent can edit ONE document at the same time and always converge, with
awareness cursors and offline reconcile (Collaboration Phase 7).

> New to this? A **CRDT** (Conflict-free Replicated Data Type) is the trick behind
> tools like Google Docs / Figma multiplayer: many people (and here, an AI agent)
> edit the same thing at once and it never scrambles. Instead of "insert at
> position 5" (which drifts when others edit), every character gets a permanent
> unique id and edits say "insert AFTER character X". With one fixed rule for
> ordering two characters that land in the same place, every copy rebuilds the
> identical text — guaranteed, with no central lock.

## What's in the box

| Primitive | What it does |
|---|---|
| `RgaDoc` | The **RGA text CRDT** — `localInsert`/`localDelete` return ops to broadcast; `apply` merges remote ops. Convergent, idempotent, causal-buffered. `stateVector()`/`opsSince()` for offline sync; `snapshot()`/`fromSnapshot()` for persistence. |
| `Awareness` | **Ephemeral cursors + presence** (who's editing, where). Cursors are *relative positions* (anchored to a character id, not an integer offset) so they don't jump when others edit. Last-write-wins per peer; TTL-expired. |
| `createAgentPeer` | The **agent as a co-editing peer** — a server-side replica with its own site id that streams its output as insert ops. `direct` or `suggest` (HITL) mode. |
| `validateClientOps` | The **trusted-relay** op validator — anti-forgery (a peer can't author ops as another site), size/flood caps, shape checks. |

## The algorithm (RGA)

Chosen after a mid-2026 survey (it's what Automerge ships; the simplest sequence
CRDT that is *provably* convergent — verified against the Kleppmann/Gomes Isabelle
proof + Sypytkowski's reference implementation):

- **Element id** = `(counter, siteId)` — a per-site Lamport counter + a unique
  site id. Globally unique, totally ordered.
- **Insert-after-reference**: an insert records the id of the element it goes
  after (or `null` for the start), never an absolute index.
- **The one rule that makes it converge** — among elements sharing a reference,
  order by **descending id** (higher counter first; equal counter → higher
  siteId first). Every replica sorts by the same rule, so applying the same set
  of ops in *any* order yields byte-identical text (Strong Eventual Consistency).
- **Delete = tombstone** (hide, never remove — a deleted char still anchors
  others). **Causal buffering**: an op whose dependency hasn't arrived is held
  and replayed when it does.

```ts
import { RgaDoc } from '@weaveintel/coedit';

const alice = new RgaDoc('alice');
const bob = new RgaDoc('bob');
const seed = alice.localInsertText(0, 'Hello!'); bob.apply(seed[0]!); // … sync
const a = alice.localInsertText(5, ' Alice');   // "Hello Alice!"
const b = bob.localInsertText(5, ' Bob');       // "Hello Bob!"
bob.applyMany(a); alice.applyMany(b);
alice.text() === bob.text();                     // true — CONVERGED
```

## Offline reconcile (state-vector sync)

```ts
// Each replica advertises a state vector (max counter seen per site).
const missing = peerA.opsSince(peerB.stateVector()); // exactly what B lacks
peerB.applyMany(missing);                             // converge — bandwidth-minimal
```

## The agent as a peer

```ts
import { RgaDoc, createAgentPeer, agentSiteId } from '@weaveintel/coedit';
const doc = new RgaDoc(agentSiteId(runId));     // reserved agent site
const agent = createAgentPeer(doc);             // direct co-editor
agent.append('text the model streamed');        // merges with concurrent human edits
```

Mid-2026 research note: a 2025 user study found people prefer the agent as a
**suggester** (tracked changes they accept) for large/overlapping edits — pass
`{ mode: 'suggest' }` to get the ops back WITHOUT applying them, for the host to
gate behind human approval.

## Security (trusted relay)

CRDTs converge but are **not** Byzantine-tolerant — so the server validates every
op before applying + broadcasting: a peer's site id is derived from its
authenticated session (no forgery), op size + count are capped (anti-flood), and
shapes are checked. See `validateClientOps`.

## In geneWeave

geneWeave persists docs (`coedit_docs` snapshot + `coedit_ops` log), exposes
create/get/ops/sync/awareness endpoints, broadcasts ops live over the run SSE
stream, and runs the agent as a server-side peer that co-edits the run's output
document. See `COLLABORATION_PACKAGE_REVIEW_AND_ROADMAP_2026.md` (Phase 7).
