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

## License

MIT.
