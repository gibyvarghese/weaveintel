# Swapping the co-editing engine — the `CoeditDoc` port

**In one sentence:** everything that co-edits a document in `@weaveintel/collab` talks to a small
interface called `CoeditDoc`, so you can replace the engine underneath — with [Yjs](https://github.com/yjs/yjs),
or anything else — **without changing a single line of the sync, the awareness cursors, or the
AI-as-editing-peer.**

## Why this exists (the plain version)

A collaborative editor needs a "conflict-free" data structure (a **CRDT**) so that when two people —
or a person and an AI — type into the same document at once, every copy ends up identical with no
central lock. This package ships its own small, **zero-dependency** CRDT (a Replicated Growable Array,
"RGA"). It is fast, has no install footprint, and is the default.

But some teams already run **Yjs**, the most widely-adopted CRDT library, and want their whole stack on
one engine. Others may want a server-authoritative OT engine, or a Rust/WASM CRDT. We did not want those
teams to fork the package. So the RGA is not welded in — it sits behind a port (`CoeditDoc`), and the
port is the thing the rest of the code depends on. Change the engine, keep everything else.

> Think of it like a wall socket. The socket shape is `CoeditDoc`. The built-in RGA is the appliance
> that ships in the box. A Yjs adapter is a different appliance with the same plug. The wiring in the
> wall — your sync loop, the live cursors, the agent that writes alongside you — never changes.

**We do NOT depend on Yjs.** `@weaveintel/collab` has zero runtime dependencies. The Yjs adapter below
lives in *your* application (where you `npm install yjs`), not in this framework package. This document
is the map so you know exactly how to build it.

## The port

```ts
interface CoeditDoc {
  readonly siteId: string;                 // this replica's unique id
  readonly length: number;                 // visible characters
  text(): string;                          // current text

  insert(index: number, text: string): CoeditOp[];        // local edit → ops to broadcast
  delete(index: number, count?: number): CoeditOp[];       // local edit → ops to broadcast
  applyOps(ops: CoeditOp[]): number;                       // merge remote ops (idempotent)

  opsSince(since: CoeditStateVector): CoeditOp[];          // the delta a peer is missing
  stateVector(): CoeditStateVector;                        // this replica's causal clock
  snapshot(): CoeditSnapshot;                              // serialisable state (persist / send)

  fork(siteId?: string): CoeditDoc;                        // independent shadow (speculative edits)

  anchor(index: number): RelativePosition;                 // pin a cursor to a character
  resolve(pos: RelativePosition): number;                  // read that cursor back as an index
}
```

`CoeditOp`, `CoeditSnapshot`, and `CoeditStateVector` are **the engine's own wire format**. For the RGA
they are small JSON objects; for Yjs they are `Uint8Array` binary updates. That is expected: both
replicas of a given document run the *same* engine, so both speak the same op format. You do not mix RGA
ops and Yjs ops on one document — you pick an engine per deployment.

## RGA ↔ Yjs — the method-by-method map

Everything the port asks for has a direct Yjs equivalent. (`Y` = `import * as Y from 'yjs'`.)

| `CoeditDoc`            | Yjs equivalent                                                                 |
|------------------------|--------------------------------------------------------------------------------|
| construct              | `new Y.Doc()` + one shared `doc.getText('content')`                            |
| `text()`               | `ytext.toString()`                                                             |
| `length`               | `ytext.length`                                                                 |
| `insert(i, s)`         | `ytext.insert(i, s)` — capture the resulting update (see below)               |
| `delete(i, n)`         | `ytext.delete(i, n)` — capture the resulting update                           |
| `applyOps(ops)`        | `Y.applyUpdate(doc, op)` for each — [idempotent by design](https://docs.yjs.dev/api/document-updates) |
| `stateVector()`        | [`Y.encodeStateVector(doc)`](https://docs.yjs.dev/api/document-updates)        |
| `opsSince(sv)`         | [`Y.encodeStateAsUpdate(doc, sv)`](https://docs.yjs.dev/api/document-updates) — writes only the missing diff |
| `snapshot()`           | `Y.encodeStateAsUpdate(doc)` (the full state as one update)                    |
| `fork(siteId)`         | `new Y.Doc()` + `Y.applyUpdate(clone, this.snapshot())`                        |
| `anchor(i)`            | [`Y.createRelativePositionFromTypeIndex(ytext, i)`](https://docs.yjs.dev/api/relative-positions) |
| `resolve(pos)`         | `Y.createAbsolutePositionFromRelativePosition(pos, doc)?.index ?? length`      |

Two things worth knowing, both true of Yjs and the built-in RGA:

- **Deletes leave tombstones.** In both engines a "delete" marks content as removed rather than erasing
  it, which is what lets concurrent edits still converge. ([Why you can't truly delete in Yjs.](https://liveblocks.io/docs/guides/why-you-cant-delete-yjs-documents))
- **State-vector diffing is the sync.** A joining peer sends its state vector; you reply with only the
  ops it is missing. That is exactly what `opsSince` / `applyOps` express.

## A worked Yjs adapter

This is the whole adapter. It lives in your app (which has `yjs` installed); the framework does not.

```ts
// my-app/src/yjs-coedit-adapter.ts
import * as Y from 'yjs';
import type { CoeditDoc, CoeditOp, CoeditSnapshot, CoeditStateVector } from '@weaveintel/collab';

// For a Yjs deployment the op/snapshot/state-vector wire types are all Uint8Array.
// (Declared here for clarity; assign through the CoeditDoc port.)

export function createYjsDoc(siteId: string, snapshot?: CoeditSnapshot): CoeditDoc {
  const doc = new Y.Doc();
  if (snapshot) Y.applyUpdate(doc, snapshot as unknown as Uint8Array);
  const ytext = doc.getText('content');

  // Run an edit, then hand back ONLY the update it produced (the delta since `before`).
  const captureAfter = (before: Uint8Array, mutate: () => void): CoeditOp[] => {
    mutate();
    const update = Y.encodeStateAsUpdate(doc, before);
    return [update as unknown as CoeditOp];
  };

  const self: CoeditDoc = {
    siteId,
    get length() { return ytext.length; },
    text: () => ytext.toString(),

    insert: (index, text) => {
      const before = Y.encodeStateVector(doc);
      return captureAfter(before, () => ytext.insert(index, text));
    },
    delete: (index, count = 1) => {
      const before = Y.encodeStateVector(doc);
      const n = Math.min(count, Math.max(0, ytext.length - index));
      if (n === 0) return [];
      return captureAfter(before, () => ytext.delete(index, n));
    },

    applyOps: (ops) => {
      // Yjs is idempotent; count only the ops that actually advanced our state.
      let applied = 0;
      for (const op of ops) {
        const before = Y.encodeStateVector(doc);
        Y.applyUpdate(doc, op as unknown as Uint8Array);
        if (!eq(before, Y.encodeStateVector(doc))) applied++;
      }
      return applied;
    },

    opsSince: (since) => [Y.encodeStateAsUpdate(doc, since as unknown as Uint8Array) as unknown as CoeditOp],
    stateVector: () => Y.encodeStateVector(doc) as unknown as CoeditStateVector,
    snapshot: () => Y.encodeStateAsUpdate(doc) as unknown as CoeditSnapshot,

    fork: (id) => createYjsDoc(id ?? siteId, Y.encodeStateAsUpdate(doc) as unknown as CoeditSnapshot),

    anchor: (index) => {
      const rel = Y.createRelativePositionFromTypeIndex(ytext, index);
      // Adapt Yjs's RelativePosition to the port's {anchorId, assoc} shape however you prefer;
      // encoding it as JSON via Y.encodeRelativePosition is the simplest.
      return { anchorId: null, assoc: -1, y: Y.encodeRelativePosition(rel) } as never;
    },
    resolve: (pos) => {
      const rel = Y.decodeRelativePosition((pos as never as { y: Uint8Array }).y);
      const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
      return abs ? abs.index : ytext.length;
    },
  };
  return self;
}

function eq(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
```

## Prove it — run the contract

The port is only trustworthy if a swapped-in engine behaves identically. So we ship a **conformance
contract** — the exact suite the built-in RGA passes — and you run it against your adapter:

```ts
// my-app/src/yjs-coedit-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { coeditDocContract } from '@weaveintel/collab';
import { createYjsDoc } from './yjs-coedit-adapter.js';

// Same suite the RGA reference adapter passes: insert/delete, convergence under concurrent
// edits, idempotent applyOps, snapshot round-trip, state-vector deltas, fork isolation,
// and cursor anchoring across concurrent inserts.
coeditDocContract(createYjsDoc, { describe, it, expect });
```

If that goes green, the rest of the package works on your engine unchanged — including
`createAgentPeer` (the AI writing alongside a human), because it, too, only ever touches the
`CoeditDoc` port.

## What you do NOT have to change

- **The AI-as-editing-peer** (`createAgentPeer`) — it calls `insert` / `length` / `fork`, nothing else.
- **The sync loop** — it calls `opsSince` / `applyOps` / `stateVector`.
- **The live cursors** (`Awareness` + `anchor`/`resolve`) — they anchor to characters, not offsets.
- **The server-side edit validation, presence, and sharing** — all of it sits above the port.

That is the point of a port: the engine is a detail, and the detail is swappable.

---

### Sources / further reading

- Yjs — [Document Updates API](https://docs.yjs.dev/api/document-updates) (`encodeStateAsUpdate`, `applyUpdate`, `encodeStateVector`)
- Yjs — [Relative Positions](https://docs.yjs.dev/api/relative-positions) (cursor anchoring that survives concurrent edits)
- Yjs — [repository & README](https://github.com/yjs/yjs)
- Liveblocks — [Why you can't delete Yjs documents](https://liveblocks.io/docs/guides/why-you-cant-delete-yjs-documents) (tombstones, plain-language)
