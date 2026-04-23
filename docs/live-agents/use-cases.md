# Use Cases

Six key scenarios where live-agents shines. Each references an example implementation.

## 1. Long-lived research assistant

**Scenario:** A research team runs iterative analysis over weeks. The agent accumulates findings, adjusts hypotheses, and refines search strategies without losing context.

**Key capability:** `StateStore` persists agent state across restarts. Heartbeat resumes work immediately.

**Example:** `examples/52-live-agents-basic.ts`

**Pattern:**
```typescript
// Day 1: Agent searches literature
const mesh = await createMesh('research-team');
const agent = await mesh.spawnAgent('analyst', {
  instructions: 'Search and summarize papers on COVID-19 variants',
});

// Agent performs research, discovers key papers, updates contracts
// Friday: App shuts down
await mesh.close();

// Monday: App restarts, loads mesh
const mesh2 = await Mesh.load('research-team', stateStore);
const agent2 = await mesh2.getAgent('analyst');

// Agent resumes: it still has findings from Friday
// Heartbeat ticks continue scheduling deeper analysis
```

**Why live-agents:**
- Agent doesn't re-search papers already found (contracts preserve memory)
- Heartbeat scheduler picks up Friday's pending work
- No manual state reconstruction

---

## 2. Promotional workflow automation

**Scenario:** Marketing team creates a promotion (e.g., "End of year 30% off"). An agent monitors sales channels (email, Slack, website analytics), triggers actions (send follow-up email, update inventory alerts), and learns from channel response.

**Key capability:** `MCP` integration connects agent to external systems. `ExternalEvent` and `Capability` enforce safety.

**Example:** `examples/53-live-agents-cross-mesh-account-binding.ts`

**Pattern:**
```typescript
// Setup: Marketing team binds team email to agent
const team = await mesh.spawnAgent('promo-operator', {
  instructions: 'Monitor sales channels and optimize promotion',
});

// Bind Gmail account to agent (human controls binding, not agent)
await bindAccountToAgent({
  accountId: 'marketing@company.com',
  agentId: team.id,
  capabilities: ['GMAIL_SEND', 'GMAIL_READ'], // Fine-grained
});

// Agent can now send promotional follow-ups
// Capability grants ensure agent can't delete personal email or read CEO mailbox

// Heartbeat runs: agent checks sales metrics hourly
// When conversion drops, agent sends follow-up: "Try this variant"
```

**Why live-agents:**
- MCP fixtures mock external systems during development
- Account binding invariants prevent agent from accidentally locking out humans
- Heartbeat continuously optimizes without intervention

---

## 3. Cross-mesh collaboration and handoff

**Scenario:** Two teams (Research + Compliance) collaborate asynchronously. Research discovers a finding; Compliance team must review and approve before publication.

**Key capability:** `Contract` with shared `evidence` ledger. Cross-mesh messaging (Bridge).

**Example:** `examples/54-live-agents-cross-mesh-bridges.ts`

**Pattern:**
```typescript
// Team 1: Research mesh
const researchMesh = await createMesh('research-team');
const researcher = await researchMesh.spawnAgent('analyst');

// Researcher completes analysis
const finding = new Contract({
  type: 'RESEARCH_FINDING',
  statement: 'Variant XYZ has 40% higher transmissibility',
  evidence: [{ tool: 'literature-search', result: [...] }],
});
await researcher.execAction(finding, 'SAVE_CONTRACT');

// Team 2: Compliance mesh
const complianceMesh = await createMesh('compliance-team');
const reviewer = await complianceMesh.spawnAgent('reviewer');

// Bridge connects meshes: research findings → compliance queue
const bridge = new Bridge({
  sourceAgentId: researcher.id,
  targetAgentId: reviewer.id,
  filter: c => c.type === 'RESEARCH_FINDING',
});
await researchMesh.registerBridge(bridge);

// Reviewer sees finding in inbox, reviews evidence, approves or requests changes
// Researcher adjusts findings based on feedback (async collaboration)
```

**Why live-agents:**
- Agents work in separate meshes (isolation, independent scaling)
- Contract evidence is immutable and auditable
- Heartbeat ensures notifications deliver even if reviewer is offline

---

## 4. Compression for long-running agents

**Scenario:** An agent runs for 6 months accumulating millions of interactions. Context window fills; inference becomes expensive. Agent must "remember what matters" without replaying 6 months of history.

**Key capability:** `CompressionStrategy` summarizes daily work into daily summaries and tokens.

**Example:** `examples/55-live-agents-compression.ts`

**Pattern:**
```typescript
// Agent runs daily
const agent = await mesh.spawnAgent('analyst', {
  compressionStrategy: {
    window: 'daily',      // Summarize each day
    summaryPrompt: 'Summarize today\'s findings, key decisions, and open questions',
    tokenBudget: 2000,    // Max tokens per daily summary
    retention: 90,        // Keep 90 daily summaries
  },
});

// Day 1: Agent searches 100 papers → generates findings
// Heartbeat triggers daily summary at midnight
// Summary: "Reviewed 100 papers. Top 3 findings: ..."

// Day 180: Agent has 180 daily summaries (not 100k interactions)
// Model sees: "You've been researching for 6 months. Key findings to date: ..."
// Inference is fast and cheap
```

