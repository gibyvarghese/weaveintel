# ADR 001: Account Binding Invariants

**Date:** 2024-01  
**Status:** Accepted  
**Deciders:** Architecture team  

## Context

Agents need to act on behalf of humans (send email, approve transfers, etc.). Two models are possible:

1. **Agent-as-account:** Agent owns an account credential; agent can grant itself permission.
   - Example: `agent.createAccount('my-email@company.com')`
   - Problem: Agent can escalate permissions, lock out humans, impersonate identity

2. **Account-binding:** Humans bind their accounts to agents; humans control permissions.
   - Example: `bindAccountToAgent(human.account, agent, ['SEND_EMAIL'])`
   - Invariant: Only humans (account owners) can grant/revoke permissions

We chose **account-binding**.

## Decision

Live-agents enforces these invariants:

1. **Only humans bind accounts.** Agents cannot self-bind accounts.
2. **Humans control capabilities.** Bindings include a `capabilities: []` array. Agent can only use granted capabilities.
3. **Humans revoke bindings.** Agents cannot unbind accounts or revoke capabilities.
4. **Bindings are immutable during execution.** Once a heartbeat tick starts, capability grants are frozen.

### Schema

```typescript
interface AccountBinding {
  id: string;
  accountId: string;      // e.g., 'alice@company.com'
  agentId: string;
  capabilities: string[]; // e.g., ['SEND_EMAIL', 'APPEND_CALENDAR']
  boundBy: string;        // Human who created binding (userId or email)
  boundAt: Date;
  revokedAt?: Date;       // null = active; set = revoked
}
```

### API

```typescript
// Bind: Human-initiated, requires credentials
await bindAccountToAgent({
  accountId: 'alice@company.com',
  agentId: agent.id,
  capabilities: ['SEND_EMAIL', 'READ_INBOX'],
  boundBy: currentUser.id,
});

// Revoke: Human-initiated
await revokeAccountBinding(binding.id);

// List: Check what bindings are active
const bindings = await listAccountBindings(agent.id);

// At runtime: Agent calls MCP tool
// Framework checks: is capability in binding.capabilities?
const result = await agent.call('SEND_EMAIL', { to: 'bob@company.com', ... });
// If 'SEND_EMAIL' not in capabilities, call fails
```

## Rationale

**Why not agent-as-account?**
- Agent can escalate: `agent.grantCapability(agent, 'DELETE_ALL_EMAIL')`
- Agent can lock out humans: unbind all accounts, revoke human's own permissions
- Violates principle of least privilege: agent gets all or nothing
- No audit trail of who authorized what

**Why account-binding?**
- Humans control the permission boundary
- Capabilities are immutable during execution (safe within a tick)
- Audit trail: every binding has `boundBy` and `boundAt`
- Revocation is immediate (next tick sees revoked binding)

## Consequences

**Positive:**
- Agents cannot escalate permissions
- Humans remain in control of their identities
- Clear audit trail for compliance

**Negative:**
- Operationally complex: humans must explicitly bind accounts
- Cannot re-bind if human is unavailable (e.g., on vacation)
- Requires secure credential handling (secrets in env vars, not DB)

## Alternatives Considered

### 1. Approval queue
Agents request capabilities; humans approve in queue.

**Rejected:** Too much latency. Headbeat-driven actions must proceed quickly.

### 2. Role-based access control (RBAC)
Agents inherit permissions from group membership.

**Rejected:** Groups don't scale to 1000s of agents. Account binding is simpler.

### 3. Time-limited capabilities
Capabilities expire after N hours.

**Accepted as enhancement:** Bindings can include `expiresAt`. Useful for temporary delegations.

## Examples

### Safe: Marketing team

```typescript
// Alice (marketing manager) binds her Gmail to the agent
await bindAccountToAgent({
  accountId: 'alice@marketing.company.com',
  agentId: promo.id,
  capabilities: ['SEND_EMAIL', 'READ_INBOX'],
  boundBy: alice.userId,
});

// Agent runs: can send promotional emails (OK)
// Agent tries: agent.call('DELETE_EMAIL', { id: 'all' })
// → Denied: DELETE_EMAIL not in capabilities
```

### Unsafe: Agent self-grants (prevented)

```typescript
// ❌ NOT ALLOWED (runtime check prevents this)
await agent.call('BIND_ACCOUNT', {
  accountId: 'ceo@company.com',
  agentId: agent.id,
  capabilities: ['APPROVE_TRANSFER', 'DELETE_ANYTHING'],
});
// Error: BIND_ACCOUNT not a valid MCP tool (not exposed to agents)
```

### Safe: Account revocation

```typescript
// Bob's account is compromised. Revoke immediately.
await revokeAccountBinding(binding.id);

// Next heartbeat tick: agent fetches bindings, sees revoked=true
// Agent cannot use Bob's account anymore
// Existing in-flight operations complete (graceful shutdown)
```

## References

- [Account Model](./account-model.md) — Threat model
- [@weaveintel/live-agents](../packages/live-agents/README.md) — `bindAccountToAgent()` API
- `examples/56-live-agents-account-binding-guardrail.ts` — Example implementation
