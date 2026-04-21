# weaveIntel

**Protocol-first, capability-driven AI framework for TypeScript.**

weaveIntel is a modular monorepo that provides composable building blocks for building production-grade AI applications — from simple chat completions to multi-agent orchestration with tool calling, RAG, memory, observability, and inter-agent communication.

## Latest Development (April 2026)

- **Phase 6 Skill→Tool Policy Closure + Approval Workflow** — When a skill is activated in a chat session, its declared `toolPolicyKey` is automatically forwarded to the policy-enforced tool registry so every tool invocation runs under that skill's policy without any per-call wiring. Approval-required tools produce a `tool_approval_requests` DB row; operators resolve pending requests (approve/deny) via the admin API with full audit trail.
  - Admin API: `GET|POST /api/admin/tool-approval-requests[/:id/approve|deny]`
  - New example: [examples/34-skill-tool-policy-approval.ts](examples/34-skill-tool-policy-approval.ts)
- **Phase 5 Tool Simulation + Test Harness** — Admin operators can now dry-run or live-simulate any registered tool directly from the geneWeave admin dashboard without starting a chat session. Full policy trace (enabled check → risk gate → approval → rate limit) is returned on every request. See [Tool Platform (Phase 5)](#tool-platform-phase-5) below.
  - New example: [examples/33-tool-simulation-harness.ts](examples/33-tool-simulation-harness.ts)
- geneWeave app moved from packages to apps: [apps/geneweave](apps/geneweave)
- New reusable Stats NZ MCP package: [packages/mcp-statsnz](packages/mcp-statsnz)
  - Generic MCP runtime stays in [packages/mcp-server](packages/mcp-server)
  - Stats NZ domain wiring is now reusable and centralized
  - geneWeave Stats NZ MCP entrypoint is a thin launcher: [apps/geneweave/src/statsnz-mcp-server.ts](apps/geneweave/src/statsnz-mcp-server.ts)
- New examples 24-29 added:
  - [examples/24-web-search-providers.ts](examples/24-web-search-providers.ts)
  - [examples/25-semantic-cache.ts](examples/25-semantic-cache.ts)
  - [examples/26-advanced-retrieval.ts](examples/26-advanced-retrieval.ts)
  - [examples/27-browser-automation.ts](examples/27-browser-automation.ts)
  - [examples/28-package-auth-rbac.ts](examples/28-package-auth-rbac.ts)
  - [examples/29-authenticated-agent-tools.ts](examples/29-authenticated-agent-tools.ts)
- New examples 30-32 added for prompt capability phases:
  - [examples/30-prompt-version-experiments.ts](examples/30-prompt-version-experiments.ts)
  - [examples/31-skill-prompt-bindings.ts](examples/31-skill-prompt-bindings.ts)
  - [examples/32-phase9-admin-capability-e2e.ts](examples/32-phase9-admin-capability-e2e.ts)
- Guardrail grounding improvements for tool-backed responses and date/day evidence checks
- Temporal tool state persistence coverage in geneWeave test suite
- Persona-based RBAC in geneWeave (platform admin, tenant admin, tenant user, agent worker, agent researcher, agent supervisor)
- Package-level identity RBAC primitives in `@weaveintel/identity` with deny-by-default for unknown personas

## Why weaveIntel?

- **Protocol-first** — Core defines contracts (interfaces), not implementations. Swap providers without changing application code.
- **Capability-driven** — Models, agents, and tools declare capabilities. The router selects the right model for the job.
- **Zero vendor lock-in** — Core has zero vendor dependencies. Provider packages are thin adapters.
- **Composable middleware** — Intercept any model call with typed middleware for logging, retries, redaction, caching, or custom logic.
- **Production patterns built in** — Fallback chains, budget enforcement, PII redaction, structured output, evaluation suites, and observability from day one.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Your Application                               │
├──────────┬───────────┬──────────┬───────────┬────────────┬──────────────┤
│  recipes │  devtools  │ geneweave│ ui-prims  │ triggers   │ collaboration│
├──────────┴───────────┴──────────┴───────────┴────────────┴──────────────┤
│                        Agent Layer                                       │
│   agents · workflows · human-tasks · contracts · prompts · routing       │
├─────────────────────────────────────────────────────────────────────────┤
│                        Capability Layer                                  │
│   retrieval · memory · graph · extraction · cache · artifacts · evals    │
├─────────────────────────────────────────────────────────────────────────┤
│                        Tool Layer                                        │
│   tools · tools-search · tools-browser · tools-http · tools-enterprise   │
│   tools-social · tools-time · oauth · mcp-client · mcp-server · a2a      │
│   plugins                                                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                        Safety & Governance                               │
│   guardrails · redaction · compliance · sandbox · identity · tenancy     │
│   reliability · replay · observability                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                        Model Layer                                       │
│   models (router) · provider-openai · provider-anthropic                 │
├─────────────────────────────────────────────────────────────────────────┤
│                        core (contracts & types)                          │
│   testing                                                                │
└──────────────────────────────────────────────────────────────────────────┘
```

## Packages (45)

### Core & Models

| Package | Description |
|---|---|
| [`@weaveintel/core`](packages/core) | Contracts, types, context, events, middleware, plugin registry — zero vendor deps |
| [`@weaveintel/models`](packages/models) | Unified model router with fallback chains, streaming, middleware, capability selection |
| [`@weaveintel/provider-openai`](packages/provider-openai) | OpenAI adapter — chat, streaming, embeddings, image, audio, structured output, vision |
| [`@weaveintel/provider-anthropic`](packages/provider-anthropic) | Anthropic adapter — chat, streaming, tool use, extended thinking, vision, token counting, batches, computer use, prompt caching |
| [`@weaveintel/testing`](packages/testing) | Fake models, embeddings, vector stores, and MCP transports for deterministic tests |

### Agent Orchestration

| Package | Description |
|---|---|
| [`@weaveintel/agents`](packages/agents) | Agent runtime — ReAct tool-calling loop, supervisor-worker hierarchies |
| [`@weaveintel/workflows`](packages/workflows) | Multi-step workflow engine with conditional branching, checkpointing, and compensation |
| [`@weaveintel/human-tasks`](packages/human-tasks) | Human-in-the-loop — approval tasks, review queues, escalation, decision logging, policy evaluation |
| [`@weaveintel/contracts`](packages/contracts) | Completion contracts with evidence bundles and completion reports |
| [`@weaveintel/prompts`](packages/prompts) | Versioned prompt templates, frameworks/fragments, linting, output contracts, provider render adapters, DB-backed strategy runtime |
| [`@weaveintel/routing`](packages/routing) | Smart model routing — health tracking, capability matching, weighted scoring, explainable decisions |

### Knowledge & Retrieval

| Package | Description |
|---|---|
| [`@weaveintel/retrieval`](packages/retrieval) | Document chunking (6 strategies), embedding pipeline, vector retrieval with reranking |
| [`@weaveintel/memory`](packages/memory) | Conversation, semantic, and entity memory implementations |
| [`@weaveintel/graph`](packages/graph) | Knowledge graph — entity nodes, relationship edges, entity linking, timeline, graph retrieval |
| [`@weaveintel/extraction`](packages/extraction) | Document extraction pipeline — entity, metadata, timeline, table, code, and task stages |
| [`@weaveintel/cache`](packages/cache) | Semantic caching with TTL, LRU eviction, and embedding-based lookup |
| [`@weaveintel/artifacts`](packages/artifacts) | Artifact storage — versioned blobs with metadata, tagging, and lifecycle management |

### Tools & Connectivity

| Package | Description |
|---|---|
| [`@weaveintel/tools`](packages/tools) | Extended tool registry — versioning, risk tagging, health tracking, test harness |
| [`@weaveintel/tools-search`](packages/tools-search) | Web search tools — DuckDuckGo, Brave, with structured result parsing |
| [`@weaveintel/tools-browser`](packages/tools-browser) | Browser tools — URL fetching, content extraction, page rendering |
| [`@weaveintel/tools-http`](packages/tools-http) | HTTP endpoint tools — REST client with auth, rate limiting, schema validation |
| [`@weaveintel/tools-enterprise`](packages/tools-enterprise) | Enterprise connectors — Jira (31 tools), ServiceNow (283 tools), Canva (21 tools), Confluence, Salesforce, Notion |
| [`@weaveintel/tools-social`](packages/tools-social) | Social media tools — Twitter/X, LinkedIn, with content formatting |
| [`@weaveintel/tools-time`](packages/tools-time) | Temporal tools — datetime, timezone, timers, stopwatches, reminders with pluggable state stores |
| [`@weaveintel/oauth`](packages/oauth) | OAuth client/provider toolkit for authorization URL generation, code exchange, and provider profile retrieval |
| [`@weaveintel/mcp-client`](packages/mcp-client) | MCP protocol client — discover and invoke remote tools, resources, prompts |
| [`@weaveintel/mcp-server`](packages/mcp-server) | MCP protocol server — expose tools, resources, and prompts |
| [`@weaveintel/mcp-statsnz`](packages/mcp-statsnz) | Pre-wired Stats NZ MCP server assembly — registers `statsnz_*` tools and provides stdio startup helpers |
| [`@weaveintel/a2a`](packages/a2a) | Agent-to-agent protocol — remote HTTP + in-process bus for multi-agent systems |
| [`@weaveintel/plugins`](packages/plugins) | Plugin lifecycle — register, enable/disable, validate, dependency resolution |

### Safety & Governance

| Package | Description |
|---|---|
| [`@weaveintel/guardrails`](packages/guardrails) | Guardrail pipeline — risk classification, cost guards, governance context, runtime policies |
| [`@weaveintel/redaction`](packages/redaction) | PII detection (email, phone, SSN, CC, etc.), policy engine, reversible tokenization |
| [`@weaveintel/compliance`](packages/compliance) | Data retention engine, GDPR/CCPA deletion, legal holds, consent management, audit export |
| [`@weaveintel/sandbox`](packages/sandbox) | Sandboxed execution — policy enforcement, resource limits, allowed/blocked module lists |
| [`@weaveintel/identity`](packages/identity) | Identity management — delegation chains, ACL enforcement, scoped access |
| [`@weaveintel/tenancy`](packages/tenancy) | Multi-tenancy — tenant isolation, budget management, scoped configuration |
| [`@weaveintel/reliability`](packages/reliability) | Reliability patterns — idempotency, retry budgets, dead-letter queues, health checking, backpressure |

### Observability & Evaluation

| Package | Description |
|---|---|
| [`@weaveintel/observability`](packages/observability) | Tracing, spans, event bus, cost/token usage tracking |
| [`@weaveintel/evals`](packages/evals) | Evaluation runner with 6 assertion types (exact, contains, regex, schema, latency, cost) |
| [`@weaveintel/replay`](packages/replay) | Trace replay — record and replay agent interactions for debugging and regression testing |

### Application Layer

| Package | Description |
|---|---|
| [`@weaveintel/recipes`](packages/recipes) | Pre-built agent factories — governed assistant, approval-driven, workflow, eval-routed, safe execution |
| [`@weaveintel/devtools`](packages/devtools) | Developer tools — scaffolding, inspection, validation, mock runtimes, migration planning |
| [`@weaveintel/ui-primitives`](packages/ui-primitives) | UI streaming events, widgets (table, chart, form, code, timeline), artifacts, citations, progress |
| [`@weaveintel/triggers`](packages/triggers) | Trigger system — cron schedules, webhooks, queue-based triggers with filtering |
| [`@weaveintel/collaboration`](packages/collaboration) | Session management — multi-user handoff, shared context, agent collaboration |
| [`@weaveintel/geneweave`](apps/geneweave) | Full-stack demo app — chat UI, admin dashboard, tools, auth, SQLite backend |

## geneWeave Feature Set

The geneWeave app in [apps/geneweave](apps/geneweave) is the reference full-stack implementation built on WeaveIntel packages.

- Authentication and account management:
  - email/password auth with JWT + CSRF protection
  - OAuth sign-in and linked account management
  - encrypted website credential vault for browser-login flows
- Persona RBAC:
  - user + agent personas (platform/tenant/admin/worker/researcher/supervisor)
  - deny-by-default behavior for missing/invalid personas
  - admin RBAC endpoints for persona introspection and persona assignment
  - persona-aware tool filtering and route authorization
- Chat runtime:
  - direct mode, agent mode, and supervisor-worker mode
  - streaming responses, persisted chats/messages/settings
  - per-chat tool policies and worker definitions
- Tool ecosystem integration:
  - time tools, search tools, browser automation/auth handoff tools
  - enterprise connectors and social APIs via tool packages
  - dynamic tool availability by persona
  - skill→tool policy closure: activated skill `toolPolicyKey` automatically scopes every tool call in that session
  - operator approval workflow: policy-gated tools produce `tool_approval_requests`; resolved via admin API
- Safety and governance:
  - pre/post execution guardrails
  - PII redaction
  - human task policy integration
- Memory and retrieval:
  - semantic and entity memory recall
  - hybrid extraction hooks for long-term memory
- Observability and quality:
  - trace capture with per-tool-call spans
  - dashboard metrics (tokens, costs, latency)
  - evaluation and replay data surfaces
- Operations:
  - SQLite-backed persistence and migrations
  - deploy manifests for Docker, Kubernetes, Fly, Railway, Render, Azure, AWS, and GCP

## Prompt Capability Platform (What Is New)

The prompt system has moved from basic template storage to a platform capability with explicit runtime behavior, validation, and admin management.

This section explains what the new prompt capabilities mean, what they cover, and what remains in progress.

### Why this change matters

- Prompts are now treated as managed runtime assets, not just free-form text.
- Runtime execution strategy is explicit and traceable.
- Prompt structure and quality can be validated before model execution.
- geneWeave admin now manages prompt-related runtime assets in dedicated tabs.

### Capability coverage (implemented)

| Capability | What it does | Where it lives |
|---|---|---|
| Prompt frameworks | Defines named prompt sections and assembly order | [packages/prompts/src/frameworks.ts](packages/prompts/src/frameworks.ts) |
| Prompt fragments | Reusable partial blocks via `{{>fragment}}` references | [packages/prompts/src/fragments.ts](packages/prompts/src/fragments.ts) |
| Unified rendering path | Fragment resolution + optional lint + interpolation in one path | [packages/prompts/src/template.ts](packages/prompts/src/template.ts) |
| Prompt linting | Static checks for missing/undefined variables, unresolved fragments, size, metadata quality | [packages/prompts/src/lint.ts](packages/prompts/src/lint.ts) |
| Provider adapters | Render output adaptation for OpenAI, Anthropic, text, and system-as-user flows | [packages/prompts/src/providers.ts](packages/prompts/src/providers.ts) |
| Strategy runtime | Pluggable prompt execution strategies with fallback semantics | [packages/prompts/src/runtime.ts](packages/prompts/src/runtime.ts) |
| DB strategy integration | Merge built-in strategies with admin-managed DB strategies at runtime | [apps/geneweave/src/chat.ts](apps/geneweave/src/chat.ts) |
| Prompt strategy telemetry in chat metadata | Records requested/resolved strategy and fallback use | [apps/geneweave/src/chat.ts](apps/geneweave/src/chat.ts) |
| Admin CRUD for frameworks/fragments/contracts/strategies | API endpoints for prompt capability records | [apps/geneweave/src/server-admin.ts](apps/geneweave/src/server-admin.ts) |
| Admin UI tabs | Dedicated tabs for Frameworks, Fragments, Output Contracts, and Strategies | [apps/geneweave/src/admin-schema.ts](apps/geneweave/src/admin-schema.ts) |

### What this means at runtime

When geneWeave resolves a DB-backed system prompt:

1. Prompt data is loaded from prompt records (with active version settings).
2. Fragments are expanded.
3. Prompt rendering runs through shared `@weaveintel/prompts` helpers.
4. Strategy is selected using priority order:
   - explicit override
   - prompt `executionDefaults.strategy`
   - built-in fallback strategy
5. Runtime metadata captures strategy requested vs resolved and fallback status.

This makes prompt behavior reproducible, inspectable, and less dependent on ad hoc code paths.

### Admin UI coverage

The Admin panel now includes prompt capability tabs under Core AI:

- Prompts
- Frameworks
- Fragments
- Output Contracts
- Strategies

Each tab is backed by authenticated admin CRUD routes in [apps/geneweave/src/server-admin.ts](apps/geneweave/src/server-admin.ts).

### Prompt boundaries (important)

Prompt assets are now documented with stricter boundaries:

- Use prompts for model-facing instruction assets and reusable renderable templates.
- Use skills for reusable behavior bundles (instructions + tool usage guidance + execution behavior).
- Use tools/workers for executable capabilities and data access.
- Use runtime policies for orchestration constraints that must always execute.

This prevents policy logic from being hidden in generic prompt text.

### Current phase status

Implemented now:

- Prompt frameworks and fragments
- Prompt linting and unified rendering path
- Provider-aware prompt render adapters
- Strategy runtime + DB strategy records + chat metadata wiring
- Admin CRUD and UI tabs for frameworks/fragments/contracts/strategies
- Phase 6 Tool Policy Closure + Approval Workflow (skill `toolPolicyKey` → runtime enforcement; `tool_approval_requests` admin API)

Implemented now (Phase 9 initial modularization):

- Shared admin capability schema primitives moved to [packages/core/src/admin-capabilities.ts](packages/core/src/admin-capabilities.ts) so multiple apps can consume a consistent tab/field model.
- GeneWeave admin schema now consumes shared types/helpers from `@weaveintel/core` and applies model-discovery label normalization.
- Prompt capability admin tabs extracted into [apps/geneweave/src/admin/schema/prompt-capability-tabs.ts](apps/geneweave/src/admin/schema/prompt-capability-tabs.ts) to reduce monolithic schema pressure.
- Added end-to-end DB-driven Phase 9 example at [examples/32-phase9-admin-capability-e2e.ts](examples/32-phase9-admin-capability-e2e.ts) that creates prompt/strategy/skill records, resolves prompt telemetry, runs chat, and reads dashboard traces.

In progress (next focus):

- Deeper output-contract validation wiring in runtime response paths
- Broader observability rollups for prompt contract validation events
- Further modular extraction for `server-admin.ts`, `server.ts`, and `ui.ts` domain units
- UI hardening for advanced typed JSON editors and operator guidance per capability tab

For detailed phased roadmap and boundaries, see [docs/PROMPT_CAPABILITY_IMPLEMENTATION_PLAN.md](docs/PROMPT_CAPABILITY_IMPLEMENTATION_PLAN.md).

### Operational note

geneWeave serves admin UI modules from `apps/geneweave/dist` via static routes.

After changing admin schema/UI TypeScript sources, rebuild before verifying UI changes:

```bash
npm run build --workspace @weaveintel/geneweave
```

## Quick Start

### Prerequisites

- Node.js >= 20
- npm >= 10

### Install

```bash
git clone https://github.com/gibyvarghese/weaveintel.git
cd weaveintel
npm install
npm run build
```

### Environment Variables

Set API keys as needed:

```bash
export OPENAI_API_KEY="sk-..."          # For OpenAI provider
export ANTHROPIC_API_KEY="sk-ant-..."   # For Anthropic provider
export STATSNZ_API_KEY="..."            # Optional: required for statsnz_* tools and Stats NZ MCP server
```

---

## How-To Guides

### 1. Simple Chat Completion (OpenAI)

Use `weaveOpenAIModel` for basic chat, streaming, and structured output with OpenAI models.

```typescript
import { weaveContext } from '@weaveintel/core';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

const ctx = weaveContext({ userId: 'demo' });
const model = weaveOpenAIModel({ apiKey: process.env['OPENAI_API_KEY']!, model: 'gpt-4o-mini' });

const response = await model.chat(
  { messages: [{ role: 'user', content: 'What is the capital of France?' }] },
  ctx,
);
console.log(response.content); // "Paris"
```

**Streaming:**

```typescript
const stream = await model.stream(
  { messages: [{ role: 'user', content: 'Count from 1 to 5.' }] },
  ctx,
);
for await (const chunk of stream) {
  if (chunk.text) process.stdout.write(chunk.text);
}
```

> **Run it:** `npx tsx examples/01-simple-chat.ts`

---

### 2. Tool-Calling Agent

Build a ReAct-style agent that discovers and invokes tools to answer questions.

```typescript
import { weaveContext, weaveToolRegistry, weaveTool } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

const tools = weaveToolRegistry();
tools.register(
  weaveTool({
    name: 'get_weather',
    description: 'Get weather for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    execute: async (args) => '22°C, Sunny',
  }),
);

const model = weaveFakeModel({ responses: ['I need to check the weather.', 'It is 22°C and sunny.'] });
const agent = weaveAgent({ model, tools, systemPrompt: 'You are a weather assistant.' });

const ctx = weaveContext({ userId: 'demo' });
const result = await agent.run({ messages: [{ role: 'user', content: 'Weather in Paris?' }] }, ctx);
```

> **Run it:** `npx tsx examples/02-tool-calling-agent.ts`

---

### 3. RAG Pipeline

Chunk documents, embed them into a vector store, then retrieve relevant context for generation.

```typescript
import { weaveChunker, weaveEmbeddingPipeline, weaveVectorRetriever } from '@weaveintel/retrieval';

const chunker = weaveChunker({ strategy: 'fixed-size', chunkSize: 512, overlap: 50 });
const pipeline = weaveEmbeddingPipeline({ embeddingModel, vectorStore, chunker });
const retriever = weaveVectorRetriever({ embeddingModel, vectorStore, topK: 5 });

// Ingest a document
await pipeline.ingestDocument(document, ctx);

// Retrieve relevant chunks
const results = await retriever.retrieve({ query: 'How does TypeScript handle generics?' }, ctx);
```

> **Run it:** `npx tsx examples/03-rag-pipeline.ts`

---

### 4. Hierarchical Agents

Create a supervisor agent that delegates tasks to specialized worker agents.

```typescript
import { weaveSupervisor, weaveAgent } from '@weaveintel/agents';

const researcher = weaveAgent({ model, tools: researchTools, systemPrompt: 'You are a researcher.' });
const writer = weaveAgent({ model, tools: writeTools, systemPrompt: 'You are a writer.' });

const supervisor = weaveSupervisor({
  model,
  workers: { researcher, writer },
  systemPrompt: 'Delegate research tasks to the researcher and writing tasks to the writer.',
});

const result = await supervisor.run(
  { messages: [{ role: 'user', content: 'Write a summary about TypeScript generics.' }] },
  ctx,
);
```

> **Run it:** `npx tsx examples/04-hierarchical-agents.ts`

---

### 5. MCP Integration

Create an MCP server with tools and resources, connect a client, and invoke tools via the MCP protocol.

```typescript
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveMCPClient } from '@weaveintel/mcp-client';

