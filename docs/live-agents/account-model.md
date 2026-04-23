# Account Model

## Overview

In `@weaveintel/live-agents`, **accounts** are security principals and **agents** are actors. This design choice is foundational.

### Why not agent-as-principal?

Naive approaches model agents as security principals:
- Agent gets permissions
- Agent acts directly
- Agent is auditable

**Problem:** Agents are code, not people. They can be updated, redeployed, or compromised without auditing why. If an agent has "send email as john@acme.com," and that agent is updated maliciously, now the email account is at risk.

### Accounts are principals

Instead:

1. **Accounts** (Gmail, Slack, Google Drive) are **principals**
2. **Humans** grant **account bindings** — narrowly-scoped permissions
3. **Agents** inherit permissions *via bindings*
4. **Audit trail** shows which human granted which permission to which agent

**Example flow:**

```
Human: "Allow support-agent to read/send email as support@acme.com"
  ↓ (creates AccountBinding with grantedByHumanId=human:admin-1)
Binding persisted + audit event emitted
  ↓
Support agent starts → loads active bindings
  ↓
During heartbeat, agent needs to send email
  ↓
Agent looks up binding for support@acme.com
  ↓
Heartbeat opens MCP session with credentials from Identity Vault
  ↓
Agent calls MCP tool to send email
  ↓
OutboundActionRecord audit trail written with human+binding context
```

## Data model

### Account

```typescript
interface Account {
  id: string;
  type: 'email' | 'slack' | 'gdrive' | 'spreadsheet' | ...; // system type
  handle: string;                                            // user@example.com, @channel, etc.
  displayName: string;
  credentialVaultRef: string;                                // ref to credential in @weaveintel/identity
  metadata: Record<string, unknown>;
  createdAt: Date;
}
```

Accounts are created by humans. Credentials are never stored in the agent framework — only references to `@weaveintel/identity` vault.

### AccountBinding

```typescript
interface AccountBinding {
  id: string;
  agentId: string;
  accountId: string;
  grantedByHumanId: string;                   // Must be a human principal
  grantedAt: Date;
  revokedAt: Date | null;
  scope: string[];                             // ['read:inbox', 'send:message']
  probationUntil: Date | null;                 // Auto-revoke if unused/misused
  metadata: Record<string, unknown>;
}
```

**Code-enforced invariant:** `grantedByHumanId` must resolve to a human principal. Agents cannot bind accounts.

### AccountBindingRequest

```typescript
interface AccountBindingRequest {
  id: string;
  agentId: string;
  requestedByHumanId: string;
  requestedScope: string[];
  rationale: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decidedByHumanId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}
```

Agents can request bindings; humans approve them.

## Threat model

### Attack: Compromise agent, exfiltrate account access

**Scenario:** An agent is compromised (malicious code injected). Attacker wants to use the agent's account bindings.

**Defense:**

1. Account bindings are scoped (`read:inbox`, not `*`)
2. Each binding has a human `grantedByHumanId` — audit trail is strong
3. Bindings can have a `probationUntil` date — auto-revoke if not actively used
4. `OutboundActionRecord` audit logs every action with binding context
5. Humans can revoke bindings immediately

**Residual risk:** During the compromise, the agent can make some calls. But:
- Scope limits damage
- Audit trail makes it discoverable
- Other agents unaffected
- Probation auto-revoke limits persistence

### Attack: Overly-broad binding

**Scenario:** Human grants "full access to Gmail" instead of just "read inbox + send replies."

**Defense:**

1. Scope must be explicit (no `*`)
2. Binding has `probationUntil` to force re-evaluation
3. `OutboundActionRecord` shows what agent actually did
4. Humans can narrow or revoke based on audit logs

### Attack: Credential theft from vault

**Scenario:** Attacker compromises the identity vault (`@weaveintel/identity`).

**Defense:** Out of scope for agent framework. Identity vault must be secured (e.g., Azure Key Vault, HashiCorp Vault). This is an infrastructure concern, not an agent concern.

## Human-only binding invariant

Only humans can grant account bindings. Why?

1. **Delegation:** If agent A could grant agent B access to a Gmail account, and agent B is compromised, agent A's decision is weaponized.
2. **Intent clarity:** A human granting a binding is intentional (e.g., "I approve this agent reading our support inbox"). An agent self-granting reads as "the system decided this, without human intent."
3. **Audit:** Human grants create a clear audit trail (who, when, why).

**Code enforcement:**

```typescript
if (binding.grantedByHumanId !== 'human:...') {
  throw new OnlyHumansMayBindAccounts();
}
```

## Practical workflows

### Workflow 1: New support agent

1. Human creates agent in mesh: `support-agent`
2. Human creates account in vault: `support@acme.com`
3. Human grants binding: `support-agent` can `read:inbox` and `send:message` as `support@acme.com`
4. At heartbeat, agent can read incoming emails and reply
5. Human reviews audit logs weekly
6. If agent is performing well, binding remains active
7. If agent misbehaves, human revokes binding immediately

### Workflow 2: Request-based binding

1. Agent processes a ticket: "I need access to the customer database"
2. Agent raises `AccountBindingRequest` with rationale
3. Human manager reviews request
4. Manager approves → binding is created
5. Agent can now call MCP tools for that account
6. Audit trail shows: manager approved at time X, for rationale Y

### Workflow 3: Emergency override (break-glass)

1. Incident occurs (e.g., customer angry, need urgent response)
2. Agent doesn't have the necessary binding
3. Human invokes `BreakGlassInvocation` → temporary binding is created
4. Agent can act (outside normal approval flow)
5. After incident, break-glass binding is revoked
6. Mandatory post-incident review required

## Security best practices

1. **Scope narrowly:** Prefer `read:inbox` over `read:*`.
2. **Probation by default:** Set `probationUntil` to 30 days when creating a binding. After 30 days of use, explicitly extend or revoke.
3. **Audit regularly:** Review `OutboundActionRecord` logs weekly.
4. **Revoke immediately:** If agent behaves oddly, revoke bindings first, debug later.
5. **Separate accounts by function:** Support uses `support@acme.com`; billing uses `billing@acme.com`. Never share.
6. **Multi-account setup:** If an agent needs multiple accounts (e.g., read from one account, reply from another), create separate bindings.

## Comparison with other models

### Model: Agent-as-principal

**Pros:**
- Simpler mental model
- Single permission check

**Cons:**
- No human intent signal
- Hard to audit "why did agent X get permission Y?"
- Dangerous if agent is compromised or updated

### Model: Agent owns account

**Pros:**
- Agent fully owns account lifecycle

**Cons:**
- Account lifecycle tied to agent lifecycle (hard to share accounts across agents)
- Credential management complex
- Audit trail unclear

### Model: Accounts are principals, humans grant bindings (this model)

**Pros:**
- Clear audit trail (human intent, time, rationale)
- Scope limits damage
- Easy to revoke
- Accounts can be shared across agents with different scopes

**Cons:**
- Slightly more operational overhead (humans must approve bindings)
- Probation management required

**Verdict:** The operational overhead is worth the security and auditability gains.
