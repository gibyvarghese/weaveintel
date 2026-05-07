# @weaveintel/live-agents

Multi-agent orchestration framework for TypeScript. Agents are long-lived, asynchronous processes that coordinate within **meshes** using explicit **contracts**, **messaging**, and **external integrations** via MCP.

**Core principle:** Agents are not security principals. **Accounts** are principals. Agents act *as* accounts with human-granted, narrowly-scoped bindings.

## Quick start

### 1. Create a mesh and agent

```typescript
import { weaveInMemoryStateStore } from '@weaveintel/live-agents';

const stateStore = weaveInMemoryStateStore();

// Create a mesh (namespace for agents)
const mesh = {
  id: 'team-1',
  tenantId: 'acme',
  name: 'Sales Team',
  charter: 'Respond to customer inquiries',
  status: 'ACTIVE',
  dualControlRequiredFor: ['MESH_BRIDGE'],
  createdAt: new Date().toISOString(),
};
await stateStore.saveMesh(mesh);

// Create an agent within the mesh
const agent = {
  id: 'agent-support-1',
  meshId: 'team-1',
  name: 'Support Agent',
  role: 'Responder',
  contractVersionId: 'contract-v1',
  status: 'ACTIVE',
  createdAt: new Date().toISOString(),
  archivedAt: null,
};
await stateStore.saveAgent(agent);

// Define the agent's contract (behavior, budget, attention policy)
const contract = {
  id: 'contract-v1',
  agentId: 'agent-support-1',
  version: 1,
  persona: 'Helpful, concise support agent',
  objectives: 'Resolve customer inquiries within SLA',
  successIndicators: 'First-contact resolution rate > 80%',
  budget: { monthlyUsdCap: 1000, perActionUsdCap: 10 },
  workingHoursSchedule: { timezone: 'UTC', cronActive: '9-17 * * * 1-5' },
  accountBindingRefs: [],
  attentionPolicyRef: 'default-support',
  reviewCadence: 'P7D', // weekly reviews
  contextPolicy: {
    compressors: [{ id: 'hierarchical-summary', onDemand: false }],
    weighting: [{ id: 'recency-weighted' }],
    budgets: {
      attentionTokensMax: 4000,
      actionTokensMax: 2000,
      handoffTokensMax: 1000,
      reportTokensMax: 500,
      monthlyCompressionUsdCap: 50,
    },
    defaultsProfile: 'standard',
  },
  createdAt: new Date().toISOString(),
};
await stateStore.saveContract(contract);
```

### 2. Send a message to the agent

```typescript
const message = {
  id: 'msg-1',
  meshId: 'team-1',
  fromType: 'HUMAN',
  fromId: 'human:user-123',
  fromMeshId: null,
  toType: 'AGENT',
  toId: 'agent-support-1',
  kind: 'ASK',
  replyToMessageId: null,
  threadId: 'thread-1',
  contextRefs: [],
  contextPacketRef: null,
  expiresAt: null,
  priority: 'NORMAL',
  status: 'PENDING',
  createdAt: new Date().toISOString(),
  deliveredAt: null,
  readAt: null,
  processedAt: null,
  subject: 'Password reset not working',
  body: 'I cannot reset my password. I click the link and get an error.',
};
await stateStore.saveMessage(message);
```

### 3. Run the heartbeat to process messages

```typescript
import { createHeartbeat, createActionExecutor } from '@weaveintel/live-agents';

const heartbeat = createHeartbeat({
  stateStore,
  workerId: 'worker-1',
  concurrency: 4,
  actionExecutor: createActionExecutor(),
});

// Process one batch of ticks
const result = await heartbeat.tick(weaveContext({ userId: 'human:ops' }));
console.log(`Processed ${result.processed} ticks`);
```

### 4. Check the agent's inbox

```typescript
const inbox = await stateStore.listMessagesForRecipient('AGENT', 'agent-support-1');
console.log(inbox); // see all messages (PENDING, PROCESSED, etc.)
```