// Server
const server = weaveMCPServer({ name: 'my-tools', version: '1.0.0' });
server.addTool(
  { name: 'greet', description: 'Greet a user', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  async (args) => ({ content: [{ type: 'text', text: `Hello, ${args.name}!` }] }),
);

// Client — discover and invoke
const client = weaveMCPClient(transport);
await client.connect();
const tools = await client.listTools();
const result = await client.callTool('greet', { name: 'weaveIntel' });
```

> **Run it:** `npx tsx examples/05-mcp-integration.ts`

### 5b. Pre-Wired Stats NZ MCP Server

Use the reusable Stats NZ MCP package when you want a dedicated MCP server that exposes the `statsnz_*` tools.

Design split:

- Generic transport/protocol server: [packages/mcp-server](packages/mcp-server)
- Stats NZ domain-specific MCP assembly: [packages/mcp-statsnz](packages/mcp-statsnz)
- App launcher (thin entrypoint): [apps/geneweave/src/statsnz-mcp-server.ts](apps/geneweave/src/statsnz-mcp-server.ts)

Programmatic usage:

```typescript
import { startStatsNzMCPServerOverStdio } from '@weaveintel/mcp-statsnz';

const { tools, transport } = await startStatsNzMCPServerOverStdio({
  name: 'statsnz-ade',
  version: '1.0.0',
});

console.error(`Stats NZ MCP started with ${Object.keys(tools).length} tools`);

process.stdin.on('end', () => {
  transport.close().finally(() => process.exit(0));
});
```

CLI launcher (from geneWeave dist output):

```bash
STATSNZ_API_KEY=your-key node apps/geneweave/dist/statsnz-mcp-server.js
```

Notes:

- Keep MCP framework code generic in `@weaveintel/mcp-server`.
- Put reusable domain wiring in dedicated MCP packages (like `@weaveintel/mcp-statsnz`).
- Keep app entrypoints thin and runtime-specific.

---

### 6. Agent-to-Agent (A2A) Communication

Use the in-process A2A bus for inter-agent delegation and discovery.

```typescript
import { weaveA2ABus } from '@weaveintel/a2a';

const bus = weaveA2ABus();

bus.register('summarizer', async (task) => ({ summary: 'Condensed text...' }));
bus.register('translator', async (task) => ({ translated: 'Texte traduit...' }));

const summary = await bus.send('summarizer', { text: 'Long document here...' });
const translated = await bus.send('translator', { text: summary.summary, targetLang: 'fr' });
```

> **Run it:** `npx tsx examples/06-a2a-communication.ts`

---

### 7. Memory-Augmented Agent

Give agents persistent context with conversation, semantic, and entity memory.

```typescript
import { weaveConversationMemory, weaveSemanticMemory, weaveEntityMemory } from '@weaveintel/memory';

const conversationMemory = weaveConversationMemory({ maxTurns: 20 });
const semanticMemory = weaveSemanticMemory({ embeddingModel, vectorStore, topK: 3 });
const entityMemory = weaveEntityMemory();

// Store and retrieve
await conversationMemory.add({ role: 'user', content: 'My name is Alice.' });
await entityMemory.upsert('Alice', { type: 'person', notes: 'User introduced themselves' });

const history = await conversationMemory.get();
const relatedFacts = await semanticMemory.search('Who is Alice?');
```

> **Run it:** `npx tsx examples/07-memory-augmented-agent.ts`

---

### 8. PII Redaction

Detect, mask, and restore personally identifiable information before sending data to LLMs.

```typescript
import { weaveRedactor } from '@weaveintel/redaction';

const redactor = weaveRedactor({ patterns: ['email', 'phone', 'ssn', 'credit_card'] });
const result = redactor.redact('Contact john@example.com or 555-123-4567');

console.log(result.redacted);                // "Contact [EMAIL_0] or [PHONE_0]"
console.log(result.restore(result.redacted)); // "Contact john@example.com or 555-123-4567"
```

> **Run it:** `npx tsx examples/08-pii-redaction.ts`

---

### 9. Evaluation Suite

Run structured evaluations against model outputs with assertions, scoring, and reporting.

```typescript
import { weaveEvalRunner } from '@weaveintel/evals';

const runner = weaveEvalRunner({ model });

const results = await runner.run({
  name: 'geography',
  cases: [
    {
      input: { messages: [{ role: 'user', content: 'Capital of France?' }] },
      assertions: [
        { type: 'contains', value: 'Paris' },
        { type: 'latency_threshold', value: 5000 },
      ],
    },
  ],
}, ctx);

console.log(`Score: ${results.score}`);
```

> **Run it:** `npx tsx examples/09-eval-suite.ts`

---

### 10. Observability

Trace AI workflows with spans, event bus, and usage tracking for monitoring and debugging.

```typescript
import { weaveTracer, weaveEventBus } from '@weaveintel/observability';

const bus = weaveEventBus();
const tracer = weaveTracer({ serviceName: 'my-app', eventBus: bus });

// Listen for events
bus.on('span:end', (span) => {
  console.log(`${span.name}: ${span.duration}ms, tokens: ${span.usage?.totalTokens}`);
});

// Wrap operations in spans
const span = tracer.startSpan('chat-completion');
const response = await model.generate(ctx, request);
span.end({ usage: response.usage });
```

> **Run it:** `npx tsx examples/10-observability.ts`

---

### 11. Anthropic Provider (Full Capabilities)

The `@weaveintel/provider-anthropic` package provides complete access to the Anthropic Messages API.

#### Basic Chat

```typescript
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext } from '@weaveintel/core';

