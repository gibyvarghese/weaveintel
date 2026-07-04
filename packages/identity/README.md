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
- `@weaveintel/identity/tenancy` — tenant resolution and isolation helpers.
- `@weaveintel/identity/scope` — scope definitions and default scope sets.

## License

MIT.