## Key concepts

### Meshes

A **mesh** is a namespace for agents. Agents within a mesh can message each other, grant capabilities, and coordinate work. Meshes are isolated by tenant.

- **Immutable scope:** You cannot move an agent between meshes.
- **Dual-control:** For sensitive operations (bridges, escalations), require dual authorization.

### Agents

Agents are **long-lived, asynchronous workers** that:

- Process messages from inboxes
- Make decisions via **attention policies**
- Execute actions (internal, MCP-based, or escalations)
- Maintain working memory and compressed context
- Can grant and request capabilities

**Agents are not security principals.** They're actors. Only **humans** can grant **account bindings** (binding an external account like Gmail to an agent).

### Contracts

A **contract** is the agent's active ruleset:

- **Persona:** Character and tone (LLM-facing text)
- **Objectives:** What the agent is trying to accomplish
- **Success indicators:** How we measure success
- **Budget:** Monthly USD cap, per-action cap, compression budget
- **Attention policy:** How the agent picks the next action
- **Context policy:** Which compressors to use, token budgets
- **Review cadence:** How often a human should review the agent's work

Contracts are immutable. To change an agent's behavior, issue a new contract via **promotion**.

### Attention Policy

An **attention policy** is a function that looks at an agent's inbox and picks the next action:

```typescript
interface AttentionPolicy {
  key: string;
  decide(context: {
    inbox: Message[];
    workingMemory: WorkingMemory;
    accountBindings: AccountBinding[];
    grants: CapabilityGrant[];
  }): Promise<AttentionAction>;
}

type AttentionAction =
  | { type: 'ProcessMessage'; messageId: string }
  | { type: 'RunRoutine'; routineKey: string }
  | { type: 'Escalate'; recipientMeshId?: string }
  | { type: 'NoopRest'; nextTickAt: string };
```

The framework ships a `standard-v1` policy. Applications can define custom policies.

### Model-driven attention (automatic LLM invocation)

`@weaveintel/live-agents` now supports an attention policy that calls an LLM on each tick,
including contract, inbox, backlog, and active account-binding context in the model input.

Use `createModelAttentionPolicy(...)` directly:

```typescript
import { createModelAttentionPolicy } from '@weaveintel/live-agents';

const attentionPolicy = createModelAttentionPolicy({
  model, // any @weaveintel/core Model
});
```

Or route model selection per request using `@weaveintel/routing`:

```typescript
import { createModelAttentionPolicy } from '@weaveintel/live-agents';

const attentionPolicy = createModelAttentionPolicy({
  modelRouter,
  routingPolicy,
  resolveModel: async ({ decision }) => {
    return modelRegistry.get(`${decision.providerId}:${decision.modelId}`)!;
  },
});
```

For automatic heartbeat wiring, pass `modelAttentionPolicy` to `createHeartbeat(...)`:

```typescript
const heartbeat = createHeartbeat({
  stateStore,
  workerId: 'worker-1',
  concurrency: 4,
  modelAttentionPolicy: {
    modelRouter,
    routingPolicy,
    resolveModel,
  },
  actionExecutor: createActionExecutor(),
});
```

Safety behavior:

- Model output is parsed as JSON and validated against supported `AttentionAction` shapes.
- Unknown/invalid actions are rejected.
- Required references (`messageId`, `backlogItemId`) are constrained to known context IDs.
- On parse/validation/model failure, policy falls back to `createStandardAttentionPolicy()`.

### Account Bindings

An **account binding** represents a **human-granted** permission for an agent to use an external account (e.g., Gmail):

```typescript
interface AccountBinding {
  id: string;
  agentId: string;
  account: {
    id: string;
    type: 'email' | 'slack' | 'gdrive' | ...;
    handle: string; // user@example.com, @channel, etc.
  };
  grantedByHumanId: string; // Only humans can grant
  grantedAt: Date;
  revokedAt: Date | null;
  scope: string[]; // ['read:inbox', 'send:message']
}
```