const ctx = weaveContext({ timeout: 60_000 });
const model = weaveAnthropicModel('claude-sonnet-4-20250514');

const response = await model.generate(ctx, {
  messages: [{ role: 'user', content: 'Hello!' }],
  maxTokens: 200,
});
console.log(response.content);
console.log(`Tokens: ${response.usage.promptTokens} in, ${response.usage.completionTokens} out`);
```

#### Streaming

```typescript
const stream = model.stream!(ctx, {
  messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
  maxTokens: 100,
});
for await (const chunk of stream) {
  if (chunk.text) process.stdout.write(chunk.text);
}
```

#### Tool Use (Function Calling)

```typescript
const response = await model.generate(ctx, {
  messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  ],
  toolChoice: 'auto',
  maxTokens: 200,
});

if (response.toolCalls?.length) {
  const call = response.toolCalls[0];
  console.log(`Tool: ${call.name}, Args: ${call.arguments}`);
}
```

#### Extended Thinking

```typescript
import { generateWithThinking, manualThinking, extractThinkingBlocks } from '@weaveintel/provider-anthropic';

const result = await generateWithThinking(
  model, ctx,
  {
    messages: [{ role: 'user', content: 'What is 127 * 389?' }],
    maxTokens: 16000,
  },
  manualThinking(10000), // 10k token thinking budget
);

