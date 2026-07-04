# weaveIntel

**A TypeScript framework for building production-grade AI applications.**

weaveIntel gives you composable, vendor-neutral building blocks for everything from a single chat completion to a fleet of long-running multi-agent meshes — with tool calling, governance, observability, and resilience built in. It's **~44 focused packages** you compose like Lego bricks: take only the ones your app needs.

> **New to weaveIntel?** Skip to [Quick Start](#quick-start) for a 5-minute walkthrough, then read [Core Concepts](#core-concepts) to learn the mental model. Not sure which package to install? Jump to [Which package do I need?](#which-package-do-i-need).
> **Renamed a package recently?** The old→new package map lives in [`MIGRATION.md`](./MIGRATION.md). For where the project is headed, see [`ROADMAP.md`](./ROADMAP.md).

---

## Editions & licensing

weaveIntel is **open core**:

- **The library** — everything under [`packages/`](packages/) (the `@weaveintel/*` modules) plus the
  brand-neutral theming engine [`@weaveintel/tokens`](clients/tokens/) — is **MIT-licensed** and
  **published to npm**. `@weaveintel/tokens` is the design-token engine (colours, spacing, typography,
  light/dark, per-tenant white-label) shared by the web and native clients; it carries no product branding,
  so anything you build on it themes cleanly. Use the library in your own projects:
  `npm install @weaveintel/weaveintel` (the umbrella that re-exports the whole toolkit), or install just the
  modules you need. This is the actively-developed, reusable core.
- **The apps** — [`apps/geneweave`](apps/geneweave/) (the geneWeave server) and
  [`apps/geneweave-ui`](apps/geneweave-ui/) (its web client) — are the **open-source community edition** of the
  geneWeave product, MIT-licensed, so you can **self-host today's geneWeave**. They consume the library above.

Everything in this repository is MIT (see [LICENSE](LICENSE)). Ongoing **commercial development of the geneWeave
apps happens separately**; the community edition here remains free to use and self-host.

> **Building on the library?** Depend on the published `@weaveintel/*` packages from npm — not on paths inside
> this repo. Library changes are made here, published, and then consumed downstream by version.

---

## Table of Contents

- [Why weaveIntel](#why-weaveintel)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [Capability Walkthroughs](#capability-walkthroughs)
  - [1. Talk to a model](#1-talk-to-a-model)
  - [2. Add tools (`weaveAgent`)](#2-add-tools-weaveagent)
  - [3. Long-running agents (`weaveLiveAgent`)](#3-long-running-agents-weaveliveagent)
  - [3b. Agent strategy settings](#3b-agent-strategy-settings)
  - [4. Connect to external systems (MCP)](#4-connect-to-external-systems-mcp)
  - [5. Multi-agent communication (A2A)](#5-multi-agent-communication-a2a)
  - [6. Governance: policy, approval, audit, and guardrails](#6-governance-policy-approval-audit-and-guardrails)
  - [7. Resilience: rate limits, circuit breakers, retries](#7-resilience-rate-limits-circuit-breakers-retries)
  - [8. Memory, RAG, and knowledge graphs](#8-memory-rag-and-knowledge-graphs)
  - [9. Observability and replay](#9-observability-and-replay)
  - [10. Evaluation](#10-evaluation)
  - [11. Skills — reusable capability bundles](#11-skills--reusable-capability-bundles)
  - [12. Multi-tenancy and cost governance](#12-multi-tenancy-and-cost-governance)
  - [13. Per-tenant data encryption](#13-per-tenant-data-encryption)
- [The geneWeave Reference App](#the-geneweave-reference-app)
- [Examples](#examples) — full catalog of 110+ runnable demos
- [Which package do I need?](#which-package-do-i-need)
- [Deployment](#deployment)
- [Development](#development)

---

## Why weaveIntel

- **Vendor-neutral core.** `@weaveintel/core` is pure contracts and types — zero vendor SDKs. Provider packages (`provider-openai`, `provider-anthropic`, `provider-google`, `provider-ollama`, `provider-llamacpp`) are thin adapters you can swap. Everything is composed from **~44 focused packages**; install the umbrella `@weaveintel/weaveintel` to get them all, or cherry-pick.
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
| **Tool** | A typed function an agent can call. Has a JSON schema, a risk class, and goes through policy + resilience. | `core`, `tools` (+ its subpaths: `tools/http`, `tools/search`, `tools/time`, …) |
| **Agent** | An LLM-driven loop that picks tools to satisfy a goal. Two flavors: `weaveAgent` (one-shot) and `weaveLiveAgent` (long-running). | `agents`, `live-agents` |
| **Mesh** | A group of live agents that share a state store, schedule, and event bus. Mesh = team. | `live-agents`, `live-agents-runtime` |
| **Policy / Contract** | Declarative rules for what tools can do, when humans approve, and what evidence an agent must produce. The contract + evidence ledger lives in `@weaveintel/core/contracts`. | `tools`, `core/contracts`, `human-tasks` |

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
import { weaveModel } from '@weaveintel/core/models';
import '@weaveintel/provider-openai';
import '@weaveintel/provider-anthropic';

const model = weaveModel({
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  fallback: [{ provider: 'openai', model: 'gpt-4o-mini' }],
});
```

The model router lives in `@weaveintel/core/models`; for capability-based routing across providers (health, weighted scoring, A/B) reach for `@weaveintel/routing`. It tracks endpoint health, applies weighted scoring, and explains every decision.

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
- **Contracts** ([`@weaveintel/core/contracts`](packages/core)) are the immutable evidence ledger.
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

#### Kaggle Competition Mesh

The live-agents system ships a production-ready Kaggle mesh with nine specialist agents: `discoverer`, `strategist`, `implementer`, `parallel_implementer`, `validator`, `submitter`, `observer`, `leaderboard_monitor`, and `debrief`. Three pre-built playbooks wire the right tools and constraints for NLP classification, computer vision, and time-series competitions.

> **Run it:** [`examples/76-kaggle-discover-and-ideate.ts`](examples/76-kaggle-discover-and-ideate.ts), [`examples/79-kaggle-live-agents-e2e.ts`](examples/79-kaggle-live-agents-e2e.ts), [`examples/96-live-agents-phase6-mesh-from-db.ts`](examples/96-live-agents-phase6-mesh-from-db.ts)

---

### 3b. Agent strategy settings

Global and per-tenant defaults for how agents behave are stored in the `agent_strategy_settings` DB table. Set them once; all agents inherit them automatically.

```typescript
const settings = await db.getAgentStrategySettings('global');
settings.hitl_threshold;          // 0.75 — risk score above which HITL approval fires
settings.max_agent_hops;          // 5    — max A2A delegation chain depth
settings.tool_confirmation_level; // 'high-risk-only' — when to confirm tool calls
settings.memory_policy;           // 'session' — cross-turn memory retention scope

// Tighten for a high-stakes deployment
await db.updateAgentStrategySettings('global', { hitl_threshold: 0.85, tool_confirmation_level: 'medium' });
```

Three behaviours are **on by default**: `a2a_enabled`, `reflect_enabled`, and `supervisor_parallel_delegation`. Tenant-scoped rows override global defaults on a per-field basis.

> **Run it:** [`examples/168-agent-strategy-settings.ts`](examples/168-agent-strategy-settings.ts)

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

The [`examples/verticals/statsnz`](examples/verticals/statsnz) vertical ships a complete Stats NZ MCP server you can launch with one call — an unpublished worked example of building a domain server on `@weaveintel/mcp-server`.

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

Each agent publishes an **Agent Card** listing its skills. weaveIntel seeds 15 standard A2A skills covering the main categories of AI work: general chat, supervisor orchestration, ensemble reasoning, computer use, browser automation, code execution, document intelligence, image analysis, image generation, voice interaction, data pipelines, memory retrieval, workflow orchestration, research synthesis, code review, and hypothesis validation.

> **Run it:** [`examples/06-a2a-communication.ts`](examples/06-a2a-communication.ts), [`examples/164-a2a-supervisor.ts`](examples/164-a2a-supervisor.ts) (A2A-native supervisor with task store + streaming)

---

### 6. Governance: policy, approval, audit, and guardrails

Every tool that flows through `createPolicyEnforcedRegistry` is wrapped in a five-step pipeline:

```
enabled check → circuit breaker → risk-level gate → approval gate → rate limit → execute → audit
```

- **Risk levels:** `read-only`, `write`, `destructive`, `privileged`, `financial`, `external-side-effect`.
- **Policies** live in the `tool_policies` DB table. Skills can override per-session.
- **Approval workflow:** tools with `requireApproval: true` create a `tool_approval_requests` row; operators resolve via `/api/admin/tool-approval-requests`.
- **Audit trail:** every invocation persists to `tool_audit_events` with input/output preview, duration, and policy id.
- **Health snapshots:** a background job rolls up success rate, p95 latency, and error rate every 15 minutes into `tool_health_snapshots`.
- **Guardrails (mid-2026 expansion):** the `@weaveintel/guardrails` library now ships 18 additional rules beyond the built-in checks — covering EU AI Act compliance (transparency, human oversight, manipulation detection, bias flagging), AI-generated content detection (watermarks, hallucination, deepfake audio, synthetic media disclosure), agent safety controls (tool scope enforcement, irreversibility gate, PII output redaction, prompt-injection shield, delegation chain limits), and data-residency rules (EU, US-Gov, AU/NZ). All rules are stored in the `guardrail_rules` DB table and can be enabled/disabled per tenant.
- **Prompt-injection spotlighting (`@weaveintel/notes`):** when AI acts on user-authored content, `spotlight()` / `fenceUntrusted()` wrap that content in a per-request, unguessable fence and prefix the system prompt with a "fenced text is data, never instructions" boundary (Microsoft spotlighting / OWASP LLM01). The content can't forge or close its own boundary, so an instruction hidden inside a note is treated as data. weaveNotes applies it to every note AI prompt (rewrite, summarize, restructure, diagram, colour-code), on top of the human-approve-every-change suggestion model.
- **Per-resource audit feed:** weaveNotes records every note action (create / edit / AI-suggestion-accepted / publish / export) to `note_activity` with `actor` (user or ai). The Builder's *weaveNotes → Activity / Audit* tab is a tenant-scoped, keyset-paginated viewer with CSV / JSON / JSONL export (CSV cells are formula-injection-guarded); a retention job prunes rows past the configured horizon. The same feed is what an editor agent reads to understand "what changed" before it acts.
- **Verified character‑level citations (`@weaveintel/notes` rag citations):** "Ask your workspace" answers ground every claim in an exact verbatim quote from a source note, and each quote is *verified to actually appear in that note* before it's shown — invented quotes are dropped (the anti‑hallucination control; the "Anthropic‑style citations with any LLM" pattern). `buildCitedAnswerPrompt` instructs verbatim quoting; `parseCitedAnswer` + `verifyCitations` locate each quote's char span via an exact→whitespace/case‑normalized→ellipsis cascade and keep only the verifiable ones. The UI renders the answer with clickable `[n]` chips and a Verified‑sources list; clicking opens the source note and highlights the exact line (CSS Custom Highlight API, anchored by quote text so it survives edits). Builder‑governed (`weavenotes_settings.citations_enabled`, `citation_max_sources`, m122).
- **Verified AI visuals (`@weaveintel/notes` visual‑verify):** AI visuals are *checked before they're shown*, not hopeful. A **diagram** is scored by an LLM‑as‑judge against the request (semantic node/edge F1 + direction + intent‑fit → a 0–1 `overall`); below the Builder‑set threshold it's redrawn with the judge's missing/extra deltas (max retries, early‑stop) — the suggestion carries the score ("… · fit 91%"). A **found image** is vision‑verified: a VLM describes‑then‑judges whether it actually depicts the subject (+ quality + safety) with a calibrated confidence; below threshold it tries the next candidate, and inserts nothing rather than a wrong image. Both reuse the existing model router (multimodal `ImageContent`); all dials live in `weavenotes_settings` (m121). The pure prompt/parse/score helpers (`buildDiagramJudge`/`parseDiagramVerdict`/`buildImageVerify`/`parseImageVerdict`/`imageAccept`) are zero‑dependency and unit‑tested.

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
| `@weaveintel/tools/http` direct REST tools | per tool |
| MCP gateway (geneweave hosting MCP) — both tenancy paths | `tool:<toolName>` |
| Live-agent tick tool calls | `tool:<toolName>` with `fail-fast` overrides so the supervisor defers next pass |
| Generic supervisor | reads `endpoint_health` before scheduling; emits `endpoint_circuit_open` / `endpoint_rate_limited` to `live_run_events` |

Apps subscribe to the signal bus to react (pause an endpoint, defer an agent, fall back to a cheaper model). See [`docs/RESILIENCE_PLAN.md`](docs/RESILIENCE_PLAN.md) for the full design.

#### Per-subject rate limiting (`createKeyedRateLimiter`)

The endpoint buckets above are *process-wide*. When you need **one bucket per subject** — per user, per tenant, per API key — use `createKeyedRateLimiter`. It wraps the same token bucket in an LRU-bounded map, so a single user exhausting their quota never blocks anyone else, and memory can't grow without bound.

```typescript
import { createKeyedRateLimiter } from '@weaveintel/resilience';

// e.g. "each user may run at most 30 AI note actions per minute"
const aiLimiter = createKeyedRateLimiter({ ratePerWindow: 30, windowMs: 60_000 });

const decision = aiLimiter.check(userId);
if (!decision.allowed) {
  res.writeHead(429, { 'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)) });
  res.end(JSON.stringify({ error: 'rate limited', retryAfterMs: decision.retryAfterMs }));
  return;
}
```

geneWeave uses this to cap per-user AI spend on every weaveNotes `/ai/*` endpoint (the limit is a Builder setting, `weaveNotes Settings → Max AI actions per person, per minute`). It's process-local (perfect for one node); for multi-node, back the same `KeyedRateLimiter` interface with Redis — call sites don't change.

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
import { weaveKnowledgeGraph } from '@weaveintel/memory';

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
import { weaveReplay } from '@weaveintel/observability/replay';

await weaveReplay(traceId, { mockTools: true });
```

> **Run it:** [`examples/10-observability.ts`](examples/10-observability.ts), [`examples/78-kaggle-replay-roundtrip.ts`](examples/78-kaggle-replay-roundtrip.ts)

---

### 10. Evaluation

```typescript
import { weaveEvalRunner } from '@weaveintel/testing/evals';

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

### 11. Skills — reusable capability bundles

A **skill** is a pre-configured behavior pack: a name, a set of tool-policy keys, and a prompt injection. When a skill is activated in a session every tool call automatically runs under the correct policy — no per-call wiring needed.

```typescript
import { createSkillRegistry, activateSkills, collectSkillTools } from '@weaveintel/skills';

const registry = createSkillRegistry();
registry.register({
  id: 'web-researcher',
  name: 'Web Researcher',
  toolPolicyKeys: ['web_search', 'browser_fetch'],
  promptInjection: 'You have access to web search and browser tools.',
  version: '1.0.0',
});

// Activate for a session — returns the bound tool-policy keys
const active = activateSkills(registry, ['web-researcher']);
// Collect the tool definitions the skill exposes (ready for weaveAgent)
const tools = collectSkillTools(active);
```

Skills compose: activate multiple skills to union their tool sets. Skills can also be loaded from the DB so product managers define capabilities without code deploys.

> **Run it:** [`examples/36-skills-in-memory-e2e.ts`](examples/36-skills-in-memory-e2e.ts), [`examples/35-skill-activation-e2e.ts`](examples/35-skill-activation-e2e.ts), [`examples/34-skill-tool-policy-approval.ts`](examples/34-skill-tool-policy-approval.ts), [`examples/37-skills-with-real-llm.ts`](examples/37-skills-with-real-llm.ts), [`examples/119-sqlite-e2e.ts`](examples/119-sqlite-e2e.ts) (SQLite-backed skills), [`examples/packages/`](examples/packages/) → `sqlite-e2e.ts`

---

### 12. Multi-tenancy and cost governance

`@weaveintel/identity/tenancy` provides a four-layer config stack, feature entitlements, and budget enforcement. `@weaveintel/cost-governor` tracks every token and dollar at the lever level (model, tool, RAG, reasoning, cache).

```typescript
import {
  createConfigResolver, createOverrideLayer,
  createGlobalScope, createTenantScope,
  createEntitlementStore, createEntitlementPolicy,
  createBudgetEnforcer,
} from '@weaveintel/identity/tenancy';
import { createInMemoryCostLedger, computeUsd } from '@weaveintel/cost-governor';

// 4-layer config: global defaults → org → tenant → user (later layers win)
const config = createConfigResolver();
config.addLayer(createOverrideLayer(createGlobalScope(), { model: 'claude-haiku-4-5-20251001' }));
config.addLayer(createOverrideLayer(createTenantScope('enterprise-corp'), { model: 'claude-opus-4-7' }));

const effectiveModel = config.resolve('model', createTenantScope('enterprise-corp'));
// → 'claude-opus-4-7'

// Feature gating — which tier can use which capabilities
const ents = createEntitlementStore();
ents.set({ tenantId: 'starter-corp', features: new Set(['chat']), allowedModels: ['claude-haiku-4-5-20251001'] });

// Budget enforcement — daily/monthly ceilings per tenant
const budgets = createBudgetEnforcer();
budgets.setBudget({
  tenantId: 'starter-corp',
  daily:   { maxTokens: 100_000, maxCostUsd: 1.00, maxSteps: 1000, maxRuns: 100 },
  monthly: { maxTokens: 3_000_000, maxCostUsd: 30.00, maxSteps: 30_000, maxRuns: 3_000 },
});

const check = budgets.checkBudget('starter-corp');  // { allowed: true, ... }
budgets.recordUsage('starter-corp', tokens, costUsd, steps);

// Cost ledger — per-run spend breakdown
const ledger = createInMemoryCostLedger();
await ledger.record({ runId: 'run-001', source: 'model', lever: 'model', subject: 'claude-opus-4-7', costUsd, ... });
const breakdown = await ledger.breakdown('run-001');
// → { totalUsd, byLever: { model, tool, rag, … }, byModel, tokens }
```

> **Run it:** [`examples/112-tenancy.ts`](examples/112-tenancy.ts), [`examples/103-cost-policy-binding.ts`](examples/103-cost-policy-binding.ts), [`examples/108-budget-governor.ts`](examples/108-budget-governor.ts), [`examples/use-cases/multi-tenant-saas.ts`](examples/use-cases/multi-tenant-saas.ts) (end-to-end tenancy + encryption + cost pipeline)

---

### 13. Per-tenant data encryption

`@weaveintel/encryption` gives every tenant its own AES-256-GCM key hierarchy. A compromised database dump is unreadable without the master key.

```
Root master key (env / KMS)
  └─ KEK per tenant   (Key Encryption Key, wrapped under master)
       └─ DEK per tenant  (Data Encryption Key, wrapped under KEK)
              └─ Encrypts individual field values
```

```typescript
import { LocalKmsProvider, weaveTenantKeyManager, DEFAULT_FIELD_POLICY,
         maybeEncryptField, maybeDecryptField } from '@weaveintel/encryption';

// LocalKmsProvider uses a 32-byte in-process key.
// Swap for AwsKmsProvider / GcpKmsProvider / AzureKeyVaultProvider in production.
const kms = new LocalKmsProvider({ masterKey: Buffer.from(process.env.WEAVE_ENCRYPTION_MASTER_KEY!, 'hex') });

const km = weaveTenantKeyManager({ kms, store: encryptionStore, audit: auditEmitter });
await km.bootstrapTenant({ tenantId: 'acme-corp', enable: true });

// Encrypt on write — only columns in the field policy are encrypted
const encrypted = await maybeEncryptField(
  { manager: km, tenantId: 'acme-corp', enabled: true, policy: DEFAULT_FIELD_POLICY },
  { table: 'messages', column: 'content', rowId: 'msg-001' },
  'Hello Alice, your SSN is 123-45-6789',
);
// → 'enc:v1:1:<iv>:<ciphertext>'

// Decrypt on read — plaintext rows pass through unchanged (lazy migration)
const plaintext = await maybeDecryptField(state, { table: 'messages', column: 'content', rowId: 'msg-001' }, encrypted);
```

Key features: DEK rotation (old ciphertext stays readable), blind indexes for exact-match lookups on encrypted columns, GDPR hard-shred via key deletion, audit log for every key lifecycle event, and `createDatabaseProxy()` for transparent adapter-level encryption without changing query code.

In geneWeave, field-level encryption is activated when `WEAVE_ENCRYPTION_MASTER_KEY` is set. All `messages.content`, `users.email`, and a dozen other PII columns are encrypted transparently. Existing deployments migrate lazily — plaintext rows are re-encrypted on next write.

> **Run it:** [`examples/packages/encryption.ts`](examples/packages/encryption.ts) (complete package walkthrough), [`examples/use-cases/multi-tenant-saas.ts`](examples/use-cases/multi-tenant-saas.ts) (encryption wired into tenant request pipeline)

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
- **Live agents** — generic supervisor + Kaggle competition mesh (9 agents, 3 playbooks for NLP/Vision/TimeSeries) demonstrating long-running mesh execution.
- **Agent strategy settings** — global and per-tenant defaults (HITL threshold, max agent hops, tool confirmation level, memory policy) readable and writable via the DB adapter.
- **Responsive, brandable UI** — the web app (`apps/geneweave-ui`, vanilla-TS, no framework) is built to high-fidelity design references and adapts to web / tablet / mobile (persistent side rails on desktop become slide-over drawers below 900px, keyboard- and screen-reader-friendly). All colours flow from the app's own brand (`apps/geneweave-ui/src/brand/`) composed on the brand-neutral `@weaveintel/tokens` engine — the single source of truth shared with the native app — so light/dark and per-tenant white-label branding apply everywhere. The **Account** screen (profile, preferences, a per-event in-app/email/push notification matrix) is DB-backed per user and also editable by the assistant via the `update_account_profile` tool (scoped to the signed-in user); the **Builder** is a schema-driven three-pane admin over the whole platform; **Appearance & branding** is a per-tenant white-label surface (`set_workspace_appearance`, WCAG-AA-enforced).

Run it locally with [`scripts/start-geneweave.sh`](scripts/start-geneweave.sh) (see [Quick Start](#quick-start)).

The full local DB is `./geneweave.db`. Reset with `rm geneweave.db` and restart — schema and seeds are recreated.

---

## Examples

170+ runnable demos under [`examples/`](examples). See [`examples/README.md`](examples/README.md) for the full index organized by tier.

### Example tiers

| Folder | Purpose | API key |
|---|---|---|
| [`examples/packages/`](examples/packages/) | One file per `@weaveintel/*` package — in-memory, no LLM | none |
| [`examples/use-cases/`](examples/use-cases/) | Multi-package scenarios wired around a realistic problem | none |
| [`examples/with-llm/`](examples/with-llm/) | Full-stack with a real LLM provider | required |
| `examples/*.ts` (flat) | Legacy numbered files — all still runnable | varies |

Run any file with `npx tsx examples/<path>/<file>.ts`.

### Package showcase (`examples/packages/`)

| File | Package | What it demonstrates |
|---|---|---|
| [`encryption.ts`](examples/packages/encryption.ts) | `@weaveintel/encryption` | LocalKmsProvider, key hierarchy, AEAD envelope, field-level encryption, blind index, DEK rotation, hard shred |
| `resilience.ts` | `@weaveintel/resilience` | Token bucket, circuit breaker, retry, concurrency limiter, endpoint registry |
| `tenancy.ts` | `@weaveintel/identity/tenancy` | Config override layers, entitlement gating, budget enforcement |
| `extraction.ts` | `@weaveintel/extraction` | Document transform pipeline, metadata/entity/code/task stages |
| `artifacts.ts` | `@weaveintel/artifacts` | Artifact CRUD, versioning, policy validation, reference resolution |
| `collaboration.ts` | `@weaveintel/collab` | Shared sessions, collaboration events, handoff lifecycle |
| `plugins.ts` | `@weaveintel/core/plugins` | Manifest validation, registry, lifecycle hooks, installer |
| `tools-time.ts` | `@weaveintel/tools/time` | Time snapshot, formatting, timer/stopwatch, tool schemas |
| `sqlite-e2e.ts` | `@weaveintel/skills` + `@weaveintel/memory` | SQLite-backed skills + memory (custom adapter pattern) |

### Use-case examples (`examples/use-cases/`)

| File | Scenario | Packages |
|---|---|---|
| [`multi-tenant-saas.ts`](examples/use-cases/multi-tenant-saas.ts) | Feature gating, budget enforcement, PII encryption, cost tracking | tenancy · encryption · cost-governor |
| [`research-assistant.ts`](examples/use-cases/research-assistant.ts) | Task-aware routing, resilient LLM calls, artifact storage | routing · resilience · artifacts |

### Numbered flat examples

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
| 32 | [Admin capability E2E](examples/32-phase9-admin-capability-e2e.ts) | DB-driven admin schema → chat | none |
| 33 | [Tool simulation harness](examples/33-tool-simulation-harness.ts) | Dry-run with full policy trace | none |
| 34 | [Skill→policy + approval](examples/34-skill-tool-policy-approval.ts) | Skill closure + approval queue | none |
| 35 | [Scientific validation E2E](examples/35-scientific-validation.ts) | Submit → stream → verdict → bundle | none |
| 35b | [Skill activation E2E](examples/35-skill-activation-e2e.ts) | End-to-end skill flow | none |
| 36 | [Skills in memory E2E](examples/36-skills-in-memory-e2e.ts) | In-memory skill orchestration | none |
| 37 | [Skills with real LLM](examples/37-skills-with-real-llm.ts) | Skills + live model | OpenAI/Anthropic |
| 38 | [Kaggle MCP read-only](examples/38-kaggle-mcp-readonly.ts) | Kaggle MCP discovery | none |
| 39 | [Kaggle write + validate](examples/39-kaggle-write-and-validate.ts) | Kaggle submission flow | none |
| 39b–51 | Live-agents buildup | Iterative buildup of the live-agents framework | none |
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
| 62 | [Obs/replay/eval E2E](examples/62-phase7-observability-replay-eval-persistence-e2e.ts) | Cross-cutting observability | none |
| 63 | [Reliability E2E](examples/63-phase8-persistence-performance-reliability-e2e.ts) | Performance + reliability | none |
| 64 | [Release validator](examples/64-phase9-persistence-release-e2e.ts) | Full release scenario sweep | none |
| 65 | [MCP streamable HTTP stateless](examples/65-mcp-streamable-http-stateless.ts) | New MCP transport | none |
| 66 | [MCP progressive discovery](examples/66-mcp-progressive-discovery-compose-stream.ts) | Compose multiple MCP servers | none |
| 67 | [Live agents + MCP resumable](examples/67-live-agents-mcp-resumable-progress.ts) | Resumable progress over MCP | none |
| 68 | [Routed attention research](examples/68-live-agents-routed-attention-research-topics.ts) | Attention policies | none |
| 69 | [MCP gateway token rotation](examples/69-mcp-gateway-token-expiry-rotation.ts) | Credential rotation | none |
| 70 | [Task-aware routing](examples/70-task-aware-routing.ts) | Capability matrix routing | none |
| 71 | [Tool schema translation](examples/71-tool-schema-translation.ts) | Mid-conversation provider swap | none |
| 72 | [Routing admin](examples/72-routing-admin-phase4.ts) | Admin CRUD for routing | none |
| 73 | [Routing feedback](examples/73-routing-feedback-phase5.ts) | Feedback loop into routing | none |
| 74 | [Routing in production](examples/74-routing-phase6-production.ts) | Cache, circuit breaker, A/B, cost-by-task | none |
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
| 95 | [Kaggle-style routing](examples/95-live-agents-phase5-kaggle-style-routing.ts) | Production routing pattern | none |
| 96 | [`weaveLiveMeshFromDb`](examples/96-live-agents-phase6-mesh-from-db.ts) | One-call DB mesh hydration | none |
| 99 | [DB-driven triggers](examples/99-db-driven-triggers.ts) | Unified trigger dispatcher (manual / cron / webhook → workflow / webhook_out) | none |
| 100 | [Mesh ↔ workflow binding](examples/100-mesh-workflow-binding.ts) | Workflow `outputContract` → contract bus → trigger → downstream workflow cascade | none |
| 101 | [Workflow governance](examples/101-workflow-governance.ts) | Input validation + cost ceiling + replay determinism + capability policy precedence | none |
| 102 | [Capability packs](examples/102-capability-packs.ts) | Versioned, exportable bundles of DB rows — manifest validation, install/uninstall via ledger | none |
| 103 | [Cost policy binding](examples/103-cost-policy-binding.ts) | `@weaveintel/cost-governor` — DB-driven cost policy resolution | none |
| 104 | [Prompt caching](examples/104-prompt-caching.ts) | Cost governor — prompt-caching lever (OpenAI + Anthropic stub models) | none |
| 105 | [Model cascade](examples/105-model-cascade.ts) | Cost governor L1 lever — cascade to cheaper model on failure / budget pressure | none |
| 106 | [Tool subset](examples/106-tool-subset.ts) | Cost governor L3 lever — dynamic tool subset based on run context | none |
| 107 | [Intel-gated prompt sections](examples/107-intel-history.ts) | Cost governor L4 lever — include/exclude prompt sections by intel score | none |
| 108 | [Budget governor](examples/108-budget-governor.ts) | Cost governor — max steps, reasoning effort, tool-output truncation, budget gate | none |
| 109 | [Intent-RAG tool retrieval](examples/109-intent-rag-tool-retrieval.ts) | Cost governor — semantic intent-RAG to auto-select the right tool subset | none |
| 110 | [Live-agents trace tools](examples/110-live-agents-trace-tools.ts) | `@weaveintel/live-agents/trace-tools` — lazy trace retrieval and injection into agent context | none |
| 111 | [Resilience patterns](examples/111-resilience.ts) | `@weaveintel/resilience` — token bucket, circuit breaker, retry, concurrency, endpoint registry, signal bus | none |
| 112 | [Tenancy](examples/112-tenancy.ts) | `@weaveintel/identity/tenancy` — 4-layer config override, entitlement gating, capability maps, budget enforcement | none |
| 113 | [Document extraction](examples/113-extraction-pipeline.ts) | `@weaveintel/extraction` — transform pipeline with metadata / entity / code / task stages | none |
| 114 | [Artifact lifecycle](examples/114-artifacts.ts) | `@weaveintel/artifacts` — create, version, store, policy validate, reference resolve | none |
| 115 | [Collaboration](examples/115-collaboration.ts) | `@weaveintel/collab` — shared sessions, events, run subscriptions, handoff lifecycle | none |
| 116 | [Plugins](examples/116-plugins.ts) | `@weaveintel/core/plugins` — manifest validation, registry, lifecycle hooks, compatibility, installer | none |
| 117 | [Tools-time](examples/117-tools-time.ts) | `@weaveintel/tools/time` — time snapshot, formatting, timer/stopwatch state machines, tool schemas | none |
| 119 | [SQLite E2E](examples/119-sqlite-e2e.ts) | SQLite-backed conversation persistence + `@weaveintel/skills` + `@weaveintel/memory` | none |
| 120–167 | Live-agents, A2A, checkpoints, cost-governor, compliance, vision | Feature examples covering A2A supervisor, eval pipelines, dynamic workers, compliance tools, vision loops | none |
| 168 | [Agent strategy settings](examples/168-agent-strategy-settings.ts) | Read, patch, and interpret the global/tenant `agent_strategy_settings` row (hitl_threshold, max_agent_hops, tool_confirmation_level, memory_policy) | none |

> **All examples runnable from a fresh clone** after `npm install && npm run build`. Examples that need an API key say so in the table.

---

## Which package do I need?

weaveIntel is **~44 focused packages**. You don't install all of them — you pick the ones your goal calls for. Start with the umbrella, then reach for the rest as you go. Renamed something? The old→new map is in [`MIGRATION.md`](./MIGRATION.md).

### Start here

| Package | Reach for it when… |
|---|---|
| [`@weaveintel/weaveintel`](packages/weaveintel) | You just want to start — the umbrella that re-exports the whole toolkit. `npm install @weaveintel/weaveintel` first, then cherry-pick individual packages later if you want a smaller footprint. |

### Build an agent

| Package | Reach for it when… |
|---|---|
| [`@weaveintel/core`](packages/core) | Always — the vendor-neutral heart: contexts, tools, types. Its subpaths hold the model router (`core/models`), completion contracts (`core/contracts`), plugin lifecycle (`core/plugins`), capability packs (`core/capability-packs`), and i18n (`core/i18n`). |
| [`@weaveintel/agents`](packages/agents) | You want `weaveAgent` — the one-shot ReAct loop and supervisor→worker hierarchies. |
| [`@weaveintel/provider-openai`](packages/provider-openai) | You're calling OpenAI models. |
| [`@weaveintel/provider-anthropic`](packages/provider-anthropic) | You're calling Anthropic/Claude (chat, streaming, tools, thinking, vision, batches, computer use). |
| [`@weaveintel/provider-google`](packages/provider-google) | You're calling Google Gemini (2.0 / 2.5 series). |
| [`@weaveintel/provider-ollama`](packages/provider-ollama) | You're running local LLMs via Ollama. |
| [`@weaveintel/provider-llamacpp`](packages/provider-llamacpp) | You're running local GGUF models via a llama.cpp HTTP server. |
| [`@weaveintel/routing`](packages/routing) | You want to route between models by capability — health tracking, weighted scoring, A/B, automatic fallback. |
| [`@weaveintel/prompts`](packages/prompts) | You need versioned prompt templates, fragments, frameworks, lint, strategies, and output contracts. |

### Add tools & connect

| Package | Reach for it when… |
|---|---|
| [`@weaveintel/tools`](packages/tools) | You want the policy-enforced tool registry (enabled / circuit / risk / approval / rate-limit / audit) — plus its bundled tool subpaths: `tools/http` (REST), `tools/search` (web search), `tools/time` (datetime/timers), `tools/gmail`, `tools/slack`, `tools/webhook`, `tools/filewatch`, `tools/marketdata`, `tools/news`, and more. |
| [`@weaveintel/tools-browser`](packages/tools-browser) | You need URL fetch, content extraction, and a real browser pool. |
| [`@weaveintel/tools-enterprise`](packages/tools-enterprise) | You need Jira, ServiceNow, Canva, Confluence, Salesforce, or Notion integrations. |
| [`@weaveintel/mcp-client`](packages/mcp-client) | You want to consume someone else's MCP server. |
| [`@weaveintel/mcp-server`](packages/mcp-server) | You want to expose your own tools/resources/prompts as an MCP server. |
| [`@weaveintel/a2a`](packages/a2a) | You want agents to discover each other and delegate work over an agent-to-agent bus (in-process or HTTP). |

### Go multiplayer / collaborate

| Package | Reach for it when… |
|---|---|
| [`@weaveintel/collab`](packages/collab) | You need real-time co-editing, shared sessions, live presence/cursors, and human↔agent handoff (the merged co-edit + collaboration package). |

### Run long-lived / autonomous work

| Package | Reach for it when… |
|---|---|
| [`@weaveintel/live-agents`](packages/live-agents) | You need `weaveLiveAgent` / `weaveLiveMesh` — agents that run for hours/days, accumulate state, file contracts, and coordinate in a mesh across six state-store backends. (Mesh inspection lives at `live-agents/trace-tools`.) |
| [`@weaveintel/live-agents-runtime`](packages/live-agents-runtime) | You want to hydrate meshes/agents straight from DB rows with `weaveLiveMeshFromDb`. |
| [`@weaveintel/workflows`](packages/workflows) | You need a deterministic multi-step engine with branching, checkpoints, and compensation. |
| [`@weaveintel/triggers`](packages/triggers) | You want manual / cron / webhook / signal-bus events to fire workflows, agents, or outbound webhooks — see its [README](packages/triggers/README.md). |
| [`@weaveintel/skills`](packages/skills) | You want reusable capability bundles: registry, activation, per-session tool scoping. |
| [`@weaveintel/human-tasks`](packages/human-tasks) | You need approval, review, escalation, and decision logging in the loop. |

### Knowledge & memory

| Package | Reach for it when… |
|---|---|
| [`@weaveintel/memory`](packages/memory) | You want conversation / semantic / entity memory — and knowledge-graph entity linking (folded in here). |
| [`@weaveintel/retrieval`](packages/retrieval) | You're building RAG: chunking (6 strategies), embedding pipeline, hybrid retrieval, reranking. |
| [`@weaveintel/cache`](packages/cache) | You want a semantic cache with TTL + LRU to avoid re-answering the same question. |
| [`@weaveintel/notes`](packages/notes) | You're building the note/document layer — cited answers, AI visuals, spotlighting, study cards (powers weaveNotes). |
| [`@weaveintel/extraction`](packages/extraction) | You need to pull entities / metadata / tables / code / tasks out of documents. |
| [`@weaveintel/artifacts`](packages/artifacts) | You need versioned blob storage for generated files/outputs. |

### Harden for production

| Package | Reach for it when… |
|---|---|
| [`@weaveintel/guardrails`](packages/guardrails) | You want runtime safety rules: risk classification, cost guards, EU AI Act / content-detection / agent-safety policies — plus PII/redaction (`guardrails/redaction`) and retention/GDPR/legal-hold compliance (`guardrails/compliance`). |
| [`@weaveintel/resilience`](packages/resilience) | You need the shared outbound pipeline: rate-limit + circuit breaker + retry-with-backoff + signal bus (also covers idempotency, DLQ, backpressure). |
| [`@weaveintel/encryption`](packages/encryption) | You need per-tenant AES-256-GCM field encryption: KMS, DEK rotation, blind indexes, GDPR hard-shred. |
| [`@weaveintel/identity`](packages/identity) | You need personas / ACL / deny-by-default RBAC — plus multi-tenancy (`identity/tenancy`), OAuth (`identity/oauth`), and scope (`identity/scope`). |
| [`@weaveintel/cost-governor`](packages/cost-governor) | You want to track and cap spend per token/dollar at the lever level (model, cache, prompt, tool, RAG). |
| [`@weaveintel/observability`](packages/observability) | You want tracer / spans / event bus / cost-usage tracking — and full-run replay (`observability/replay`). |
| [`@weaveintel/sandbox`](packages/sandbox) | You need to run untrusted code in a sandboxed / container executor. |

### Ship to users (UI / clients)

| Package | Reach for it when… |
|---|---|
| [`@weaveintel/client`](packages/client) | You want the front-end client runtime for a weaveIntel app. |
| [`@weaveintel/api-client`](clients/api-client) | You want a typed API client to talk to a weaveIntel/geneWeave server. |
| [`@weaveintel/ui-primitives`](packages/ui-primitives) | You want streaming events + ready widgets (table, chart, form, code, timeline). |
| [`@weaveintel/a11y`](packages/a11y) | You want accessibility helpers (WCAG-aware) for your UI. |
| [`@weaveintel/tokens`](clients/tokens) | You want the brand-neutral theming engine — the design-token source of truth (colours, spacing, typography, light/dark, per-tenant white-label) shared by web and native. |
| [`@weaveintel/voice`](packages/voice) | You need speech-to-text / text-to-speech (Whisper stack, meeting capture). |
| [`@weaveintel/notifications`](packages/notifications) | You need in-app / email / push notification delivery. |

### Test & tooling

| Package | Reach for it when… |
|---|---|
| [`@weaveintel/testing`](packages/testing) | You want fakes (models / embeddings / vector stores / MCP transports) — and the eval runner with 6 assertion types (`testing/evals`). |
| [`@weaveintel/devtools`](packages/devtools) | You want scaffolding, inspection, and mocks for building on the framework. |
| [`@weaveintel/persistence`](packages/persistence) | You need the persistence platform (SQLite / Postgres / Redis / Mongo / DynamoDB). |

> **Apps (not published as library packages):** [`apps/geneweave`](apps/geneweave) (the reference full-stack app) and [`apps/live-agents-demo`](apps/live-agents-demo) (live-agents HTTP API + UI). Domain examples like the Stats NZ MCP server, equity-scoring, and social-growth live as unpublished worked examples under [`examples/verticals/`](examples/verticals).

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
| `WEAVE_ENCRYPTION_MASTER_KEY` | no | 64-char hex master key — enables per-tenant PII field encryption (AES-256-GCM) |
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
4. Register at import time: `weaveRegisterModel('<name>', factory)` from `@weaveintel/core/models`.
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

## Further reading

- [`MIGRATION.md`](./MIGRATION.md) — the old→new package map from the ~87→~44 package consolidation. Start here if an import stopped resolving.
- [`ROADMAP.md`](./ROADMAP.md) — forward-looking plans only (this README describes the current state).
- [`VERSIONING.md`](./VERSIONING.md) — Fabric Versioning scheme and release history.
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to build, test, and contribute.

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