**Invariant:** Only humans can grant account bindings. Agents cannot bind accounts.

### Messages and Inbox

Messages flow asynchronously through agent inboxes. An agent processes messages by deciding what to do (reply, escalate, route) via its attention policy.

- **Status:** PENDING → PROCESSED (or SKIPPED/FAILED)
- **Threading:** Messages in the same thread share context
- **Priority:** NORMAL, URGENT, LOW influence queue order

### Actions

An agent decides what action to take:

1. **ProcessMessage** → read the message, generate a reply, update state, mark as PROCESSED
2. **Escalate** → forward to a manager or different mesh
3. **Routine** → autonomous work (send weekly digest, cleanup stale data)
4. **NoopRest** → nothing to do right now, sleep until `nextTickAt`

External actions (sending emails, posting to Slack) flow through **MCP sessions** — the agent calls MCP tools directly.

### MCP Integration

Agents access external systems (Gmail, Google Drive, Slack) via **MCP tools**. The framework does not bundle credentials or call external systems directly.

**Pattern:**
1. Human grants an account binding (e.g., agent can read/send as user@example.com)
2. At runtime, `Heartbeat` looks up the binding → credential ref
3. Agent's action executor opens an `McpSession` with the right credentials
4. Agent calls MCP tool (read inbox, send email, etc.)
5. MCP session handles authentication and returns results
6. `OutboundActionRecord` audit trail is written

See [mcp-integration.md](../live-agents/mcp-integration.md) for details.

### Context Compression

Agents accumulate messages, decisions, and working memory over time. To stay within token budgets, the framework **compresses context** using ten strategies:

1. Hierarchical summarization
2. Semantic retrieval
3. Episodic memory (self-report + classifier)
4. Rolling conversation summary
5. Structural state snapshot
6. Timeline compression
7. Knowledge graph distillation
8. Relevance-decayed retrieval
9. Handoff packets (for cross-mesh handoff)
10. Contract-anchored weighting

Compression runs **outside the heartbeat loop** to avoid blocking message processing. See [compression-guide.md](../live-agents/compression-guide.md).

### Capabilities and Grants

Agents can request and be granted **capabilities** (e.g., "write to shared spreadsheet", "send marketing emails"). A human manager approves grants. Grants have:

- **Scope:** What the grant covers (e.g., `tool:email` for sending emails)
- **Probation period:** Auto-revoke if not used or misused
- **Evidence:** Why this grant was issued

**Invariant:** Agents cannot self-grant. Break-glass (emergency override) requires post-review.

### Promotions

A **promotion** is when an agent requests (or a manager issues) a new **contract version**. Promotions must be issued by an agent with `contractAuthority`.

**Invariant:** Agents cannot promote themselves.

## StateStore

The persistence boundary. Two implementations ship; applications provide others.

```typescript
interface StateStore {
  // Meshes
  saveMesh(mesh: Mesh): Promise<void>;
  loadMesh(id: string): Promise<Mesh | null>;
  listMeshesByTenant(tenantId: string): Promise<Mesh[]>;

  // Agents
  saveAgent(agent: LiveAgent): Promise<void>;
  loadAgent(id: string): Promise<LiveAgent | null>;
  listAgentsByMesh(meshId: string): Promise<LiveAgent[]>;

  // Contracts
  saveContract(contract: AgentContract): Promise<void>;
  loadContract(id: string): Promise<AgentContract | null>;
  loadActiveContract(agentId: string): Promise<AgentContract | null>;

  // Messages
  saveMessage(message: Message): Promise<void>;
  loadMessage(id: string): Promise<Message | null>;
  listMessagesForRecipient(type: 'AGENT' | 'MESH', id: string): Promise<Message[]>;

  // Heartbeat
  claimNextTicks(workerId: string, count: number, now: Date): Promise<HeartbeatTick[]>;
  saveHeartbeatTick(tick: HeartbeatTick): Promise<void>;

  // Accounts & bindings
  saveAccountBinding(binding: AccountBinding): Promise<void>;
  listActiveAccountBindingsForAgent(agentId: string, at: Date): Promise<AccountBinding[]>;

  // Capabilities
  saveCapabilityGrant(grant: CapabilityGrant): Promise<void>;
  listActiveGrants(agentId: string, at: Date): Promise<CapabilityGrant[]>;

  // Context
  saveWorkingMemory(agentId: string, memory: WorkingMemory): Promise<void>;
  loadWorkingMemory(agentId: string): Promise<WorkingMemory | null>;

  // Utilities
  transaction<T>(fn: (tx: StateStore) => Promise<T>): Promise<T>;
}
```