console.log('Answer:', result.content);
console.log('Reasoning:', result.reasoning);

const blocks = extractThinkingBlocks(result);
for (const block of blocks) {
  if (block.type === 'thinking') console.log('Thinking:', block.thinking.slice(0, 200));
}
```

Thinking config options:
- `manualThinking(budgetTokens)` — Fixed token budget for thinking
- `adaptiveThinking()` — Let the model decide how much to think
- `disableThinking()` — Disable extended thinking

#### Vision

```typescript
const response = await model.generate(ctx, {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image', url: 'https://example.com/photo.png' },
        { type: 'text', text: 'Describe this image.' },
      ],
    },
  ],
  maxTokens: 300,
});
```

#### Token Counting

```typescript
import { weaveAnthropicCountTokens } from '@weaveintel/provider-anthropic';

const count = await weaveAnthropicCountTokens({
  model: 'claude-sonnet-4-20250514',
  messages: [{ role: 'user', content: 'Hello, how are you?' }],
  system: 'You are a helpful assistant.',
});
console.log(`Input tokens: ${count.input_tokens}`);
```

#### Prompt Caching

```typescript
const response = await model.generate(ctx, {
  messages: [
    { role: 'system', content: longSystemPrompt },
    { role: 'user', content: 'Summarize the above.' },
  ],
  maxTokens: 200,
  metadata: { cacheControl: { type: 'ephemeral' } },
});

