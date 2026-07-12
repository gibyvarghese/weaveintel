# @weaveintel/upgrade

**The pieces that surround a self-upgrade: prioritise what needs a human, snapshot before you touch anything, and merge list-shaped config element by element.**

## Why it exists

When a product ships a new release, some of its built-in defaults change while operators have edited others. Deciding what to adopt, what to keep, and what to flag is the job of the reconcile engine in [`@weaveintel/realm`](../realm). But a real upgrade needs three more things around that engine, and they're the same for every product:

- a way to **rank** the leftovers the reconcile couldn't auto-resolve, so the dangerous ones surface first;
- a **snapshot** taken before the upgrade mutates the database, so a failure rolls back cleanly;
- a **structured merge** for config that is a *list* of independently addressable things (a workflow's nodes, a policy's rules), so a release adding one element and an operator editing another don't collide.

This package is those three, as mechanism — the product supplies its own policy.

## When to reach for it

Reach for it when you are building an upgrade/reconcile flow on top of `@weaveintel/realm`. If you only need to resolve a single config record across a tenant hierarchy, that's `@weaveintel/realm` alone; this adds the review-queue ranking, rollback snapshots, and list merge that a whole-release upgrade needs.

## How to use it

**Priority banding** — you inject the family→band policy; the mechanism keeps one rule: a collision or a genuine both-sides conflict is always the top band.

```ts
import { bandFor, needsReview } from '@weaveintel/upgrade';

const BANDS = { guardrails: 'P1', skills: 'P2', pricing: 'P5' } as const;

bandFor('skills', 'diverged', BANDS);        // 'P2'
bandFor('pricing', 'conflict', BANDS);       // 'P1'  (conflict always tops)
bandFor('unknown', 'stale', BANDS);          // 'P3'  (default band)
needsReview('adopted');                      // false (already applied)
```

**Pre-upgrade snapshot** — SQLite is a near-free WAL-checkpointed file copy; Postgres is a `pg_dump`.

```ts
import { snapshotSqliteFile } from '@weaveintel/upgrade';

const snap = snapshotSqliteFile(db, '/data/app.db', { label: 'pre-upgrade' });
try {
  await runUpgrade();
} catch (err) {
  db.close();
  await snap.restore();   // back to exactly where we were
  throw err;
} finally {
  await snap.discard();
}
```

**Structured id-keyed merge** — three-way-merge a list per element; conflicts keep the local element and are reported.

```ts
import { mergeKeyedList } from '@weaveintel/upgrade';

const { items, conflicts } = mergeKeyedList(baseSteps, localSteps, remoteSteps, 'id');
// a release-added node and an operator's re-wiring of a different node both survive;
// only a node both sides changed differently shows up in `conflicts`.
```

## What it does not do

It is not the reconcile engine — comparing shipped defaults against operator edits and classifying drift is `@weaveintel/realm`. It holds no product policy: which families map to which band, which databases to snapshot, and which fields are id-keyed lists are all the caller's to decide.
