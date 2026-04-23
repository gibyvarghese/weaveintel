# MCP Integration

## Overview

Agents access external systems (Gmail, Slack, Google Drive) via **MCP (Model Context Protocol) tools**. The framework does not bundle credentials or call external systems directly.

## Pattern

### 1. Account binding

A human grants an agent access to an account:

```typescript
const binding = {
  id: 'binding-1',
  agentId: 'agent-support',
  accountId: 'account-support-gmail',
  grantedByHumanId: 'human:admin-1',
  grantedAt: new Date(),
  revokedAt: null,
  scope: ['read:inbox', 'send:message'],
};
await stateStore.saveAccountBinding(binding);
```

### 2. Agent picks an action

During heartbeat, the agent's attention policy decides what to do:

```typescript
const action = await attentionPolicy.decide({
  inbox: messages,
  workingMemory,
  accountBindings: activeBindings,
  grants: activeGrants,
});

// Result might be:
// { type: 'ProcessMessage', messageId: 'msg-1' }
```

### 3. Action executor opens MCP session

When executing an action that needs external access, the action executor:

1. Looks up the account binding
2. Resolves credentials from `@weaveintel/identity` vault
3. Opens an MCP session
4. Calls the MCP tool
5. Records `OutboundActionRecord`

```typescript
const session = await mcpClient.openSession({
  server: gmailMcpServerRef,
  credentials: await identityVault.resolve(binding.accountId),
});

const result = await session.call('inbox.list', {});

await stateStore.saveOutboundActionRecord({
  id: 'out-1',
  agentId: 'agent-support',
  bindingId: 'binding-1',
  toolName: 'gmail.inbox.list',
  inputPreview: '{}',
  resultPreview: `${result.messages.length} messages`,
  status: 'SENT',
  sentAt: new Date(),
  externalRef: null,
  purposeProse: 'Checking for new support tickets',
  summaryProse: `Found ${result.messages.length} new messages`,
  errorProse: null,
  createdAt: new Date(),
});
```

## MCP Tools (Phase 10+)

Each tool is a separate MCP server package. All follow the same pattern:

| Package | System | Operations |
|---|---|---|
| `@weaveintel/tools-gmail` | Gmail | `inbox.list`, `inbox.read`, `inbox.search`, `send`, `label`, `thread`, `subscribe` |
| `@weaveintel/tools-outlook` | Microsoft Outlook | Same shape as Gmail |
| `@weaveintel/tools-imap` | Generic IMAP | `list`, `read`, `search`, `subscribe` |
| `@weaveintel/tools-gdrive` | Google Drive | `list`, `read`, `create`, `update`, `share`, `subscribe` |
| `@weaveintel/tools-onedrive` | OneDrive | Same shape as Google Drive |
| `@weaveintel/tools-dropbox` | Dropbox | Same shape as OneDrive |
| `@weaveintel/tools-gcal` | Google Calendar | `list-events`, `create-event`, `update-event`, `rsvp`, `subscribe` |
| `@weaveintel/tools-outlook-cal` | Outlook Calendar | Same shape as Google Calendar |
| `@weaveintel/tools-slack` | Slack | `post`, `read-channel`, `search`, `subscribe` |
| `@weaveintel/tools-webhook` | HTTP webhooks | `receive` (subscribe), `post` (send) |
| `@weaveintel/tools-filewatch` | Local FS | `list`, `read`, `write`, `subscribe` |

### One tool, both directions

**Key principle:** A single `@weaveintel/tools-gmail` package handles both reading and sending emails.

- **Read operations:** `inbox.list`, `inbox.read`, `inbox.search`
- **Write operations:** `send`, `label`, `thread.move`
- **Subscribe:** `inbox.subscribe` (fires when new emails arrive)

The agent's account binding scope determines which operations it can call:

```typescript
// Scope: ['read:inbox', 'send:message']
// Agent can call: inbox.list, inbox.read, inbox.search, send
// Agent cannot call: label, thread.move, delete
```

## Credential handling

Credentials flow through `@weaveintel/identity`. The agent framework never stores raw secrets.

### Pattern

1. Credential stored in vault (e.g., Azure Key Vault, HashiCorp Vault)
2. Account binding references the vault ID: `credentialVaultRef`
3. At runtime, identity vault resolves the credential
4. MCP session uses it to authenticate

```typescript
// Account setup (one-time)
const account = {
  id: 'account-support-gmail',
  type: 'email',
  handle: 'support@acme.com',
  credentialVaultRef: 'kv-secret://gmail-support-oauth',
};

// At runtime
const credentials = await identityVault.resolve(account.credentialVaultRef);
// credentials = { accessToken, refreshToken, ... }

const session = await mcpClient.openSession({
  server: gmailMcpServerRef,
  credentials,
});
```