// Cache stats in response metadata
console.log('Cache creation:', response.metadata?.cacheCreationInputTokens);
console.log('Cache read:', response.metadata?.cacheReadInputTokens);
```

#### Computer Use Tools

```typescript
import {
  weaveAnthropicComputerTool,
  weaveAnthropicTextEditorTool,
  weaveAnthropicBashTool,
  weaveAnthropicScreenshotResult,
  weaveAnthropicTextResult,
} from '@weaveintel/provider-anthropic';

const tools = [
  weaveAnthropicComputerTool(1920, 1080),  // Screen resolution
  weaveAnthropicTextEditorTool(),
  weaveAnthropicBashTool(),
];

// Build tool results to send back
const screenshot = weaveAnthropicScreenshotResult('tool-id', base64Data, 'image/png');
const textResult = weaveAnthropicTextResult('tool-id', 'command output');
```

#### Batches API

```typescript
import {
  weaveAnthropicCreateBatch,
  weaveAnthropicListBatches,
  weaveAnthropicGetBatch,
  weaveAnthropicGetBatchResults,
} from '@weaveintel/provider-anthropic';

// List existing batches
const batches = await weaveAnthropicListBatches({ limit: 10 });

// Create a batch
const batch = await weaveAnthropicCreateBatch([
  { custom_id: 'req-1', params: { model: 'claude-sonnet-4-20250514', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }] } },
]);

// Check status and get results
const status = await weaveAnthropicGetBatch(batch.id);
for await (const result of weaveAnthropicGetBatchResults(batch.id)) {
  console.log(result);
}
```

#### Convenience API

```typescript
import { weaveAnthropic, weaveAnthropicConfig } from '@weaveintel/provider-anthropic';

// Quick model creation
const model = weaveAnthropic('claude-sonnet-4-20250514');
console.log(model.info.modelId);       // "claude-sonnet-4-20250514"
console.log(model.info.provider);      // "anthropic"
console.log([...model.capabilities]);  // ["model.chat", "model.streaming", "model.tool_calling", ...]

// Set global defaults
weaveAnthropicConfig({ apiKey: 'sk-ant-...', baseUrl: 'https://custom-proxy.com' });
```

> **Run it:** `ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/11-anthropic-provider.ts`
>
> The example runs **77 automated tests** covering all capabilities above.

---

## Model Router with Fallback

Use the unified router to select models by capability and automatically fall back on failure.

```typescript
import { weaveModel } from '@weaveintel/models';
import '@weaveintel/provider-openai';     // auto-registers 'openai'
import '@weaveintel/provider-anthropic';  // auto-registers 'anthropic'

