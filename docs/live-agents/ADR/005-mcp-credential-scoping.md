# ADR 005: MCP Credential Scoping

**Date:** 2024-01  
**Status:** Accepted  
**Deciders:** Architecture team  

## Context

Agents call external tools via MCP (Model Context Protocol). Examples: Gmail, Slack, Google Drive.

MCP tools need credentials (API keys, OAuth tokens). Questions:

1. **Where are credentials stored?** (database, environment, vault?)
2. **Who has access?** (all agents, one agent, one mesh?)
3. **How are credentials scoped?** (by agent, by account, by capability?)

We chose **account-scoped credentials via environment variables with account binding**.

## Decision

**Credentials live in environment variables; accounts control access via bindings.**

### Pattern

```typescript
// 1. Operator stores credential in env var
process.env.GMAIL_SERVICE_ACCOUNT_KEY = '{"type":"service_account",...}';

// 2. Human binds their Gmail account to agent + grants SEND_EMAIL capability
await bindAccountToAgent({
  accountId: 'alice@company.com',
  agentId: analyst.id,
  capabilities: ['SEND_EMAIL', 'READ_INBOX'],
});

// 3. At runtime, agent tries to send email
await agent.call('SEND_EMAIL', { to: 'bob@company.com', ... });

// 4. Framework checks:
//    a. Does binding exist for 'alice@company.com'?
//    b. Is 'SEND_EMAIL' in binding.capabilities?
//    c. Is binding.revokedAt null (still active)?
// 5. If all yes: MCP tool executes with GMAIL_SERVICE_ACCOUNT_KEY credential
// 6. If any no: Call fails, returns "Capability denied"

// 7. If credential is compromised:
//    a. Operator rotates: process.env.GMAIL_SERVICE_ACCOUNT_KEY = newKey
//    b. All agents using this credential see new key on next call
//    c. No agent DB rows to update (env var is single source of truth)
```

### MCP tool adapter

```typescript
export async function createGmailMCPTool(opts: {
  credentialEnvVar: string;
  stateStore: StateStore;
}): Promise<MCPTool> {
  return {
    name: 'SEND_EMAIL',
    call: async (args, context) => {
      // 1. Load credential from env
      const credential = process.env[opts.credentialEnvVar];
      if (!credential) {
        throw new Error(`Credential ${opts.credentialEnvVar} not found in environment`);
      }
      
      // 2. Check account binding
      const bindings = await opts.stateStore.listAccountBindings(context.agentId);
      const binding = bindings.find(b => b.capabilities.includes('SEND_EMAIL'));
      if (!binding || binding.revokedAt) {
        throw new Error('SEND_EMAIL capability not granted');
      }
      
      // 3. Execute Gmail API
      const gmail = new gmail.gmail_v1.Gmail({
        auth: new google.auth.GoogleAuth({
          credentials: JSON.parse(credential),
        }),
      });
      
      const result = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: Buffer.from(`To: ${args.to}\n\n${args.body}`).toString('base64'),
        },
      });
      
      return { messageId: result.data.id };
    },
  };
}
```

---

## Why this design?

**Question:** Why environment variables and not database?  
**Answer:** 
- Credentials must never be at rest in database (audit liability, compliance risk)
- Environment variables are immutable during a run; easy to rotate by restarting process
- Standard DevOps practice (12-factor app)

**Question:** Why account binding and not global tool access?  
**Answer:**
- Agents can have different capabilities (Alice can send email, Bob can only read)
- Account binding is the permission boundary (see ADR 001)
- Auditable: every binding has `boundBy` and `boundAt`

**Question:** What if agent needs multiple accounts' credentials?  
**Answer:** Create multiple bindings, one per account.

```typescript
await bindAccountToAgent({
  accountId: 'alice@company.com',
  agentId: agent.id,
  capabilities: ['SEND_EMAIL'],
});

await bindAccountToAgent({
  accountId: 'bob@company.com',
  agentId: agent.id,
  capabilities: ['SEND_EMAIL'],
});

// Agent can now use either account's credential
// Must specify which account when calling:
await agent.call('SEND_EMAIL', {
  from: 'alice@company.com',  // Specify which account
  to: 'recipient@example.com',
  body: '...',
});
```

---

## Testing: MCP fixtures

For testing, use **fixtures** (mock MCP servers):

