# @weaveintel/realm

**One default for everyone, a private copy for anyone — resolved correctly, with a paper trail.**

## Why it exists

Ship a piece of configuration once — a prompt, a guardrail, a skill — and in a multi-tenant product
you immediately want three things that fight each other:

1. a **global default** everyone gets out of the box,
2. the ability for one customer to **tweak their own copy** without touching anybody else's, and
3. a way, later, to tell whether that tweak has **drifted** from the default it was based on — so a
   product update never silently clobbers a customer's edits, and never leaves them stuck on a stale one.

`@weaveintel/realm` gives you exactly that, and the drift check is the same three-way (base / yours /
theirs) comparison git uses for a merge — just applied to configuration. It runs identically on SQLite
and Postgres, and builds on the tenant tree from `@weaveintel/identity`.

## The mental model

- A **global** record is the shared default.
- A tenant can **customize** — that makes a private copy (copy-on-write) that remembers where it came from.
- A tenant can **share** its copy down its part of the org tree, so a parent company's choice flows to
  its subsidiaries.
- When someone asks for a config, resolution picks the **nearest owner**: your own copy beats a parent's
  shared copy, which beats the global default.

## Quickstart

```ts
import { createInMemoryRealmStore, createRealmResolver } from '@weaveintel/realm';
import { createInMemoryTenantHierarchy, } from '@weaveintel/identity';
import { buildRealmContext } from '@weaveintel/realm';

const store = createInMemoryRealmStore();        // or the SQL-backed store (SQLite/Postgres)
const resolver = createRealmResolver({ store });

// 1) The product publishes a global default.
await store.publishGlobal('assistant.general', { template: 'You are a helpful assistant.' });

// 2) A tenant customizes their own copy.
const org = createInMemoryTenantHierarchy();
const acme = await org.create({ id: 'acme', name: 'Acme' });
const ctx = await buildRealmContext(org, 'acme');
await store.customize('assistant.general', ctx, { template: 'You are Acme’s in-house assistant.' });

// 3) Resolution gives each caller the right one, and says where it came from.
const forAcme = await resolver.resolve('assistant.general', ctx);
forAcme.template          // 'You are Acme’s in-house assistant.'
forAcme.realmProvenance   // { kind: 'own_override', drift: 'in_sync' }

const forSomeoneElse = await resolver.resolve('assistant.general', await buildRealmContext(org, 'other'));
forSomeoneElse.realmProvenance.kind  // 'global'  — untouched tenants still get the default
```

### Provenance — every resolved record says where it came from

- `{ kind: 'global' }` — the shared default.
- `{ kind: 'native', ownerTenantId }` — a record this tenant authored from scratch (no global equivalent).
- `{ kind: 'own_override', ownerTenantId, drift }` — this tenant's own edited copy (+ its drift state).
- `{ kind: 'inherited', fromTenantId, distance }` — a parent/ancestor's shared copy, `distance` levels up.

Stamp it into your run traces and you can always answer *"which prompt version produced this output for
this tenant?"*.

### Drift — has a customization gone stale, or diverged?

`drift` on an override is one of:

| drift | meaning |
|---|---|
| `in_sync` | your copy is unchanged and the default is unchanged — identical |
| `customized` | you edited it; the default hasn't moved — your change is the only difference |
| `stale` | you didn't touch it; the default moved on — safe to refresh in one click |
| `diverged` | both changed — needs a real look (a merge) |

This is the exact same signal for two problems: *"a tenant customized a built-in"* and *"a package update
changed a default a tenant was using."*

### Sharing down the tree

```ts
const edit = await store.customize('brand.tone', parentCtx, { tone: 'formal' });
await store.setShareMode(edit.id, 'subtree'); // now every subsidiary inherits it (unless they have their own)
```

`private` (default) keeps it to yourself, `children` shares to direct children only, `subtree` shares to
your whole branch. A parent's *private* copy stays invisible to children — privacy hides the customization,
never the concept.

## Backing it with a real database

The SQL store speaks to any client with a `query(text, params) → { rows }` method — a `pg.Pool` fits
directly; for SQLite, wrap `better-sqlite3` in a few lines. The visibility rule (who may see which copy)
is one WHERE clause — no recursive SQL — so SQLite and Postgres behave identically (proven by the same
conformance test running against both).

```ts
import { createSqlRealmStore } from '@weaveintel/realm';
import pg from 'pg';
const store = createSqlRealmStore({ client: new pg.Pool({ connectionString: process.env.DATABASE_URL }), dialect: 'postgres' });
```

