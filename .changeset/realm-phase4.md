---
"@weaveintel/realm": minor
---

Tenancy realm Phase 4 — sharing down the org tree with a blast-radius preview, and promoting a fork up to
the global default. `blastRadius(ownerDepth, descendants, shareMode, forkedTenantIds)` is a pure function
that, given a sharing tenant's descendants (from the tenant hierarchy) and which of them already have
their own copy, tells you exactly who will start using the shared record (`inheriting`), who keeps their
own (`shadowed`), and who's out of scope — the "know who's affected before a change propagates" discipline
applied to config, so a Share is never blind. `promoteFork(store, versionLog, family, fork)` lifts a
tenant's customization to the shared global default (publishes its content + records a version), for the
"productise a good customization for everyone" flow. `payloadOf` recovers the plain app payload from a
stored realm record. Subtree resolution at depth already works via the existing resolver + share modes —
this release adds the tooling around it and proves it end to end: a real Postgres + a real tenant tree
where a parent org's shared fork resolves for a grandchild, a sibling branch gets the global, private
forks stay invisible to children, a 606-node subtree blast radius is exact, and a real-LLM flagship shares
an AI-written brand voice down a regional HQ's whole subtree.
