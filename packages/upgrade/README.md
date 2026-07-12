# @weaveintel/upgrade

**The pieces that surround a self-upgrade: discover and verify a signed release, prioritise what needs a human, snapshot before you touch anything, and merge list-shaped config element by element.**

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

## Discovering and verifying a release

Before an instance can upgrade, it has to find the release, prove it's genuine, and decide it's actually
newer and meant for it. This package provides that whole path — a signed release **manifest**, Ed25519
signing/verification, pluggable release **sources**, and an **update checker** that trusts a manifest only
after it passes signature, edition, freshness, and anti-rollback checks (each failure with a distinct reason).

The manifest is a signed description of one release — its version, edition, expiry, platform requirements,
and the four upgrade layers (packages, code, schema migrations, seeded content). A publisher builds and signs
it; a client fetches and verifies it.

```ts
import {
  buildManifest, createEd25519Verifier, createGitHubReleaseSource, createUpdateChecker,
} from '@weaveintel/upgrade';

// ── Publisher (CI, once per release) ──
const manifest = buildManifest(
  { manifestVersion: 1, name: '@acme/app', version: '2.1.0', edition: 'community',
    publishedAt: new Date().toISOString(),
    layers: { content: [{ family: 'skills', logicalKey: 'summarize', remoteHash: 'sha256:…',
                          releaseNote: 'sharper summaries' }] } },
  signingPrivateKey,          // Ed25519 — the same key kind @weaveintel/encryption issues
);                            // → attach manifest (as JSON) to the GitHub release

// ── Client (on each instance) ──
const checker = createUpdateChecker({
  source: createGitHubReleaseSource({ repo: 'acme/app', http: myResilientGet }),  // inject your HTTP
  verifier: createEd25519Verifier([TRUSTED_PUBLIC_KEY_PEM]),
  edition: 'community',
  currentVersion: '2.0.0',
});

const outcome = await checker.check();
// → { status: 'update_available' | 'up_to_date' | 'none' }
//   or { status: 'rejected', reason: 'bad_signature' | 'untrusted_key' | 'expired'
//                                    | 'downgrade' | 'edition_mismatch' | 'unsupported_format' }
```

Notes that matter in practice:

- **No new crypto, no HTTP dependency.** Signing reuses the Ed25519 primitives from
  [`@weaveintel/encryption`](../encryption); the release sources take an *injected* HTTP getter, so you wire
  it to `@weaveintel/resilience` (rate-limit + circuit-breaker + retry) and this package stays dependency-light
  and makes no raw network calls of its own.
- **Private repos.** `createAuthenticatedGitHubReleaseSource` adds a bearer token from a provider you supply
  (back it with your encrypted credential vault, not an env-var plaintext). The token is used only in the
  `Authorization` header and is never logged or placed in an error.
- **Anti-rollback.** The checker refuses a manifest older than `currentVersion` — pass
  `max(installedVersion, highestReleaseYouHaveSeen)` so a replayed old (but validly-signed) manifest can't
  force a downgrade.
- **Publisher lint.** `lintManifest` catches policy mistakes a well-formed manifest can still have (a
  content entry with an empty release note, duplicate keys, an expiry before publish, a non-semver version)
  so CI can block a bad release before it's cut.

## What it does not do

It is not the reconcile engine — comparing shipped defaults against operator edits and classifying drift is `@weaveintel/realm`. It holds no product policy: which families map to which band, which databases to snapshot, and which fields are id-keyed lists are all the caller's to decide.