## Shipping updates without clobbering edits (the version log + reconcile)

Here's the problem every product with built-in defaults eventually hits. You ship a set of default
prompts (or guardrails, or skills). An operator edits a few to suit their organisation. Then you ship a
new release that improves some of those same defaults. Now what? Overwrite and lose their edits? Skip
and leave them on an old version forever? Neither is acceptable.

This is the exact problem your operating system's package manager solved decades ago. When a new package
version wants to replace a config file in `/etc`, it doesn't guess — it remembers the version it shipped
last time (the **baseline**) and compares three things: what it shipped before, what's on disk now, and
what the new package wants. Then it only bothers you when *both* sides changed.

`@weaveintel/realm` gives you the same machinery for config records:

- A **version log** (`createInMemoryVersionLog` / `createSqlVersionLog`) records every default you
  publish. It's the baseline — kept separate from the live record, so an operator's edit never erases it.
- **`reconcile(store, log, family, desiredDefaults)`** compares your new release against what's stored
  and sorts every default into one of six buckets:

| bucket | meaning | what reconcile does |
|---|---|---|
| `in_sync` | nobody changed it | nothing |
| `customized` | operator edited it; you didn't change it | **keeps theirs** |
| `stale` | operator didn't touch it; you shipped a change | **adopts the new default** automatically |
| `diverged` | both changed | leaves it, flags for review (a real merge) |
| `new` | you ship a default not in the store yet | publishes it |
| `removed` | the store has a default you no longer ship | flags it, never auto-deletes |

```ts
import { createInMemoryRealmStore, createInMemoryVersionLog, reconcile } from '@weaveintel/realm';

const store = createInMemoryRealmStore();     // or the SQL store
const log = createInMemoryVersionLog();       // or createSqlVersionLog

// Your release's current defaults:
const defaults = [
  { logicalKey: 'assistant.general', payload: { template: 'You are a helpful assistant.' } },
  { logicalKey: 'assistant.legal',   payload: { template: 'You are a careful legal assistant.' } },
];

const { report, applied, needsReview } = await reconcile(store, log, 'prompts', defaults);
// report.summary → { in_sync, customized, stale, diverged, new, removed }
// applied        → what it published/adopted automatically
// needsReview    → what a human should look at (the customized/diverged ones)
```

The first run publishes everything (`new`). Re-running the same release is a clean no-op — the version
log is content-addressed, so re-seeding never inflates history. And a `reconcile` **is** the seeding
mechanism: first seed and later upgrade are the same call.

When an operator decides a `diverged` default should just take the shipped version, `resyncToDesired`
records that choice and drift returns to `in_sync` — the equivalent of "install the package maintainer's
version". `publishToRealm` publishes a single global default plus its version, for an admin "save"
button.

## Turning a built-in off (or reprioritising it) without copying it

Sometimes a tenant doesn't want a *different* prompt or skill — it just wants to switch a built-in **off**
for itself, bump its **priority**, or **pin** it to a specific version. Making a full private copy just
to flip a switch would be wasteful and create edits to track forever. So there's a thin sidecar for
exactly this: a per-tenant **overlay** that stores only what the tenant changed, and leaves everything
else inherited — the same idea as a per-tenant feature flag, or a Kustomize overlay patched over a base.

```ts
import { createInMemoryStateStore, resolveStateFor } from '@weaveintel/realm';
// (or createSqlStateStore + realmTenantStateDdl for SQLite/Postgres)

const state = createInMemoryStateStore();

// A parent company turns a skill OFF for its whole org…
await state.setState('skills', 'skill.web-search', 'acme', { enabled: false });
// …but one subsidiary turns it back on just for itself.
await state.setState('skills', 'skill.web-search', 'acme-uk', { enabled: true });

const uk = { tenantId: 'acme-uk', depth: 1, lineage: [{ tenantId: 'acme', depth: 0 }, { tenantId: 'acme-uk', depth: 1 }] };
(await resolveStateFor(state, 'skills', 'skill.web-search', uk)).active;   // true — the child's override wins
```

Resolution is **per field, nearest wins**: for each of `enabled` / `priority` / `pinnedVersion`, the
closest tenant on the lineage that set a value wins, so a parent org can set policy for its whole subtree
and a child can still override just the one field it cares about. Only an explicit `enabled: false`
turns something off (`null`/`true` keep it on), and setting every field back to `null` removes the
overlay entirely. Nothing is ever forked — the shared default stays exactly as shipped.

## License

MIT.