const model = weaveModel({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  fallback: [
    { provider: 'openai', model: 'gpt-4o-mini' },
  ],
});
```

## Project Structure

```
weaveintel/
├── packages/
│   ├── core/               # Contracts & types (zero deps)
│   ├── models/             # Router, fallback, middleware
│   ├── provider-openai/    # OpenAI adapter
│   ├── provider-anthropic/ # Anthropic adapter (Claude)
│   ├── agents/             # Tool-calling agent, supervisor
│   ├── workflows/          # Multi-step workflow engine
│   ├── human-tasks/        # Approval, review, escalation
│   ├── contracts/          # Completion contracts & evidence
│   ├── prompts/            # Versioned templates, A/B experiments
│   ├── routing/            # Smart model routing & health
│   ├── retrieval/          # Chunking, embedding, retriever
│   ├── memory/             # Conversation, semantic, entity memory
│   ├── graph/              # Knowledge graph & entity linking
│   ├── extraction/         # Document extraction pipeline
│   ├── cache/              # Semantic caching
│   ├── artifacts/          # Versioned artifact storage
│   ├── tools/              # Extended tool registry
│   ├── tools-search/       # Web search (DuckDuckGo, Brave)
│   ├── tools-browser/      # URL fetch & content extraction
│   ├── tools-http/         # REST client tools
│   ├── tools-enterprise/   # Jira, ServiceNow (283 tools), Canva connectors
│   ├── tools-social/       # Social media tools
│   ├── tools-time/         # Datetime, timezone, timer, stopwatch, reminders
│   ├── oauth/              # OAuth provider/client toolkit
│   ├── mcp-client/         # MCP protocol client
│   ├── mcp-server/         # MCP protocol server
│   ├── mcp-statsnz/        # Pre-wired Stats NZ MCP server assembly
│   ├── a2a/                # Agent-to-agent communication
│   ├── plugins/            # Plugin lifecycle management
│   ├── guardrails/         # Risk classification & cost guards
│   ├── redaction/          # PII detection & policy engine
│   ├── compliance/         # Retention, deletion, legal holds
│   ├── sandbox/            # Sandboxed execution
│   ├── identity/           # Identity & ACL
│   ├── tenancy/            # Multi-tenant isolation
│   ├── reliability/        # Idempotency, retries, DLQ
│   ├── observability/      # Tracer, spans, usage tracking
│   ├── evals/              # Evaluation runner & assertions
│   ├── replay/             # Trace replay & debugging
│   ├── recipes/            # Pre-built agent factories
│   ├── devtools/           # Scaffolding, inspection, mocks
│   ├── ui-primitives/      # Streaming events & widgets
│   ├── triggers/           # Cron, webhooks, queue triggers
│   ├── collaboration/      # Session management & handoff
│   ├── testing/            # Fakes & test harnesses
├── apps/
│   └── geneweave/          # Full-stack demo app
├── examples/               # 29 runnable examples
├── turbo.json              # Turborepo config
├── tsconfig.base.json      # Shared TypeScript config
└── package.json            # Workspace root
```

## Development

```bash
# Build all packages
npm run build

# Type-check without emitting
npm run typecheck

# Format code
npm run format

# Run tests
npm run test

# Clean build artifacts
npm run clean
```

### Running Examples

All examples can be run directly with `tsx`:

```bash
# No API key needed (uses fake models / in-memory)
npx tsx examples/02-tool-calling-agent.ts
npx tsx examples/03-rag-pipeline.ts
npx tsx examples/04-hierarchical-agents.ts
npx tsx examples/05-mcp-integration.ts
npx tsx examples/06-a2a-communication.ts
npx tsx examples/07-memory-augmented-agent.ts
npx tsx examples/08-pii-redaction.ts
npx tsx examples/09-eval-suite.ts
npx tsx examples/10-observability.ts
npx tsx examples/13-workflow-engine.ts
npx tsx examples/14-smart-routing.ts
npx tsx examples/15-tool-ecosystem.ts
npx tsx examples/16-human-in-the-loop.ts
npx tsx examples/17-prompt-management.ts
npx tsx examples/18-knowledge-graph.ts
npx tsx examples/19-compliance-sandbox.ts
npx tsx examples/20-recipes-devtools.ts
npx tsx examples/21-full-api-tools.ts
npx tsx examples/21-guardrails-date-evidence.ts
npx tsx examples/22-chat-memory-extraction.ts
npx tsx examples/23-chat-guardrails-pipeline.ts
npx tsx examples/24-web-search-providers.ts
npx tsx examples/25-semantic-cache.ts
npx tsx examples/26-advanced-retrieval.ts
npx tsx examples/27-browser-automation.ts
npx tsx examples/28-package-auth-rbac.ts
npx tsx examples/29-authenticated-agent-tools.ts

# Requires OPENAI_API_KEY
OPENAI_API_KEY=sk-... npx tsx examples/01-simple-chat.ts

# Requires ANTHROPIC_API_KEY
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/11-anthropic-provider.ts

