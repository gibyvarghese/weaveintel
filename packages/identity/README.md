# @weaveintel/identity

**Who is making this request, on whose behalf, and are they allowed to do it — identity, delegation, and access control in one runtime.**

## Why it exists

In an agent system the caller isn't always a person. A user kicks off a task, an agent picks it up and acts on their behalf, and a background job runs as the system itself. Each of those needs an identity, and every action needs a yes-or-no answer on whether it's permitted. Think of it like a building pass: a visitor gets a badge, they can lend a temporary, time-limited badge to an escort acting for them, and every door reads the badge before it opens. This package issues the badges and checks them at the door.

## When to reach for it

Reach for it whenever an action needs a permission check — a user, an agent acting on a user's behalf, or a system process. It answers "is this allowed?" If instead you need to decide whether output is *safe* or a call is within *budget*, those are `@weaveintel/guardrails` and `@weaveintel/cost-governor`.

## How to use it

```ts
import { createIdentity, evaluateAccess } from '@weaveintel/identity';

const user = createIdentity({ id: 'u-1', roles: ['editor'] });

const decision = evaluateAccess(user, {
  action: 'note:write',
  resource: { tenantId: 't-42' },
});

if (!decision.allowed) throw new Error(decision.reason);
```

## What's in the box

Main entry (`@weaveintel/identity`):

- `createIdentity`, `createIdentityContext`, `systemIdentity`, `agentIdentity` — build the identity of the caller.
- `createDelegation`, `validateDelegationChain`, `assertDelegationValid` — act-on-behalf-of, with expiry.
- `evaluateAccess`, `evaluateAccessBatch` — the yes/no access decision.
- RBAC: `DEFAULT_RBAC_POLICY`, `resolvePersonaPermissions`, `hasPersonaPermission`, `canAccessArea`.

Subpath exports:

- `@weaveintel/identity/oauth` — OAuth flows and token handling, with a durable variant.
- `@weaveintel/identity/tenancy` — tenant resolution, isolation helpers, and the tenant hierarchy (below).
- `@weaveintel/identity/scope` — scope definitions and default scope sets.

## Tenant hierarchy — real tenants with a parent/child tree

A **tenant** is one isolated customer, company, or workspace using your product. Most apps begin with
exactly one. But real customers grow: a company acquires regional subsidiaries, an agency resells to
its own clients, an enterprise splits into departments. When that happens you need tenants to be
*real things with parents and children* — not just a text label on a row.

This gives you that tree, in a form that runs the same on a little SQLite file or a big Postgres
cluster.

```ts
import { createInMemoryTenantHierarchy } from '@weaveintel/identity';

const org = createInMemoryTenantHierarchy();

const acme = await org.create({ name: 'Acme Corp' });                       // a top-level tenant
const emea = await org.create({ name: 'EMEA', parentTenantId: acme.id });   // a child
const uk   = await org.create({ name: 'Acme UK', parentTenantId: emea.id }); // a grandchild

await org.ancestors(uk.id);     // [Acme Corp, EMEA]  — walk up (e.g. to bill the parent company)
await org.descendants(acme.id); // [EMEA, Acme UK]    — everything under a customer
await org.children(acme.id);    // [EMEA]             — just the direct reports
```

### Moving branches (acquisitions, reorgs)

Move a tenant and its **whole subtree** in one call. It's safe: it refuses to make a tenant its own
ancestor (no loops).

```ts
await org.reparent(uk.id, acme.id); // Acme UK now reports straight to Acme Corp
```

### Just one tenant? It stays out of your way

If you only ever have one customer, call `ensureDefault()` and forget the tree exists — there are no
parents, no children, and every query collapses to "just me."

```ts
const me = await org.ensureDefault({ name: 'My Company' }); // idempotent single-org starting point
```

### Backing it with a real database (SQLite or Postgres)

The same store, over SQL. It uses one tiny `SqlClient` seam (`query(text, params) → { rows }`) — a
`pg.Pool` already fits it; for SQLite, wrap `better-sqlite3` in a few lines.

```ts
import { createSqlTenantHierarchy, tenantHierarchyDdl } from '@weaveintel/identity';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const org = createSqlTenantHierarchy({ client: pool, dialect: 'postgres' }); // creates the table on first use
// (Or manage the schema yourself with `tenantHierarchyDdl()` + `{ ensureSchema: false }`.)
```

### How it works (in one paragraph)

Each tenant stores its lineage as a string called a **path**, like `/acme/emea/uk/`. From that single
column everything is cheap and portable: its depth is the number of segments, its ancestors are the
path's prefixes, and its descendants are every row whose path *starts with* its own. Moving a branch
is one string-rewrite `UPDATE`. There's no database-specific magic (no `ltree`, no recursive queries),
which is why SQLite and Postgres behave identically — verified by the same conformance test running
against an in-memory store, a real SQLite file, and a real Postgres.

### Adding it to an existing app (e.g. geneWeave)

If today `tenant_id` is just a text label on your tables, adopting this is a relabel, not a data move:

1. Create the `tenants` table (`tenantHierarchyDdl()`).
2. Turn each distinct `tenant_id` you already have into a **root** tenant; map blank/`NULL` to one
   synthetic **default** tenant (`ensureDefault()`), so single-org installs behave exactly as before.
3. Point your existing `tenant_id` columns at it (a foreign key, once the rows exist).

Nothing else changes until you *want* a hierarchy — at which point `reparent`, `ancestors`, and
`descendants` are waiting.

## License

MIT.