**Implementations:**

- `weaveInMemoryStateStore()` — in-memory, default for examples and tests
- `weaveRedisStateStore({ url })` — Redis ephemeral coordination store
- Applications provide their own (e.g., `PostgresStateStore` in `apps/live-agents-demo`)

See [statestore-guide.md](../live-agents/statestore-guide.md) for implementation patterns.

## Runnables

The framework ships three main runnables (callable classes):

### Heartbeat

Processes agent ticks, picks actions, executes them.

```typescript
const heartbeat = createHeartbeat({
  stateStore,
  workerId: 'worker-1',
  concurrency: 4, // process 4 ticks in parallel
  actionExecutor: createActionExecutor(),
  attentionPolicy: customPolicy, // optional; defaults to standard-v1
});

await heartbeat.tick(ctx); // process one batch
await heartbeat.run(ctx);  // run continuously
await heartbeat.stop();    // graceful shutdown
```

### CompressionMaintainer

Runs context compressors on a schedule.

```typescript
const maintainer = new CompressionMaintainer({
  stateStore,
  memory: weaveMemory(),
  models: weaveModel({ provider: 'anthropic' }),
});

await maintainer.run(ctx); // runs in background
```

### ExternalEventHandler

Routes incoming events (emails, webhooks) to agent inboxes.

```typescript
const handler = new ExternalEventHandler({
  stateStore,
  observability: tracer,
});

// Called by MCP subscribers when an event arrives
await handler.process({ /* ExternalEvent */ }, ctx);
```

## Examples

See `examples/` for end-to-end use cases:

- `52-live-agents-basic.ts` — Single agent, single message, in-memory
- `53-live-agents-research-team.ts` — 4-agent team with capability grants
- `54-live-agents-with-account.ts` — Agent with account binding (fixture MCP)
- `55-live-agents-promotion.ts` — Promotion request and issuance
- `56-live-agents-cross-mesh.ts` — Cross-mesh messaging with bridge
- `57-live-agents-compression.ts` — 30-day simulated run with compression
- `58-live-agents-demo-e2e.ts` — Reference app API end-to-end
- `59-live-agents-full-framework.ts` — Complete framework demonstration (Phase 16)

## Architecture principles

### Framework, not platform

`@weaveintel/live-agents` is a **framework**, not a platform. It provides:

- Type-safe primitives (Mesh, Agent, Contract, Message, etc.)
- State management via `StateStore`
- Runnables (Heartbeat, CompressionMaintainer, ExternalEventHandler)
- MCP integration patterns

It does **not** provide:

- Database persistence (apps bring their own)
- UI or dashboards
- Process management (apps integrate runnables into their process model)
- ML/inference (apps wire in their models)

### Async-first

All operations are **asynchronous**. There are no synchronous ask-and-wait primitives. Message processing is fully asynchronous to support scale and resilience.

### Accounts are principals, agents are actors

- **Agents** are workers that process messages and make decisions
- **Accounts** are external identities (Gmail, Slack, etc.)
- Only **humans** can grant account bindings
- Agents act *as* accounts with scoped permissions

### MCP for external, direct for internal