# Full-stack demo (requires provider key, defaults to port 3500)
PORT=3501 npx tsx examples/12-geneweave.ts
```

### Adding a New Provider

1. Create `packages/provider-<name>/` with `package.json`, `tsconfig.json`, and `src/index.ts`
2. Implement the `Model` interface from `@weaveintel/core`
3. Call `weaveRegisterModel('<name>', factory)` from `@weaveintel/models` at import time
4. Add a reference in the root `tsconfig.json`

### Core Design Principles

- **Interfaces in core, implementations in leaf packages** — core never imports from providers or runtime packages.
- **Middleware is generic** — `Middleware<T, R>` works for any request/response pair. Compose with `weaveComposeMiddleware()`.
- **Everything is capability-gated** — `HasCapabilities` interface + `weaveCapabilitySet()` let the router and consumers check model abilities at runtime.
- **Context flows everywhere** — `ExecutionContext` carries userId, traceId, budget, deadline, and cancellation signal through every call.

## Examples

The [examples](examples) directory contains 29 runnable demonstrations:

| # | File | What It Shows | Packages Used | API Key |
|---|---|---|---|---|
| 01 | [Simple Chat](examples/01-simple-chat.ts) | Basic completion, streaming, structured output | core, provider-openai | OpenAI |
| 02 | [Tool-Calling Agent](examples/02-tool-calling-agent.ts) | ReAct loop, tool registry, fake model | core, agents, testing | None |
| 03 | [RAG Pipeline](examples/03-rag-pipeline.ts) | Chunking, embedding, vector search, RAG | core, retrieval, testing | None |
| 04 | [Hierarchical Agents](examples/04-hierarchical-agents.ts) | Supervisor-worker delegation | core, agents, testing | None |
| 05 | [MCP Integration](examples/05-mcp-integration.ts) | MCP server + client, tool bridge | mcp-server, mcp-client, testing | None |
| 06 | [A2A Communication](examples/06-a2a-communication.ts) | Agent-to-agent bus, discovery, task delegation | a2a, agents, testing | None |
| 07 | [Memory-Augmented Agent](examples/07-memory-augmented-agent.ts) | Conversation, semantic, and entity memory | memory, agents, testing | None |
| 08 | [PII Redaction](examples/08-pii-redaction.ts) | Detection, replacement, restoration, policy engine | redaction | None |
| 09 | [Eval Suite](examples/09-eval-suite.ts) | Assertions, scoring, aggregate results | evals, testing | None |
| 10 | [Observability](examples/10-observability.ts) | Tracing, spans, event bus, usage tracking | observability | None |
| 11 | [Anthropic Provider](examples/11-anthropic-provider.ts) | Chat, streaming, tools, thinking, vision, caching, batches, computer use (77 tests) | provider-anthropic, core | Anthropic |
| 12 | [GeneWeave App](examples/12-geneweave.ts) | Full-stack chat app with auth, persona RBAC, admin dashboard, streaming chat, traces, recipes, devtools | geneweave | OpenAI or Anthropic |
| 13 | [Workflow Engine](examples/13-workflow-engine.ts) | Multi-step workflows, conditional branching, checkpoints, compensation, guardrails | workflows, guardrails, core | None |
| 14 | [Smart Routing](examples/14-smart-routing.ts) | Model routing, health tracking, weighted scoring, capability filtering, explainable decisions | routing | None |
| 15 | [Tool Ecosystem](examples/15-tool-ecosystem.ts) | Extended tool registry, web search, browser, HTTP tools, agent with multi-tool research | tools, tools-search, tools-browser, tools-http, agents, testing | None |
| 16 | [Human-in-the-Loop](examples/16-human-in-the-loop.ts) | Approval tasks, review queues, escalation, decision logging, policy evaluation, contracts, evidence bundles | human-tasks, contracts, agents, testing | None |
| 17 | [Prompt Management](examples/17-prompt-management.ts) | Versioned templates, A/B experiments, instruction bundles, DB-backed strategy runtime execution, scoped resolution | prompts, agents, testing | None |
| 18 | [Knowledge Graph](examples/18-knowledge-graph.ts) | Entity nodes, relationships, entity linking, timeline, graph retrieval, extraction pipeline | graph, extraction, agents, testing | None |
| 19 | [Compliance & Sandbox](examples/19-compliance-sandbox.ts) | Data retention, legal holds, consent, audit export, sandboxed execution, idempotency, retries, DLQ, health checking | compliance, sandbox, reliability | None |
| 20 | [Recipes & DevTools](examples/20-recipes-devtools.ts) | Pre-built agents, scaffolding, inspection, validation, mock runtime, streaming events, widgets, artifacts, citations, progress | recipes, devtools, ui-primitives | None |
| 21 | [Full API Tool Ecosystem](examples/21-full-api-tools.ts) | Universal auth profiles, token lifecycle, enterprise/social API tool generation and MCP exposure | tools-enterprise, tools-social, core | None |
| 21b | [Guardrails Date Evidence](examples/21-guardrails-date-evidence.ts) | Tool-grounded vs memory-based responses, post-execution grounding behavior, date/day evidence handling | guardrails, agents, tools-time, testing | None |
| 22 | [Chat Memory Extraction](examples/22-chat-memory-extraction.ts) | Chat-style hybrid memory extraction (regex + LLM) with tool calls (datetime, calculator, duckduckgo search) and in-memory recall context (no DB) | memory, core, tools | None |
| 23 | [Chat Guardrails Pipeline](examples/23-chat-guardrails-pipeline.ts) | Post-execution guardrail evaluation with executed tool evidence (datetime, calculator, duckduckgo search), memory-only warnings, and deny paths (no DB) | guardrails, core, tools | None |
| 24 | [Web Search Providers](examples/24-web-search-providers.ts) | Multi-provider search router, HTML fallback, fan-out search, MCP tool exposure, agent integration | tools-search, agents, core, testing | None |
| 25 | [Semantic Cache](examples/25-semantic-cache.ts) | Cache store, semantic similarity cache, key builder, policy resolution, invalidation rules | cache, testing | None |
| 26 | [Advanced Retrieval](examples/26-advanced-retrieval.ts) | Hybrid retriever, query rewrites, citation extraction, retrieval diagnostics | retrieval, testing, core | None |
| 27 | [Browser Automation](examples/27-browser-automation.ts) | Browser fetch/extract/readability/scrape/sitemap, browser pool sessions, auth handoff tools, agent browser delegation | tools-browser, agents, core, testing | None |
| 28 | [Package Auth RBAC](examples/28-package-auth-rbac.ts) | Identity creation, persona extension, permission checks, evaluateAccess, deny-by-default | identity, core | None |
| 29 | [Authenticated Agent + Tools](examples/29-authenticated-agent-tools.ts) | End-to-end agent/tool invocation with identity context and permission-gated tool execution | identity, agents, core, testing | None |
| 33 | [Tool Simulation Harness](examples/33-tool-simulation-harness.ts) | Dry-run and live tool simulation, policy trace inspection, audit event output | tools, geneweave | None |
| 34 | [Skill→Tool Policy + Approval](examples/34-skill-tool-policy-approval.ts) | Skill activation binds toolPolicyKey; approval queue list, approve, deny, conflict and 404 paths | tools, geneweave, human-tasks | None |

## Deployment

geneWeave can be deployed to any platform that runs Node.js 20+ or Docker containers.
All deployment configs live in the repo — pick your platform and follow the steps below.

### Environment Variables

Every deployment requires these environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | **Yes** | Secret for signing auth tokens |
| `ANTHROPIC_API_KEY` | One of these | Anthropic API key |
| `OPENAI_API_KEY` | One of these | OpenAI API key |
| `STATSNZ_API_KEY` | No | Stats NZ ADE subscription key (required for `statsnz_*` tools / Stats NZ MCP server) |
| `PORT` | No | HTTP port (default: `3500`) |
| `DATABASE_PATH` | No | SQLite path (default: `./data/geneweave.db`) |
| `DEFAULT_PROVIDER` | No | `anthropic` or `openai` (auto-detected) |
| `DEFAULT_MODEL` | No | Model ID (auto-detected) |
| `CORS_ORIGIN` | No | Allowed CORS origin |

### Docker

```bash
# Build
docker build -t geneweave .

# Run
docker run -d --name geneweave \
  -p 3500:3500 \
  -e JWT_SECRET=your-secret \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e OPENAI_API_KEY=sk-... \
  -v geneweave-data:/app/data \
  geneweave
```

### Docker Compose

```bash
# Copy .env.example to .env and fill in your keys, then:
docker compose up -d
```

### Fly.io

```bash
fly launch                  # First time — creates app from fly.toml
fly secrets set \
  JWT_SECRET=your-secret \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENAI_API_KEY=sk-...