```typescript
// Test setup
const gmailFixture = new GmailMCPFixture({
  mode: 'mock', // Don't call real Gmail API
});

const agent = await mesh.spawnAgent('analyst', {
  tools: [gmailFixture.tool()],
});

// Test: Mock Gmail server records the email
await agent.call('SEND_EMAIL', { to: 'bob@company.com', body: 'test' });

// Assert: Check fixture recorded the call
expect(gmailFixture.sentEmails).toHaveLength(1);
expect(gmailFixture.sentEmails[0].to).toBe('bob@company.com');
```

### Fixture interface

```typescript
interface MCPFixture {
  mode: 'mock' | 'live';  // mock = don't call external system
  tool(): MCPTool;        // Return the tool
  state: any;             // Recorded state (emails sent, files created, etc.)
}

// Example: Mock file system
class FileWatchMCPFixture implements MCPFixture {
  mode = 'mock';
  state = { files: new Map(), watchers: [] };
  
  tool(): MCPTool {
    return {
      name: 'WATCH_FILE',
      call: async (args) => {
        this.state.watchers.push({ path: args.path, pattern: args.pattern });
        return { watcherId: args.path };
      },
    };
  }
}

// Usage in tests
const fixture = new FileWatchMCPFixture();
expect(fixture.state.watchers).toHaveLength(0);

await agent.call('WATCH_FILE', { path: '/data', pattern: '*.json' });

expect(fixture.state.watchers).toHaveLength(1);
expect(fixture.state.watchers[0].path).toBe('/data');
```

---

## Production checklist

- [ ] Credential env var is set before app starts
- [ ] Env var is injected at deployment time (not committed to git)
- [ ] Account binding exists and is not revoked
- [ ] MCP tool checks binding at runtime
- [ ] Credential is rotated annually (or on compromise)
- [ ] Monitoring alerts if tool calls fail with "Capability denied"
- [ ] Audit log records which agent called which MCP tool and which account was used

---

## Scaling

### 100 agents, each bound to 2-5 accounts

- **Bindings table:** 100 agents × 3 accounts = 300 rows (tiny)
- **Credential lookup:** O(1) environment variable read
- **Binding validation:** O(bindings per agent) = O(5) per MCP call (fast)

**Optimization:** Cache bindings in-memory (TTL 1 hour). Refresh on expiry or revocation event.

---

## Credential rotation

### Scenario: Gmail API key compromised

**Before rotation:**
```
process.env.GMAIL_SERVICE_ACCOUNT_KEY = "old_key_123"
Agent calls SEND_EMAIL
→ MCP uses old_key_123
→ Google API accepts (key still valid, not yet revoked)
```

**Rotation steps:**
1. Generate new key in Google Cloud Console
2. Update env var: `export GMAIL_SERVICE_ACCOUNT_KEY="new_key_456"`
3. Restart app (or update env without restart if supported)
4. Revoke old key in Google Cloud Console

**After rotation:**
```
process.env.GMAIL_SERVICE_ACCOUNT_KEY = "new_key_456"
Agent calls SEND_EMAIL
→ MCP uses new_key_456
→ Google API accepts
Old key no longer works (revoked)
```

**No agent DB rows to update** — env var is single source of truth.

---

## Alternatives considered

### 1. Encrypted credentials in database
Store encrypted keys in `tool_credentials` table.

**Rejected:** Still a database, compliance burden. Environment variables are simpler.

### 2. Vault/secrets manager (HashiCorp Vault, AWS Secrets Manager)
External secrets service.

**Rejected:** Adds operational complexity for typical use case. Start with env vars, move to Vault if needed.

### 3. Globally enable all tools
All agents can use all MCP tools.

**Rejected:** No permission boundary. Violates least privilege (ADR 001).

## Consequences

**Positive:**
- Credentials never stored at rest (compliance-friendly)
- Account binding controls access (audit trail)
- Credential rotation is simple (change env var, restart)
- Fixtures enable testing without real API calls

**Negative:**
- Environment variables are process-global (shared across agents)
- Compromise of one account affects all agents using that credential
- Requires secure DevOps practices (no committing keys to git)

---

## Related

- [Account Model](./account-model.md) — Account binding invariants
- [MCP Integration](../mcp-integration.md) — How MCP tools are bound to agents
- [ADR 001: Account Binding](./001-account-binding-invariants.md) — Permission model
- [@weaveintel/live-agents](../../packages/live-agents/README.md) — MCP tool registration