- **External systems** (Gmail, Slack, Google Drive) → accessed via MCP tools
- **Internal coordination** (messaging, grants, promotions) → direct async calls

### One tool per system

`@weaveintel/tools-gmail` handles both inbox reads and email sends. Operations are tagged; calling code decides which to use.

## Documentation

- [Account Model](../live-agents/account-model.md) — Why accounts are principals, threat model, security patterns
- [MCP Integration](../live-agents/mcp-integration.md) — How MCP tools integrate, credential patterns
- [Compression Guide](../live-agents/compression-guide.md) — Ten strategies, tuning, budgets
- [StateStore Guide](../live-agents/statestore-guide.md) — Implementing StateStore, examples
- [Use Cases](../live-agents/use-cases.md) — Common patterns, anti-patterns
- [ADRs](../live-agents/ADR/) — Architectural decisions and rationales

## Testing

- Unit tests with `InMemoryStateStore`
- Integration tests with `RedisStateStore`
- Examples run in CI with fake models
- Fixture and live-sandbox tests for MCP tools

## First-class capabilities (Phases 1–7)

`@weaveintel/live-agents` is a **temporal extension** of `weaveAgent` from `@weaveintel/agents`, not a parallel implementation. Every capability that `weaveAgent` exposes as an injected slot is also injected into a live-agent — either reusing the same implementation, or extending it with a per-tick variant.

### Model resolution: pinned or per-tick

```typescript
import { weaveLiveAgent, weaveModelResolver } from '@weaveintel/live-agents';

// Option A — pinned model (parity with weaveAgent)
const { handler } = weaveLiveAgent({
  name: 'support',
  model: openaiModel,
  systemPrompt: 'You are a helpful support agent.',
});

// Option B — per-tick resolver (live-agents extension)
const resolver = weaveModelResolver({ model: openaiModel });
const { handler } = weaveLiveAgent({
  name: 'support',
  modelResolver: resolver,
  systemPrompt: 'You are a helpful support agent.',
});
```

For DB-backed routing (model_pricing → SmartRouter → cached Model factory), use `weaveDbModelResolver` from `@weaveintel/live-agents-runtime`. See `examples/91`, `92`, `95`.

### Policy: tool approval, rate limit, audit, break-glass

```typescript
import { weaveLiveAgent, weaveLiveAgentPolicy } from '@weaveintel/live-agents';

const policy = weaveLiveAgentPolicy({
  policyResolver,    // ToolPolicyResolver — risk gating
  approvalGate,      // ToolApprovalGate — requireApproval=true blocks tools
  rateLimiter,       // ToolRateLimiter — per-window quotas
  auditEmitter,      // ToolAuditEmitter — every call persisted
});

const { handler } = weaveLiveAgent({ name: 'ops', model, tools, policy });
```

When any of the four primitives is set, every tool call inside the agent's ReAct loop is wrapped via `createPolicyEnforcedRegistry` from `@weaveintel/tools`. See `examples/93`.

### DB-driven mesh hydration: one call

```typescript
import { weaveLiveMeshFromDb } from '@weaveintel/live-agents-runtime';

const handle = await weaveLiveMeshFromDb(db, {
  store,
  modelResolver,        // optional — per-tick model selection
  policy,               // optional — first-class policy bundle
  handlerRegistry,      // optional — defaults to createDefaultHandlerRegistry()
  attentionPolicyKey,   // optional — DB key from live_attention_policies
});

await handle.stop();
```

`weaveLiveMeshFromDb` composes `provisionMesh` (optional) → handler registry → heartbeat supervisor → `bridgeRunState`. New apps should use this; never wire the primitives by hand. See `examples/96`.

### Declarative `prepare()`: DB-driven recipe (Phase 2 of the DB-Driven Capability Plan)

Instead of writing a `prepare()` callback in code, you can store a JSON **recipe** on the agent row (`live_agents.prepare_config_json`) and let the runtime synthesise the prepare per tick.

Recipe shape:

```jsonc
{
  "systemPrompt": "You are a helpful agent."           // literal string
  // OR: { "promptKey": "live-agent.observer", "variables": { ... } }
  "tools": "$auto",                                     // forwards ctx.tools
  "userGoal": { "from": "inbound.body" }                // or "inbound.subject" | "inbound"
  // OR: { "template": "Subject: {{subject}}\nBody: {{body}}" }
  // OR: literal string
  "memory": { "windowMessages": 50, "summarizer": "..." }   // parsed; enforced in a later phase
}
```

Runtime API (in `@weaveintel/live-agents-runtime`):

```typescript
import { parsePrepareConfig, dbPrepareFromConfig } from '@weaveintel/live-agents-runtime';

const recipe = parsePrepareConfig(agentRow.prepare_config_json);   // null | PrepareConfig | throws on malformed
const prepare = dbPrepareFromConfig(recipe, {
  resolvePromptText: async (promptKey) => db.getPromptText(promptKey),
});
```

Resolution rules:
- **Caller-supplied `prepare` always wins.** If `weaveLiveAgent({ prepare })` is set, the recipe is ignored. This preserves back-compat.
- `systemPrompt.promptKey` requires `prepareDeps.resolvePromptText`; missing → throws at synthesis time.
- `userGoal.from` defaults to `inbound.body`, falling back to `inbound.subject` when body is nullish.
- `userGoal.template` interpolates `{{subject}}` and `{{body}}` from the inbound message.
- `tools: "$auto"` forwards the per-tick tools registry from `ctx.tools` (so policy gating still applies).
- `memory` is parsed but not enforced today — forward-compatible for Phase 6+.

Admin: set `prepare_config_json` on a `live_agents` row via `PUT /api/admin/live-agents/:id` (or POST on create). The generic supervisor (`generic-supervisor-boot.ts` in geneweave) injects `prepareDeps.resolvePromptText` automatically. See `examples/98`.

### Naming convention

- `weave*` — user-facing constructor that returns a runnable thing (agent, mesh, store, resolver, policy). Use `weaveLiveAgent`, `weaveLiveMeshFromDb`, `weaveLiveAgentFromDb`, `weaveModelResolver`, `weaveDbModelResolver`, `weaveLiveAgentPolicy`, `weaveAgentOverlayResolver`.
- `create*` — internal infrastructure factory (registry, dispatcher, scheduler). Use `createDefaultHandlerRegistry`, `createHeartbeat`, `createActionExecutor`, `createHeartbeatSupervisor`, `createCompressionMaintainer`.
- Types use `PascalCase` nouns (`LiveAgent`, `Mesh`, `ModelResolver`, `LiveAgentPolicy`).

`createAgenticTaskHandler` is `@deprecated` — use `weaveLiveAgent`. The alias will be removed one minor cycle after Phase 4.

### Migration cheatsheet

| Was | Now |
| --- | --- |
| `createAgenticTaskHandler({ model, prepare })` | `weaveLiveAgent({ model, prepare })` |
| Hand-wired `createHeartbeatSupervisor + provisionMesh + ...` | `weaveLiveMeshFromDb(db, { ... })` |
| App-local model routing closure | `weaveDbModelResolver({ listCandidates, routeModel, getOrCreateModel })` |
| App-local tool policy plumbing | `weaveLiveAgentPolicy({ policyResolver, approvalGate, rateLimiter, auditEmitter })` |

## Related packages

- `@weaveintel/memory` — Working memory and context compression
- `@weaveintel/identity` — Credential management
- `@weaveintel/tools-*` — MCP servers for external systems
- `@weaveintel/a2a` — Agent-to-agent communication
- `@weaveintel/replay` — Replay and deterministic replay
- `@weaveintel/live-agents-runtime` — DB hydration, model resolver, policy bundle
- `apps/live-agents-demo` — Reference application with Postgres persistence, REST API, worker containers

## License

MIT