fly deploy                  # Subsequent deploys
```

### Railway

1. Connect your GitHub repo at [railway.app](https://railway.app)
2. Set environment variables in the dashboard
3. Railway auto-detects `railway.toml` and deploys

### Render

1. Go to [render.com](https://render.com) → New → Blueprint
2. Point to this repo — Render reads `render.yaml`
3. Fill in `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the dashboard
4. `JWT_SECRET` is auto-generated

### Heroku

```bash
heroku create geneweave
heroku config:set \
  JWT_SECRET=your-secret \
  ANTHROPIC_API_KEY=sk-ant-... \
  OPENAI_API_KEY=sk-...
git push heroku main
```

Or click **Deploy to Heroku** — the `app.json` file configures everything.

### Vercel

```bash
vercel --prod
# Set environment variables in the Vercel dashboard
```

> **Note:** Vercel serverless functions have execution time limits. For long-running
> streaming conversations, a container-based platform (Docker, Fly, Railway) is recommended.

### Azure Container Apps

```bash
az login
az containerapp up \
  --name geneweave \
  --resource-group your-rg \
  --location westus2 \
  --source .
# Set secrets via the Azure portal or CLI
```

Or use the GitHub Actions workflow: go to **Actions → Deploy to Azure Container Apps → Run workflow**.
See [`deploy/azure-container-app.yaml`](deploy/azure-container-app.yaml) for the full manifest.

### Google Cloud Run

```bash
gcloud run deploy geneweave \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets=JWT_SECRET=jwt-secret:latest,ANTHROPIC_API_KEY=anthropic-key:latest,OPENAI_API_KEY=openai-key:latest
```

Or use the GitHub Actions workflow: **Actions → Deploy to Google Cloud Run → Run workflow**.
See [`deploy/gcp-cloudrun.yaml`](deploy/gcp-cloudrun.yaml) for the Cloud Run service spec.

### AWS (ECS Fargate)

1. Push the Docker image to ECR (or use the GHCR image)
2. Register the task definition: `aws ecs register-task-definition --cli-input-json file://deploy/aws-ecs-task.json`
3. Create a service pointing to the task definition
4. Store secrets in AWS Systems Manager Parameter Store

Or use the GitHub Actions workflow: **Actions → Deploy to AWS (ECS Fargate) → Run workflow**.

### AWS App Runner

```bash
# Connect GitHub repo in the App Runner console
# Or use the CLI with deploy/aws-apprunner.yaml
```

### DigitalOcean App Platform

```bash
doctl apps create --spec deploy/digitalocean-app.yaml
# Set secrets in the DigitalOcean dashboard
```

### Kubernetes

```bash
# Create secrets
kubectl create secret generic geneweave-secrets \
  --from-literal=JWT_SECRET=your-secret \
  --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  --from-literal=OPENAI_API_KEY=sk-...

# Deploy
kubectl apply -f deploy/kubernetes.yaml
```

The manifest includes a Deployment, Service, PVC for data persistence, and an Ingress.
Edit the host in the Ingress to match your domain.

### Deployment Files Reference

| File | Platform |
|------|----------|
| [`Dockerfile`](Dockerfile) | Any Docker host |
| [`docker-compose.yml`](docker-compose.yml) | Docker Compose |
| [`fly.toml`](fly.toml) | Fly.io |
| [`railway.toml`](railway.toml) | Railway |
| [`render.yaml`](render.yaml) | Render |
| [`Procfile`](Procfile) + [`app.json`](app.json) | Heroku |
| [`vercel.json`](vercel.json) | Vercel |
| [`deploy/azure-container-app.yaml`](deploy/azure-container-app.yaml) | Azure Container Apps |
| [`deploy/aws-apprunner.yaml`](deploy/aws-apprunner.yaml) | AWS App Runner |
| [`deploy/aws-ecs-task.json`](deploy/aws-ecs-task.json) | AWS ECS Fargate |
| [`deploy/gcp-cloudrun.yaml`](deploy/gcp-cloudrun.yaml) | Google Cloud Run |
| [`deploy/digitalocean-app.yaml`](deploy/digitalocean-app.yaml) | DigitalOcean App Platform |
| [`deploy/kubernetes.yaml`](deploy/kubernetes.yaml) | Kubernetes |
| [`deploy/server.ts`](deploy/server.ts) | Production entrypoint (all platforms) |

### CI/CD Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| [`docker.yml`](.github/workflows/docker.yml) | Push to `main` / tags | Builds & pushes Docker image to GHCR (+ Docker Hub) |
| [`deploy-azure.yml`](.github/workflows/deploy-azure.yml) | Manual | Deploys to Azure Container Apps |
| [`deploy-fly.yml`](.github/workflows/deploy-fly.yml) | Push to `main` | Auto-deploys to Fly.io |
| [`deploy-gcp.yml`](.github/workflows/deploy-gcp.yml) | Manual | Deploys to Google Cloud Run |
| [`deploy-aws.yml`](.github/workflows/deploy-aws.yml) | Manual | Deploys to AWS ECS Fargate |

## Versioning — Fabric Releases

weaveIntel uses **Fabric Versioning**: each major release is named after a fabric,
assigned alphabetically from A to Z.

```
<major>.<minor>.<patch>  —  "<Fabric Name>"
```

| Major | Codename | Description |
|------:|----------|-------------|
| 1 | **Aertex** | First stable release |
| 2 | **Batiste** | |
| 3 | **Calico** | |
| 4 | **Damask** | |
| 5 | **Etamine** | |
| 6 | **Flannel** | |
| 7 | **Gauze** | |
| 8 | **Habutai** | |
| 9 | **Intarsia** | |
| 10 | **Jersey** | |
| 11 | **Knit** | |
| 12 | **Linen** | |
| 13 | **Muslin** | |
| 14 | **Nankeen** | |
| 15 | **Organza** | |
| 16 | **Percale** | |
| 17 | **Rinzu** | |
| 18 | **Satin** | |
| 19 | **Taffeta** | |
| 20 | **Ultrasuede** | |
| 21 | **Velvet** | |
| 22 | **Wadmal** | |
| 23 | **Zephyr** | |

> Minor releases (e.g., 1.1.0, 1.2.0) add features under the same fabric.
> Patch releases (e.g., 1.1.1) fix bugs. See [VERSIONING.md](VERSIONING.md) for full details.

**Current Release: v1.0.0 — Aertex**

## Tech Stack

- **TypeScript 5.7+** — strict mode, ESM-first (`"module": "Node16"`)
- **npm workspaces** — monorepo dependency management
- **Turborepo** — parallel builds with dependency-aware caching
- **Vitest** — test runner (configured, ready for test files)
- **Prettier** — code formatting
- **Fabric Versioning** — major releases named after fabrics A→Z ([details](VERSIONING.md))

## License

MIT