## MCP server design (for new tools)

When implementing a new tool (e.g., `@weaveintel/tools-jira`):

1. **Use `@weaveintel/mcp-server`** for framework utilities
2. **Define tools** per operation:
   ```typescript
   const tools = [
     {
       name: 'jira.search',
       description: 'Search Jira issues',
       inputSchema: { /* JSON Schema */ },
       execute: async (input, credentials) => {
         // Use credentials to authenticate
         // Make API call
         // Return result
       },
     },
   ];
   ```
3. **Handle credentials** via `@weaveintel/identity`
4. **Emit events** for subscribe operations
5. **Tag with risk level:**
   ```typescript
   tools[0].riskLevel = 'read-only'; // or 'write', 'destructive', etc.
   ```
6. **Add fixture tests** with fake credentials
7. **Add live-sandbox tests** (env-gated) with real sandbox accounts

## Subscription pattern (for event-driven work)

Some tools support subscriptions (e.g., "watch my Gmail inbox for new messages").

```typescript
// In reference app or agent runner
const session = await mcpClient.openSession({
  server: gmailMcpServerRef,
  credentials: await identityVault.resolve(accountId),
});

session.subscribe('inbox.messages', async (event) => {
  // event = { messageId, from, subject, ... }
  
  const externalEvent = {
    id: uuid(),
    accountId,
    sourceType: 'email.received',
    sourceRef: event.messageId,
    receivedAt: new Date(),
    payloadSummary: `Email from ${event.from}: ${event.subject}`,
    payloadContextRef: event.mcpResourceUri,
    processedAt: null,
    producedMessageIds: [],
    processingStatus: 'RECEIVED',
    error: null,
  };

  await eventHandler.process(externalEvent, ctx);
});
```

The `ExternalEventHandler` (Phase 11) matches the event against `EventRoute`s and produces messages into agent inboxes.

## Anti-patterns

### ❌ Agent directly makes HTTP calls

**Bad:**
```typescript
// Don't do this
const response = await fetch('https://gmail.googleapis.com/...', {
  headers: { Authorization: `Bearer ${token}` }
});
```

**Why:** Credentials are embedded. Credential rotation, revocation, and auditing are broken.

**Right:** Use MCP tool. Credentials flow through identity vault.

### ❌ Tool embeds credentials

**Bad:**
```typescript
// In MCP tool
const gmail = new Gmail({ apiKey: process.env.GMAIL_API_KEY });
```

**Why:** Credentials are global. Can't support multi-account or per-agent scoping.

**Right:** Tool receives credentials from caller:
```typescript
execute: async (input, credentials) => {
  const gmail = new Gmail({ accessToken: credentials.accessToken });
  // ...
}
```

### ❌ Tool doesn't tag operations

**Bad:**
```typescript
const tools = [{ name: 'send', execute: ... }];
// No indication if this is risky
```

**Why:** No audit trail. Framework can't enforce approval gates.

**Right:**
```typescript
const tools = [
  {
    name: 'send',
    riskLevel: 'external-side-effect',
    execute: ...
  }
];
```

## Testing

### Fixture tests

```typescript
// Mock MCP server
const fakeGmail = createFakeMcpServer({
  'inbox.list': async () => [
    { messageId: 'msg-1', from: 'customer@example.com', subject: 'Help!' }
  ],
  'send': async (input) => {
    // Pretend to send
    return { messageId: 'out-1', status: 'sent' };
  },
});

// Test agent calling tool
const session = await mcpClient.openSession({
  server: fakeGmail,
  credentials: { fake: true },
});

const messages = await session.call('inbox.list', {});
expect(messages).toHaveLength(1);
```

### Live-sandbox tests

```typescript
// Real credentials (e.g., sandbox Gmail account)
if (process.env.LIVE_GMAIL_SANDBOX_TOKEN) {
  it('can send email via live Gmail', async () => {
    const result = await session.call('send', {
      to: 'test@example.com',
      subject: 'Test',
      body: 'Hello from test',
    });
    expect(result.status).toBe('sent');
  });
}
```

Live-sandbox tests are skipped in CI but run locally or in a staging environment.

## Reference implementation

See `apps/live-agents-demo` for a complete reference:

- Postgres persistence
- MCP session pooling
- Credential resolution from Key Vault
- Worker container subscribing to Gmail
- Event routing to agent inboxes
