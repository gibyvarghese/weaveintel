# weaveIntel

**A TypeScript framework for building production-grade AI applications.**

weaveIntel gives you composable, vendor-neutral building blocks for everything from a single chat completion to a fleet of long-running multi-agent meshes — with tool calling, governance, observability, and resilience built in.

> **New to weaveIntel?** Skip to [Quick Start](#quick-start) for a 5-minute walkthrough, then read [Core Concepts](#core-concepts) to learn the mental model.
> **Looking for the previous README?** See [README.OLD.md](README.OLD.md).

---

## Table of Contents

- [Why weaveIntel](#why-weaveintel)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Capability Walkthroughs](#capability-walkthroughs)
  - [1. Talk to a model](#1-talk-to-a-model)
  - [2. Add tools (`weaveAgent`)](#2-add-tools-weaveagent)
  - [3. Long-running agents (`weaveLiveAgent`)](#3-long-running-agents-weaveliveagent)
  - [4. Connect to external systems (MCP)](#4-connect-to-external-systems-mcp)
  - [5. Multi-agent communication (A2A)](#5-multi-agent-communication-a2a)
  - [6. Governance: policy, approval, audit](#6-governance-policy-approval-audit)
  - [7. Resilience: rate limits, circuit breakers, retries](#7-resilience-rate-limits-circuit-breakers-retries)
  - [8. Memory, RAG, and knowledge graphs](#8-memory-rag-and-knowledge-graphs)
  - [9. Observability and replay](#9-observability-and-replay)
  - [10. Evaluation](#10-evaluation)
- [The geneWeave Reference App](#the-geneweave-reference-app)
- [Examples](#examples) — full catalog of 90+ runnable demos
- [Package Map](#package-map)
- [Deployment](#deployment)
- [Development](#development)

---

## Why weaveIntel

- **Vendor-neutral core.** `@weaveintel/core` is pure contracts and types — zero vendor SDKs. Provider packages (`provider-openai`, `provider-anthropic`, `provider-google`, `provider-ollama`, `provider-llamacpp`) are thin adapters you can swap.
- **Capability-driven routing.** Models declare what they can do; the router picks the right one for each task and falls back automatically.
- **Two complementary agent runtimes.** `weaveAgent` for one-shot or chat-style ReAct loops; `weaveLiveAgent` for long-lived agents that wake on a schedule, accumulate state, and coordinate across a mesh.
- **Tools as first-class governed assets.** Every tool has a risk class, a policy, an audit trail, and goes through a shared resilience pipeline (rate limit + circuit breaker + retry-with-backoff).
- **Production patterns built in.** PII redaction, idempotency, evaluation suites, replay, observability, and human-in-the-loop approval workflows ship with the framework.
- **One reference app proves it all.** [`apps/geneweave`](apps/geneweave) is a full-stack chat app + admin dashboard built only from `@weaveintel/*` packages.

---

## Quick Start

You need **Node.js ≥ 20**, **npm ≥ 10**, **git**, and at least one provider key (OpenAI or Anthropic).

```bash
git clone https://github.com/gibyvarghese/weaveintel.git
cd weaveintel

# 1. Provider key (at least one)
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

# 2. One-shot install + build + seed .env + start the reference app
./scripts/start-geneweave.sh
```

Open [http://localhost:3500](http://localhost:3500), sign up, and you're chatting with an agent that has tools, policies, traces, and a Scientific-Validation pipeline behind it.

> Don't have Node 20+ yet? Run `./scripts/install-node.sh` first (no sudo, uses nvm).
> Want to do it manually? See [Manual setup](#manual-setup) at the bottom.

### Run a standalone example without the app

Most examples don't need the server — just `tsx`:

```bash
npm install         # workspace install
npm run build       # build all packages
npx tsx examples/02-tool-calling-agent.ts      # no API key needed
npx tsx examples/01-simple-chat.ts             # needs OPENAI_API_KEY
npx tsx examples/52-live-agents-basic.ts       # long-running live agent
```

See the full [Examples](#examples) table.

---

## Core Concepts

Five concepts are enough to navigate the entire framework.

| Concept | What it is | Package |
|---|---|---|
| **Model** | An adapter to an LLM (chat, stream, embed, vision, structured output). All models share one interface. | `provider-openai`, `provider-anthropic`, `provider-google`, `provider-ollama`, `provider-llamacpp` |
| **Tool** | A typed function an agent can call. Has a JSON schema, a risk class, and goes through policy + resilience. | `core`, `tools`, `tools-*` |
| **Agent** | An LLM-driven loop that picks tools to satisfy a goal. Two flavors: `weaveAgent` (one-shot) and `weaveLiveAgent` (long-running). | `agents`, `live-agents` |
| **Mesh** | A group of live agents that share a state store, schedule, and event bus. Mesh = team. | `live-agents`, `live-agents-runtime` |
| **Policy / Contract** | Declarative rules for what tools can do, when humans approve, and what evidence an agent must produce. | `tools`, `contracts`, `human-tasks` |

Naming convention you'll see across the codebase:

- `weaveX(...)` — user-facing constructor that returns a runnable thing (agent, model, store, mesh, tool).
- `createX(...)` — internal factory for plumbing (registry, dispatcher, scheduler).

---

## Capability Walkthroughs

Each section has a minimal code snippet and a `Run it` line pointing at the example file.

### 1. Talk to a model

```typescript
import { weaveContext } from '@weaveintel/core';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

const model = weaveOpenAIModel({ apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o-mini' });
const ctx = weaveContext({ userId: 'demo' });

const res = await model.chat(
  { messages: [{ role: 'user', content: 'Capital of France?' }] },
  ctx,
);
console.log(res.content); // "Paris"
```

Streaming, vision, structured output, and Anthropic / Google / Ollama / llama.cpp all use the same shape — swap the import.

> **Run it:** [`examples/01-simple-chat.ts`](examples/01-simple-chat.ts), [`examples/11-anthropic-provider.ts`](examples/11-anthropic-provider.ts), [`examples/75-local-and-gemini-providers.ts`](examples/75-local-and-gemini-providers.ts)

#### Smart routing with fallback

```typescript
import { weaveModel } from '@weaveintel/models';
import '@weaveintel/provider-openai';
import '@weaveintel/provider-anthropic';

const model = weaveModel({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  fallback: [{ provider: 'openai', model: 'gpt-4o-mini' }],
});
```

The router tracks endpoint health, applies weighted scoring, and explains every decision.

> **Run it:** [`examples/14-smart-routing.ts`](examples/14-smart-routing.ts), [`examples/70-task-aware-routing.ts`](examples/70-task-aware-routing.ts)

---

### 2. Add tools (`weaveAgent`)

`weaveAgent` is the one-shot ReAct agent: give it a model, a tool registry, and a goal — it loops "think → call tool → observe → think" until done.

```typescript
import { weaveContext, weaveToolRegistry, weaveTool } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

const tools = weaveToolRegistry();
tools.register(weaveTool({
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: async ({ city }) => `${city}: 22°C, sunny`,
}));

const agent = weaveAgent({
  model: weaveOpenAIModel({ model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY! }),
  tools,
  systemPrompt: 'You are a weather assistant.',
});

const result = await agent.run(
  { messages: [{ role: 'user', content: 'Weather in Paris?' }] },
  weaveContext({ userId: 'demo' }),
);
```

#### Hierarchical agents (supervisor + workers)

```typescript
const supervisor = weaveAgent({
  model,
  systemPrompt: 'Delegate research to the researcher and writing to the writer.',
  workers: [
    { name: 'researcher', model, tools: researchTools, systemPrompt: '...' },
    { name: 'writer',     model, tools: writeTools,    systemPrompt: '...' },
  ],
});
```

> **Run it:** [`examples/02-tool-calling-agent.ts`](examples/02-tool-calling-agent.ts), [`examples/04-hierarchical-agents.ts`](examples/04-hierarchical-agents.ts), [`examples/15-tool-ecosystem.ts`](examples/15-tool-ecosystem.ts)

---

### 3. Long-running agents (`weaveLiveAgent`)

`weaveLiveAgent` is the temporal extension of `weaveAgent`. Use it when an agent needs to:

- Run continuously over hours/days/weeks (a research assistant, a market monitor, a Kaggle competitor).
- Wake on a schedule or external event (cron, webhook, file change, new contract).
- Persist learnings as immutable **contracts** with **evidence**.
- Coordinate with other agents in a **mesh** via a shared state store.

```typescript
import { weaveLiveAgent, weaveLiveMesh, weaveInMemoryStateStore } from '@weaveintel/live-agents';

// 1. Build the agent (same capability slots as weaveAgent + per-tick resolution)
const { handler } = weaveLiveAgent({
  name: 'researcher',
  systemPrompt: 'You research topics and file findings as contracts.',
  model: openaiModel,                 // pinned model, OR…
  // modelResolver: weaveDbModelResolver(...) — picked fresh each tick
  tools,
  policy: weaveLiveAgentPolicy({       // optional governance bundle
    policyResolver, auditEmitter, rateLimiter, approvalGate,
  }),
});

// 2. Put it in a mesh and let the heartbeat scheduler run it
const mesh = await weaveLiveMesh('research-team', { stateStore: weaveInMemoryStateStore() });
await mesh.spawnAgent('researcher', { handler, attentionPolicy: (a) => [...] });
```

#### From a database (recommended for production)

If your meshes and agents live in DB rows, hydrate them with one call:

```typescript
import { weaveLiveMeshFromDb, weaveDbModelResolver } from '@weaveintel/live-agents-runtime';

const { supervisor, stop } = await weaveLiveMeshFromDb(db, {
  store,
  modelResolver: weaveDbModelResolver({ /* DB-backed routing adapters */ }),
  policy: weaveDbLiveAgentPolicy({ /* policy/approval/rate-limit/audit */ }),
});
```

That single call composes: provisioner → handler registry → model resolver → attention policy → heartbeat supervisor → run-state bridge.

#### What you get for free

- **Heartbeat scheduler** ticks every 10 minutes; attention policies decide what work each agent does.
- **Contracts** ([`@weaveintel/contracts`](packages/contracts)) are the immutable evidence ledger.
- **Cross-mesh bridges** route contracts between teams with mutual approval.
- **Account binding** — only humans bind external accounts (Gmail, Slack); agents inherit capabilities, never self-grant.
- **Six state-store backends**: in-memory, SQLite, Postgres, Redis, MongoDB, DynamoDB.
- **Compression** strategies for context that grows over weeks (daily / weekly / hierarchical summaries).

> **Run it:** [`examples/52-live-agents-basic.ts`](examples/52-live-agents-basic.ts), [`examples/53-live-agents-research-team.ts`](examples/53-live-agents-research-team.ts), [`examples/54-live-agents-with-account.ts`](examples/54-live-agents-with-account.ts), [`examples/56-live-agents-cross-mesh.ts`](examples/56-live-agents-cross-mesh.ts), [`examples/57-live-agents-compression.ts`](examples/57-live-agents-compression.ts), [`examples/91-live-agents-model-resolver.ts`](examples/91-live-agents-model-resolver.ts), [`examples/93-live-agents-policy.ts`](examples/93-live-agents-policy.ts), [`examples/96-live-agents-phase6-mesh-from-db.ts`](examples/96-live-agents-phase6-mesh-from-db.ts)
> **Reference app:** [`apps/live-agents-demo`](apps/live-agents-demo) — full HTTP API + interactive UI.
> **Documentation:** [`docs/live-agents/`](docs/live-agents/) — use cases, account model, MCP integration, state store guide, ADRs.

#### When to use which

| Use `weaveAgent` when… | Use `weaveLiveAgent` when… |
|---|---|
| Single request → response | Agent runs continuously |
| Stateless ReAct loop | Needs to accumulate state over time |
| User waits for an answer | Wakes on schedule or event |
| In-process | May span workers / processes |

---

### 4. Connect to external systems (MCP)

The Model Context Protocol lets you expose tools/resources/prompts over a transport that any MCP client can call.

#### Expose your tools as an MCP server

```typescript
import { weaveMCPServer } from '@weaveintel/mcp-server';

const server = weaveMCPServer({ name: 'my-tools', version: '1.0.0' });
server.addTool(
  { name: 'greet', description: 'Greet a user', inputSchema: { /* JSON schema */ } },
  async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }),
);
```

#### Consume someone else's MCP server

```typescript
import { weaveMCPClient } from '@weaveintel/mcp-client';

const client = weaveMCPClient(transport);
await client.connect();
const tools = await client.listTools();
const result = await client.callTool('greet', { name: 'weaveIntel' });
```

#### Pre-wired domain server

[`@weaveintel/mcp-statsnz`](packages/mcp-statsnz) ships a complete Stats NZ MCP server you can launch with one call.

> **Run it:** [`examples/05-mcp-integration.ts`](examples/05-mcp-integration.ts), [`examples/65-mcp-streamable-http-stateless.ts`](examples/65-mcp-streamable-http-stateless.ts), [`examples/66-mcp-progressive-discovery-compose-stream.ts`](examples/66-mcp-progressive-discovery-compose-stream.ts), [`examples/67-live-agents-mcp-resumable-progress.ts`](examples/67-live-agents-mcp-resumable-progress.ts)

---

### 5. Multi-agent communication (A2A)

The agent-to-agent bus lets agents discover each other and delegate work, in-process or over HTTP.

```typescript
import { weaveA2ABus } from '@weaveintel/a2a';

const bus = weaveA2ABus();
bus.register('summarizer', async ({ text }) => ({ summary: '...' }));
bus.register('translator', async ({ text, lang }) => ({ translated: '...' }));

const summary = await bus.send('summarizer', { text: longDoc });
const fr = await bus.send('translator', { text: summary.summary, lang: 'fr' });
```

> **Run it:** [`examples/06-a2a-communication.ts`](examples/06-a2a-communication.ts)

---

### 6. Governance: policy, approval, audit

Every tool that flows through `createPolicyEnforcedRegistry` is wrapped in a five-step pipeline:

```
enabled check → circuit breaker → risk-level gate → approval gate → rate limit → execute → audit
```

- **Risk levels:** `read-only`, `write`, `destructive`, `privileged`, `financial`, `external-side-effect`.
- **Policies** live in the `tool_policies` DB table. Skills can override per-session.
- **Approval workflow:** tools with `requireApproval: true` create a `tool_approval_requests` row; operators resolve via `/api/admin/tool-approval-requests`.
- **Audit trail:** every invocation persists to `tool_audit_events` with input/output preview, duration, and policy id.
- **Health snapshots:** a background job rolls up success rate, p95 latency, and error rate every 15 minutes into `tool_health_snapshots`.

```typescript
import { createToolRegistry } from '@weaveintel/tools';

const registry = await createToolRegistry({
  policyResolver,    // looks up effective policy per call
  approvalGate,      // creates approval requests
  rateLimiter,       // sliding-window quota per tool/scope
  auditEmitter,      // persists to tool_audit_events
});
```

In geneWeave this is wired in [`apps/geneweave/src/tools.ts`](apps/geneweave/src/tools.ts) — chat sessions, the MCP gateway, the Scientific-Validation pipeline, and live-agent ticks all share the same governance surface.

> **Run it:** [`examples/33-tool-simulation-harness.ts`](examples/33-tool-simulation-harness.ts) (dry-run with full policy trace), [`examples/34-skill-tool-policy-approval.ts`](examples/34-skill-tool-policy-approval.ts) (skill→policy closure + approval queue)

---

### 7. Resilience: rate limits, circuit breakers, retries

`@weaveintel/resilience` is the shared composition layer that **every outbound call** flows through. One 429 anywhere becomes a normalized signal everyone can react to.

```typescript
import { createResilientCallable } from '@weaveintel/resilience';

const call = createResilientCallable(
  (input) => fetch(url, input),
  {
    endpoint: 'github:rest',         // process-wide bucket key
    retry: { maxAttempts: 3 },
    timeoutMs: 30_000,
  },
);

await call(payload);                                         // default: wait + retry
await call.withOverrides({ rateLimitMode: 'fail-fast', maxRetries: 0 })(payload);
```

What's wrapped today:

| Surface | Endpoint id |
|---|---|
| OpenAI / Anthropic / Google REST + streams | `openai:rest`, `anthropic:rest`, `google:rest` |
| Every tool through the policy-enforced registry | `tool:<toolName>` |
| `tools-http` direct REST tools | per tool |
| MCP gateway (geneweave hosting MCP) — both tenancy paths | `tool:<toolName>` |
| Live-agent tick tool calls | `tool:<toolName>` with `fail-fast` overrides so the supervisor defers next pass |
| Generic supervisor | reads `endpoint_health` before scheduling; emits `endpoint_circuit_open` / `endpoint_rate_limited` to `live_run_events` |

Apps subscribe to the signal bus to react (pause an endpoint, defer an agent, fall back to a cheaper model). See [`docs/RESILIENCE_PLAN.md`](docs/RESILIENCE_PLAN.md) for the full design.

---

### 8. Memory, RAG, and knowledge graphs

#### RAG pipeline

```typescript
import { weaveChunker, weaveEmbeddingPipeline, weaveVectorRetriever } from '@weaveintel/retrieval';

const chunker = weaveChunker({ strategy: 'fixed-size', chunkSize: 512, overlap: 50 });
const pipeline = weaveEmbeddingPipeline({ embeddingModel, vectorStore, chunker });
const retriever = weaveVectorRetriever({ embeddingModel, vectorStore, topK: 5 });

await pipeline.ingestDocument(doc, ctx);
const hits = await retriever.retrieve({ query: '...' }, ctx);
```

#### Memory

Three implementations, one shape:

```typescript
import { weaveConversationMemory, weaveSemanticMemory, weaveEntityMemory } from '@weaveintel/memory';

const conv = weaveConversationMemory({ maxTurns: 20 });
const sem  = weaveSemanticMemory({ embeddingModel, vectorStore, topK: 3 });
const ent  = weaveEntityMemory();
```

#### Knowledge graph

```typescript
import { weaveKnowledgeGraph } from '@weaveintel/graph';

const kg = weaveKnowledgeGraph();
await kg.addEntity('alice', { type: 'person' });
await kg.addRelation('alice', 'works_at', 'acme');
```

> **Run it:** [`examples/03-rag-pipeline.ts`](examples/03-rag-pipeline.ts), [`examples/07-memory-augmented-agent.ts`](examples/07-memory-augmented-agent.ts), [`examples/18-knowledge-graph.ts`](examples/18-knowledge-graph.ts), [`examples/25-semantic-cache.ts`](examples/25-semantic-cache.ts), [`examples/26-advanced-retrieval.ts`](examples/26-advanced-retrieval.ts)

---

### 9. Observability and replay

Every model call, tool call, and agent step emits a span with usage, cost, and timing. Subscribe at any level.

```typescript
import { weaveTracer, weaveEventBus } from '@weaveintel/observability';

const bus = weaveEventBus();
const tracer = weaveTracer({ serviceName: 'my-app', eventBus: bus });

bus.on('span:end', (s) => console.log(`${s.name} ${s.duration}ms tokens=${s.usage?.totalTokens}`));
```

Replay an entire agent run from its trace:

```typescript
import { weaveReplay } from '@weaveintel/replay';

await weaveReplay(traceId, { mockTools: true });
```

> **Run it:** [`examples/10-observability.ts`](examples/10-observability.ts), [`examples/78-kaggle-replay-roundtrip.ts`](examples/78-kaggle-replay-roundtrip.ts)

---

### 10. Evaluation

```typescript
import { weaveEvalRunner } from '@weaveintel/evals';

const runner = weaveEvalRunner({ model });
const results = await runner.run({
  name: 'geography',
  cases: [{
    input: { messages: [{ role: 'user', content: 'Capital of France?' }] },
    assertions: [
      { type: 'contains', value: 'Paris' },
      { type: 'latency_threshold', value: 5000 },
    ],
  }],
});
```

Six assertion kinds: `exact`, `contains`, `regex`, `schema`, `latency_threshold`, `cost_threshold`.

> **Run it:** [`examples/09-eval-suite.ts`](examples/09-eval-suite.ts), [`examples/30-prompt-eval-optimization.ts`](examples/30-prompt-eval-optimization.ts)

---

## The geneWeave Reference App

[`apps/geneweave`](apps/geneweave) is the full reference implementation — a multi-tenant chat app + admin dashboard built only from `@weaveintel/*` packages. It demonstrates every capability above wired together against a SQLite database.

What's in it:

- **Chat runtime** — direct, agent, and supervisor-worker modes with streaming.
- **Auth & RBAC** — email/password + JWT, OAuth sign-in, persona-based RBAC (platform/tenant admin, tenant user, agent personas), encrypted credential vault.
- **Admin dashboard** — CRUD for prompts, frameworks, fragments, output contracts, strategies, skills, tool catalog, tool policies, tool approvals, models, routing experiments, cost-by-task, audit log, health snapshots, scientific-validation feeds.
- **Tool platform** — DB-backed `tool_catalog`, policy enforcement, approvals, audit, health snapshots, simulation harness.
- **Skills** — reusable behavior packs that bind a `toolPolicyKey` so the activation auto-scopes every tool call in the session.
- **Scientific Validation** — multi-agent hypothesis pipeline (literature, statistical, mechanistic, simulation, synthesis, critique) with SSE event streams and a verdict bundle.
- **MCP gateway** — exposes the tool catalog as an MCP server with per-client allocation classes.
- **Live agents** — generic supervisor + Kaggle competition supervisor demonstrating long-running mesh execution.

Run it locally with [`scripts/start-geneweave.sh`](scripts/start-geneweave.sh) (see [Quick Start](#quick-start)).

The full local DB is `./geneweave.db`. Reset with `rm geneweave.db` and restart — schema and seeds are recreated.

---

## Examples

90+ runnable demos under [`examples/`](examples). Run any one with `npx tsx examples/<file>.ts`.

| # | File | Capability | API key |
|---|---|---|---|
| 01 | [Simple chat](examples/01-simple-chat.ts) | Basic chat / streaming / structured output | OpenAI |
| 02 | [Tool-calling agent](examples/02-tool-calling-agent.ts) | `weaveAgent` + ReAct loop | none |
| 03 | [RAG pipeline](examples/03-rag-pipeline.ts) | Chunker + embedder + retriever | none |
| 04 | [Hierarchical agents](examples/04-hierarchical-agents.ts) | Supervisor → workers | none |
| 05 | [MCP integration](examples/05-mcp-integration.ts) | MCP server + client | none |
| 06 | [A2A bus](examples/06-a2a-communication.ts) | Agent-to-agent delegation | none |
| 07 | [Memory-augmented agent](examples/07-memory-augmented-agent.ts) | Conversation / semantic / entity memory | none |
| 08 | [PII redaction](examples/08-pii-redaction.ts) | Detection + reversible tokenisation | none |
| 09 | [Eval suite](examples/09-eval-suite.ts) | Assertions, scoring, reports | none |
| 10 | [Observability](examples/10-observability.ts) | Tracer, spans, event bus | none |
| 11 | [Anthropic provider](examples/11-anthropic-provider.ts) | Full Anthropic API (tools, thinking, vision, batches, computer use) | Anthropic |
| 12 | [GeneWeave app](examples/12-geneweave.ts) | The reference full-stack app | OpenAI or Anthropic |
| 13 | [Workflow engine](examples/13-workflow-engine.ts) | Multi-step workflows with checkpoints | none |
| 14 | [Smart routing](examples/14-smart-routing.ts) | Health, weighted scoring, fallback | none |
| 15 | [Tool ecosystem](examples/15-tool-ecosystem.ts) | search + browser + http tool combo | none |
| 16 | [Human-in-the-loop](examples/16-human-in-the-loop.ts) | Approval, escalation, contracts | none |
| 17 | [Prompt management](examples/17-prompt-management.ts) | Versions, A/B experiments, strategies | none |
| 18 | [Knowledge graph](examples/18-knowledge-graph.ts) | Entities, relations, timeline | none |
| 19 | [Compliance + sandbox](examples/19-compliance-sandbox.ts) | Retention, holds, sandboxed execution | none |
| 20 | [Recipes + devtools](examples/20-recipes-devtools.ts) | Pre-built agents, scaffolding, mocks | none |
| 21a | [Full API tools](examples/21-full-api-tools.ts) | Universal auth, enterprise / social tools | none |
| 21b | [Guardrails: date evidence](examples/21-guardrails-date-evidence.ts) | Tool-grounded vs memory responses | none |
| 21c | [Scientific validation (intro)](examples/21-scientific-validation.ts) | SV pipeline overview | none |
| 22 | [Chat memory extraction](examples/22-chat-memory-extraction.ts) | Hybrid extraction (regex + LLM) | none |
| 23 | [Chat guardrails pipeline](examples/23-chat-guardrails-pipeline.ts) | Post-execution guardrails | none |
| 24 | [Web search providers](examples/24-web-search-providers.ts) | Multi-provider router, fan-out | none |
| 25 | [Semantic cache](examples/25-semantic-cache.ts) | TTL, similarity, invalidation | none |
| 26 | [Advanced retrieval](examples/26-advanced-retrieval.ts) | Hybrid retriever, citations | none |
| 27 | [Browser automation](examples/27-browser-automation.ts) | Browser pool, auth handoff | none |
| 28 | [Identity + RBAC](examples/28-package-auth-rbac.ts) | Personas, deny-by-default | none |
| 29 | [Authenticated agent + tools](examples/29-authenticated-agent-tools.ts) | Permission-gated tool execution | none |
| 30 | [Prompt eval + optimization](examples/30-prompt-eval-optimization.ts) | Optimizer loop with rubric judge | none |
| 30b | [Prompt versions + experiments](examples/30-prompt-version-experiments.ts) | Variant resolution at runtime | none |
| 32 | [Phase 9 admin capability E2E](examples/32-phase9-admin-capability-e2e.ts) | DB-driven admin schema → chat | none |
| 33 | [Tool simulation harness](examples/33-tool-simulation-harness.ts) | Dry-run with full policy trace | none |
| 34 | [Skill→policy + approval](examples/34-skill-tool-policy-approval.ts) | Skill closure + approval queue | none |
| 35 | [Scientific validation E2E](examples/35-scientific-validation.ts) | Submit → stream → verdict → bundle | none |
| 35b | [Skill activation E2E](examples/35-skill-activation-e2e.ts) | End-to-end skill flow | none |
| 36 | [Skills in memory E2E](examples/36-skills-in-memory-e2e.ts) | In-memory skill orchestration | none |
| 37 | [Skills with real LLM](examples/37-skills-with-real-llm.ts) | Skills + live model | OpenAI/Anthropic |
| 38 | [Kaggle MCP read-only](examples/38-kaggle-mcp-readonly.ts) | Kaggle MCP discovery | none |
| 39 | [Kaggle write + validate](examples/39-kaggle-write-and-validate.ts) | Kaggle submission flow | none |
| 39b–51 | Live-agents phases 1–13 | Iterative buildup of the live-agents framework | none |
| 52 | [Live agents: basic](examples/52-live-agents-basic.ts) | First long-running agent | none |
| 53 | [Live agents: research team](examples/53-live-agents-research-team.ts) | Multi-agent mesh | none |
| 54 | [Live agents: with account](examples/54-live-agents-with-account.ts) | Account binding for external APIs | none |
| 55 | [Live agents: promotion](examples/55-live-agents-promotion.ts) | Contract promotion across stages | none |
| 56 | [Live agents: cross-mesh](examples/56-live-agents-cross-mesh.ts) | Bridges between teams | none |
| 57 | [Live agents: compression](examples/57-live-agents-compression.ts) | Daily / weekly / hierarchical summaries | none |
| 58 | [Live-agents demo E2E](examples/58-live-agents-demo-e2e.ts) | Tests the demo HTTP API | none |
| 59 | [OAuth tool connection](examples/59-oauth-tool-connection-examples.ts) | OAuth flows for tool auth | none |
| 60 | [Live-agents persistence E2E](examples/60-live-agents-persistence-methods-e2e.ts) | All six state stores | none |
| 61 | [Agent persistence E2E](examples/61-agent-persistence-methods-e2e.ts) | weaveAgent persistence layers | none |
| 62 | [Phase 7 obs/replay/eval](examples/62-phase7-observability-replay-eval-persistence-e2e.ts) | Cross-cutting observability | none |
| 63 | [Phase 8 reliability E2E](examples/63-phase8-persistence-performance-reliability-e2e.ts) | Performance + reliability | none |
| 64 | [Phase 9 release validator](examples/64-phase9-persistence-release-e2e.ts) | Full release scenario sweep | none |
| 65 | [MCP streamable HTTP stateless](examples/65-mcp-streamable-http-stateless.ts) | New MCP transport | none |
| 66 | [MCP progressive discovery](examples/66-mcp-progressive-discovery-compose-stream.ts) | Compose multiple MCP servers | none |
| 67 | [Live agents + MCP resumable](examples/67-live-agents-mcp-resumable-progress.ts) | Resumable progress over MCP | none |
| 68 | [Routed attention research](examples/68-live-agents-routed-attention-research-topics.ts) | Attention policies | none |
| 69 | [MCP gateway token rotation](examples/69-mcp-gateway-token-expiry-rotation.ts) | Credential rotation | none |
| 70 | [Task-aware routing](examples/70-task-aware-routing.ts) | Capability matrix routing | none |
| 71 | [Tool schema translation](examples/71-tool-schema-translation.ts) | Mid-conversation provider swap | none |
| 72 | [Routing admin Phase 4](examples/72-routing-admin-phase4.ts) | Admin CRUD for routing | none |
| 73 | [Routing feedback Phase 5](examples/73-routing-feedback-phase5.ts) | Feedback loop into routing | none |
| 74 | [Routing Phase 6 production](examples/74-routing-phase6-production.ts) | Cache, circuit breaker, A/B, cost-by-task | none |
| 75 | [Local + Gemini providers](examples/75-local-and-gemini-providers.ts) | Ollama / llama.cpp / Google | optional |
| 76 | [Kaggle: discover + ideate](examples/76-kaggle-discover-and-ideate.ts) | Kaggle live-agent ideation | none |
| 77 | [Kaggle: submit with approval](examples/77-kaggle-submit-with-approval.ts) | Approval-gated submission | none |
| 78 | [Kaggle: replay roundtrip](examples/78-kaggle-replay-roundtrip.ts) | Trace → replay | none |
| 79 | [Kaggle: live agents E2E](examples/79-kaggle-live-agents-e2e.ts) | Full Kaggle mesh run | none |
| 80 | [Kaggle: discussion bot](examples/80-kaggle-discussion-bot.ts) | Discussion automation | none |
| 81 | [Kaggle: finalize](examples/81-kaggle-finalize.ts) | Final submission | none |
| 82 | [Define mesh via DB](examples/82-define-mesh-via-db.ts) | DB-driven mesh definitions | none |
| 83 | [Handler registry](examples/83-handler-registry.ts) | Custom handler kinds | none |
| 84 | [Agent tool binding](examples/84-agent-tool-binding.ts) | DB tool binding | none |
| 85 | [Agent model routing](examples/85-agent-model-routing.ts) | Per-agent model overrides | none |
| 86 | [Attention policy factory](examples/86-attention-policy-factory.ts) | Policy composition | none |
| 87 | [Mesh provisioner](examples/87-mesh-provisioner.ts) | Programmatic mesh provisioning | none |
| 88 | [ARC-AGI mesh](examples/88-arc-agi-mesh.ts) | ARC-AGI puzzle-solving mesh | none |
| 91 | [Live agents: model resolver](examples/91-live-agents-model-resolver.ts) | Per-tick model selection | none |
| 92 | [Live agents: DB routing](examples/92-live-agents-db-routing.ts) | DB-backed model resolver + agent overlay | none |
| 93 | [Live agents: policy](examples/93-live-agents-policy.ts) | `weaveLiveAgentPolicy` (audit / rate-limit / approval) | none |
| 94 | [`weaveAgent` ↔ `weaveLiveAgent` parity](examples/94-weave-live-agent-parity.ts) | Side-by-side capability parity | none |
| 95 | [Phase 5 Kaggle-style routing](examples/95-live-agents-phase5-kaggle-style-routing.ts) | Production routing pattern | none |
| 96 | [`weaveLiveMeshFromDb`](examples/96-live-agents-phase6-mesh-from-db.ts) | One-call DB mesh hydration | none |

> **All examples runnable from a fresh clone** after `npm install && npm run build`. Examples that need an API key say so in the table.

---

## Package Map

60+ packages organised by layer.

### Core & Models

| Package | Role |
|---|---|
| [`@weaveintel/core`](packages/core) | Contracts, types, context, middleware, error classifier — zero vendor deps |
| [`@weaveintel/models`](packages/models) | Unified model router with fallback, streaming, capability selection |
| [`@weaveintel/provider-openai`](packages/provider-openai) | OpenAI adapter |
| [`@weaveintel/provider-anthropic`](packages/provider-anthropic) | Anthropic adapter (chat, streaming, tools, thinking, vision, batches, computer use) |
| [`@weaveintel/provider-google`](packages/provider-google) | Google Gemini adapter (1.5 / 2.5 / 3.x) |
| [`@weaveintel/provider-ollama`](packages/provider-ollama) | Local LLMs via Ollama |
| [`@weaveintel/provider-llamacpp`](packages/provider-llamacpp) | Local GGUF via llama.cpp HTTP server |
| [`@weaveintel/testing`](packages/testing) | Fake models / embeddings / vector stores / MCP transports |

### Agents & Orchestration

| Package | Role |
|---|---|
| [`@weaveintel/agents`](packages/agents) | `weaveAgent` — ReAct loop, supervisor-worker hierarchies |
| [`@weaveintel/live-agents`](packages/live-agents) | `weaveLiveAgent`, `weaveLiveMesh`, mesh, contracts, bridges, account binding, six state stores |
| [`@weaveintel/live-agents-runtime`](packages/live-agents-runtime) | DB hydration: `weaveLiveMeshFromDb`, `weaveLiveAgentFromDb`, model resolver, attention policy, heartbeat supervisor |
| [`@weaveintel/workflows`](packages/workflows) | Multi-step workflow engine (branching, checkpoints, compensation) |
| [`@weaveintel/human-tasks`](packages/human-tasks) | Approval, review, escalation, decision logging |
| [`@weaveintel/contracts`](packages/contracts) | Completion contracts + evidence ledger |
| [`@weaveintel/prompts`](packages/prompts) | Versioned templates, fragments, frameworks, lint, strategies, output contracts |
| [`@weaveintel/routing`](packages/routing) | Capability-based smart routing with health, scoring, A/B |
| [`@weaveintel/tool-schema`](packages/tool-schema) | Cross-provider tool-schema translation |

### Tools & Connectivity

| Package | Role |
|---|---|
| [`@weaveintel/tools`](packages/tools) | Policy-enforced tool registry: enabled / circuit / risk / approval / rate-limit / audit |
| [`@weaveintel/tools-http`](packages/tools-http) | REST client with auth, schema validation, resilience |
| [`@weaveintel/tools-search`](packages/tools-search) | Web search (DuckDuckGo, Brave) |
| [`@weaveintel/tools-browser`](packages/tools-browser) | URL fetch, content extraction, browser pool |
| [`@weaveintel/tools-time`](packages/tools-time) | Datetime, timezone, timer, stopwatch, reminders |
| [`@weaveintel/tools-webhook`](packages/tools-webhook) | Receive external events (GitHub, Stripe, Slack) |
| [`@weaveintel/tools-filewatch`](packages/tools-filewatch) | File system monitoring |
| [`@weaveintel/tools-enterprise`](packages/tools-enterprise) | Jira, ServiceNow (283 tools), Canva, Confluence, Salesforce, Notion |
| [`@weaveintel/tools-social`](packages/tools-social) | Twitter/X, LinkedIn |
| [`@weaveintel/tools-kaggle`](packages/tools-kaggle) | Kaggle competitions, datasets, kernels |
| [`@weaveintel/tools-gmail`](packages/tools-gmail) / [`-gcal`](packages/tools-gcal) / [`-gdrive`](packages/tools-gdrive) | Google Workspace |
| [`@weaveintel/tools-outlook`](packages/tools-outlook) / [`-outlook-cal`](packages/tools-outlook-cal) | Microsoft 365 |
| [`@weaveintel/tools-onedrive`](packages/tools-onedrive) / [`-dropbox`](packages/tools-dropbox) | Cloud storage |
| [`@weaveintel/tools-slack`](packages/tools-slack) / [`-imap`](packages/tools-imap) | Messaging |
| [`@weaveintel/oauth`](packages/oauth) | OAuth client + provider toolkit |
| [`@weaveintel/mcp-client`](packages/mcp-client) / [`-server`](packages/mcp-server) | MCP protocol |
| [`@weaveintel/mcp-statsnz`](packages/mcp-statsnz) | Pre-wired Stats NZ MCP server |
| [`@weaveintel/a2a`](packages/a2a) | Agent-to-agent bus (in-process + HTTP) |
| [`@weaveintel/plugins`](packages/plugins) | Plugin lifecycle |

### Knowledge & Retrieval

| Package | Role |
|---|---|
| [`@weaveintel/retrieval`](packages/retrieval) | Chunking (6 strategies), embedding pipeline, hybrid retrieval, reranking |
| [`@weaveintel/memory`](packages/memory) | Conversation, semantic, entity memory |
| [`@weaveintel/graph`](packages/graph) | Knowledge graph + entity linking |
| [`@weaveintel/extraction`](packages/extraction) | Document extraction (entity, metadata, table, code, task) |
| [`@weaveintel/cache`](packages/cache) | Semantic cache with TTL + LRU |
| [`@weaveintel/artifacts`](packages/artifacts) | Versioned blob storage |

### Safety, Governance, Reliability

| Package | Role |
|---|---|
| [`@weaveintel/guardrails`](packages/guardrails) | Risk classification, cost guards, runtime policies |
| [`@weaveintel/redaction`](packages/redaction) | PII detection + reversible tokenisation |
| [`@weaveintel/compliance`](packages/compliance) | Retention, GDPR/CCPA deletion, legal holds, consent, audit export |
| [`@weaveintel/sandbox`](packages/sandbox) | Sandboxed execution + container executor |
| [`@weaveintel/identity`](packages/identity) | Personas, ACL, deny-by-default |
| [`@weaveintel/tenancy`](packages/tenancy) | Multi-tenant isolation, budgets |
| [`@weaveintel/reliability`](packages/reliability) | Idempotency, retry budgets, DLQ, health, backpressure |
| [`@weaveintel/resilience`](packages/resilience) | Shared pipeline: rate-limit + circuit + retry-with-backoff + signals |

### Observability & Evaluation

| Package | Role |
|---|---|
| [`@weaveintel/observability`](packages/observability) | Tracer, spans, event bus, cost/usage tracking |
| [`@weaveintel/evals`](packages/evals) | Evaluation runner + 6 assertion types |
| [`@weaveintel/replay`](packages/replay) | Trace replay |

### Persistence & Apps

| Package | Role |
|---|---|
| [`@weaveintel/persistence`](packages/persistence) | Persistence platform (SQLite/Postgres/Redis/Mongo/DynamoDB) |
| [`@weaveintel/recipes`](packages/recipes) | Pre-built agent factories |
| [`@weaveintel/devtools`](packages/devtools) | Scaffolding, inspection, mocks |
| [`@weaveintel/ui-primitives`](packages/ui-primitives) | Streaming events + widgets (table, chart, form, code, timeline) |
| [`@weaveintel/triggers`](packages/triggers) | Cron, webhook, queue triggers |
| [`@weaveintel/collaboration`](packages/collaboration) | Multi-user session handoff |
| [`@weaveintel/social-growth`](packages/social-growth) | Social growth automations |
| [`@weaveintel/geneweave`](apps/geneweave) | Reference full-stack app |
| [`live-agents-demo`](apps/live-agents-demo) | Live-agents reference HTTP API + UI |

---

## Deployment

geneWeave runs anywhere Node.js 20+ or Docker runs. All deployment configs live in the repo.

### Required environment variables

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | yes | Auth token signing key |
| `VAULT_KEY` | yes | Encrypts the credential vault |
| `OPENAI_API_KEY` *or* `ANTHROPIC_API_KEY` | one | At least one provider |
| `PORT` | no | HTTP port (default `3500`) |
| `DATABASE_PATH` | no | SQLite path (default `./geneweave.db`) |
| `STATSNZ_API_KEY` | no | Stats NZ MCP server |

Generate a strong secret: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

### Docker

```bash
docker build -t geneweave .
docker run -d --name geneweave -p 3500:3500 \
  -e JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") \
  -e VAULT_KEY=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))") \
  -e OPENAI_API_KEY=sk-... \
  -v geneweave-data:/app/data \
  geneweave
```

### Other platforms

| Platform | Config file |
|---|---|
| Docker Compose | [`docker-compose.yml`](docker-compose.yml) |
| Fly.io | [`fly.toml`](fly.toml) |
| Railway | [`railway.toml`](railway.toml) |
| Render | [`render.yaml`](render.yaml) |
| Heroku | [`Procfile`](Procfile) + [`app.json`](app.json) |
| Vercel | [`vercel.json`](vercel.json) (use container platforms for long streams) |
| Azure Container Apps | [`deploy/azure-container-app.yaml`](deploy/azure-container-app.yaml) |
| AWS App Runner | [`deploy/aws-apprunner.yaml`](deploy/aws-apprunner.yaml) |
| AWS ECS Fargate | [`deploy/aws-ecs-task.json`](deploy/aws-ecs-task.json) |
| Google Cloud Run | [`deploy/gcp-cloudrun.yaml`](deploy/gcp-cloudrun.yaml) |
| DigitalOcean App | [`deploy/digitalocean-app.yaml`](deploy/digitalocean-app.yaml) |
| Kubernetes | [`deploy/kubernetes.yaml`](deploy/kubernetes.yaml) |
| Production entrypoint | [`deploy/server.ts`](deploy/server.ts) |

CI/CD workflows under [`.github/workflows/`](.github/workflows/) auto-build the Docker image and deploy to Azure / AWS / GCP / Fly on push or manual dispatch.

---

## Development

```bash
npm install              # workspace install
npm run build            # turbo-built, dependency-aware
npm run typecheck        # tsc --noEmit across all packages
npm run test             # vitest
npm run format           # prettier
npm run clean            # remove dist/

# Build a single package
npm run build --workspace @weaveintel/geneweave
```

### Adding a new provider

1. Create `packages/provider-<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`.
2. Implement the `Model` interface from `@weaveintel/core`.
3. Wrap your HTTP request with `createResilientCallable({ endpoint: '<name>:rest' })`.
4. Register at import time: `weaveRegisterModel('<name>', factory)` from `@weaveintel/models`.
5. Add a project reference to root `tsconfig.json`.

### Design principles

- **Interfaces in core, implementations in leaf packages.** `core` never imports from providers or runtime packages.
- **Capabilities are explicit.** Models, tools, and agents declare what they can do. The router and consumers check at runtime.
- **Context flows everywhere.** `ExecutionContext` carries `userId`, `traceId`, `budget`, `deadline`, and a cancellation signal through every call.
- **`weave*` for things you instantiate, `create*` for plumbing.** New PRs that add `createLiveXxx` user-facing constructors get renamed to `weaveLiveXxx`.
- **DB-driven, not code-driven.** Tool catalog, policies, prompts, skills, models, routing — all live in DB rows that admin UIs and runtime resolvers read.

---

## Manual setup

If you'd rather not use `scripts/start-geneweave.sh`:

```bash
# 1. Prerequisites: Node 20+, npm 10+, git, build tools (xcode-select --install on macOS;
#    apt-get install build-essential python3 on Debian/Ubuntu)
# 2. Clone + install + build
git clone https://github.com/gibyvarghese/weaveintel.git
cd weaveintel
npm install
npm run build

# 3. Configure
cp .env.example .env
$EDITOR .env   # set JWT_SECRET, VAULT_KEY, and at least one provider key

# 4. Start
set -a && source .env && set +a
npx tsx examples/12-geneweave.ts
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| `better-sqlite3` install fails | Install build tools (Xcode CLI on macOS, `build-essential` + `python3` on Linux), then `rm -rf node_modules && npm install` |
| `EADDRINUSE: :3500` | `PORT=3501 npx tsx examples/12-geneweave.ts` |
| `JWT_SECRET is required` | Add it to `.env` and re-source |
| `Cannot find module '@weaveintel/...'` | Run `npm run build` |
| Admin UI looks stale | `npm run build --workspace @weaveintel/geneweave` then refresh |
| Want a clean DB | `rm geneweave.db` and restart |

---

## Versioning

weaveIntel uses **Fabric Versioning**: each major release is named after a fabric, alphabetically A → Z.

```
<major>.<minor>.<patch>  —  "<Fabric Name>"
```

**Current release: v1.0.0 — Aertex.** Full mapping in [VERSIONING.md](VERSIONING.md).

---

## Tech stack

- **TypeScript 5.7+** — strict mode, ESM-first (`module: "Node16"`), `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`.
- **npm workspaces** — monorepo dependency management.
- **Turborepo** — parallel builds with dependency-aware caching.
- **Vitest** — test runner.
- **Prettier** — code formatting.

---

## License

MIT