**Why live-agents:**
- Automatic daily summaries (no manual effort)
- Heartbeat scheduler ensures summaries run at scale
- Token budget guarantees predictable cost

---

## 5. Account binding and credential scoping

**Scenario:** A team has 5 staff members. Only the team lead can approve large transfers. Agents acting on behalf of the team must respect this permission boundary.

**Key capability:** Account binding invariants + `Capability` grants.

**Example:** `examples/56-live-agents-account-binding-guardrail.ts`

**Pattern:**
```typescript
// Team lead: binds their corporate account to the agent
const teamLead = createUser('alice@company.com');
await bindAccountToAgent({
  accountId: teamLead.id,
  agentId: agent.id,
  capabilities: ['APPROVE_TRANSFER_LARGE'],
});

// Junior staff cannot bind their own accounts to agent
// Only the account owner (teamLead) can grant the capability
const junior = createUser('bob@company.com');
await bindAccountToAgent({
  accountId: junior.id,
  agentId: agent.id,
  capabilities: ['SUBMIT_TRANSFER_SMALL'],
});

// At runtime, agent checks grants before calling MCP tool
// agent.call('transfer', { amount: 1000000 })
// → MCP validates: does agent have APPROVE_TRANSFER_LARGE?
// → Only if teamLead is online and has bound capability
// → If not, agent fails or queues for approval

// This prevents agent from escalating its own permissions
```

**Why live-agents:**
- Account binding is human-controlled (not agent-self-service)
- Capability grants are immutable after binding
- MCP tool calls validate permissions at runtime

---

## 6. Mesh administration and telemetry

**Scenario:** An operator runs 100+ agents across 10 meshes. They need observability: How many agents are active? Which have stale heartbeats? Which consumed the most API quota? Which had errors?

**Key capability:** HTTP API with mesh/agent/account/heartbeat endpoints. Admin dashboard queries this state.

**Example:** `examples/57-live-agents-mesh-administration.ts` and `apps/live-agents-demo`

**Pattern:**
```typescript
// GET /api/meshes → List all meshes with agent counts
[
  { id: 'research-team', agents: 5, lastSeen: '2024-01-15T10:30Z' },
  { id: 'compliance-team', agents: 2, lastSeen: '2024-01-15T10:28Z' },
]

// GET /api/agents/:agentId → Agent status
{
  id: 'analyst-001',
  meshId: 'research-team',
  status: 'ACTIVE',
  lastHeartbeat: '2024-01-15T10:30:15Z',
  heartbeatAge: '45 seconds',
  contracts: 127,
  messages: 342,
}

// GET /api/heartbeat/ticks → Pending work
[
  { id: 'tick-001', agentId: 'analyst-001', scheduledFor: '2024-01-15T10:31Z', status: 'SCHEDULED' },
  { id: 'tick-002', agentId: 'analyst-001', scheduledFor: '2024-01-15T11:00Z', status: 'SCHEDULED' },
]

// POST /api/heartbeat/run-once → Force immediate heartbeat for debugging
// Useful when agent is stuck; admin manually triggers retry
```

**Why live-agents:**
- Operators see real-time agent status without SSH-ing into production
- Heartbeat telemetry shows pending work and failure rates
- HTTP API enables custom dashboards (Grafana, Datadog, etc.)

---

## 7. Reference implementation (apps/live-agents-demo)

**Complete end-to-end app** combining all concepts:

- **Meshes & Agents:** Create, list, manage
- **Contracts & Messages:** Submit work, check results
- **Account binding:** Bind Gmail account to agent
- **MCP integration:** Agent can read/send email via Gmail MCP
- **Heartbeat:** Background workers process ticks
- **StateStore:** PostgreSQL (production-ready)
- **HTTP API:** Full CRUD for all entities
- **UI:** Interactive HTML form to test all flows

**Run it:**
```bash
npm run dev -w @weaveintel/live-agents-demo
# Opens http://localhost:3600
# UI available at /ui
# API at /api/...
```

**Test it:**
```bash
npm test -w @weaveintel/live-agents-demo
# api.test.ts covers full workflow
```

---

## Summary table

| Use Case | Key Feature | Example | Scale |
|----------|-------------|---------|-------|
| Research assistant | Long-lived state | `52-basic` | 1 agent, months |
| Promotion workflow | MCP integration | `53-account-binding` | 1-10 agents, weeks |
| Cross-team collaboration | Contract + Bridge | `54-cross-mesh` | 2-10 meshes, async |
| Cost optimization | Compression | `55-compression` | 1 agent, 6+ months |
| Permission boundaries | Account binding | `56-guardrail` | 5+ agents, humans in control |
| Mesh telemetry | HTTP API | `57-admin` + demo app | 100+ agents, real-time |

---

## Related

- [`@weaveintel/live-agents`](../packages/live-agents/README.md) — Framework
- [Account Model](./account-model.md) — Security invariants
- [Compression Guide](./compression-guide.md) — Summarization strategy
- [StateStore Guide](./statestore-guide.md) — Persistence layer
- [MCP Integration](./mcp-integration.md) — External systems
