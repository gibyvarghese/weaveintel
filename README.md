# WeaveIntel

**Protocol-first, capability-driven AI framework for TypeScript.**

WeaveIntel is a modular monorepo that provides composable building blocks for building production-grade AI applications — from simple chat completions to multi-agent orchestration with tool calling, RAG, memory, observability, and inter-agent communication.

## Why WeaveIntel?

- **Protocol-first** — Core defines contracts (interfaces), not implementations. Swap providers without changing application code.
- **Capability-driven** — Models, agents, and tools declare capabilities. The router selects the right model for the job.
- **Zero vendor lock-in** — Core has zero vendor dependencies. Provider packages are thin adapters.
- **Composable middleware** — Intercept any model call with typed middleware for logging, retries, redaction, caching, or custom logic.
- **Production patterns built in** — Fallback chains, budget enforcement, PII redaction, structured output, evaluation suites, and observability from day one.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Your Application                     │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│  agents  │ retrieval│  memory  │   evals  │ observability│
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│                     models (router)                      │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│  openai  │ (anthropic)│ (azure) │mcp-client│  mcp-server │
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│                    core (contracts)                       │
└─────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---|---|
| [`@weaveintel/core`](packages/core) | Contracts, types, context, events, middleware, plugin registry — zero vendor deps |
| [`@weaveintel/models`](packages/models) | Unified model router with fallback chains, streaming, middleware, capability selection |
| [`@weaveintel/provider-openai`](packages/provider-openai) | OpenAI adapter — chat, embeddings, image, audio with auto-capability detection |
| [`@weaveintel/agents`](packages/agents) | Agent runtime — ReAct tool-calling loop, supervisor-worker hierarchies |
| [`@weaveintel/retrieval`](packages/retrieval) | Document chunking (6 strategies), embedding pipeline, vector retrieval with reranking |
| [`@weaveintel/memory`](packages/memory) | Conversation, semantic, and entity memory implementations |
| [`@weaveintel/observability`](packages/observability) | Tracing, spans, cost/token usage tracking |
| [`@weaveintel/redaction`](packages/redaction) | PII detection (email, phone, SSN, CC, etc.), policy engine, reversible tokenization |
| [`@weaveintel/mcp-client`](packages/mcp-client) | MCP protocol client — discover and invoke remote tools, resources, prompts |
| [`@weaveintel/mcp-server`](packages/mcp-server) | MCP protocol server — expose tools, resources, and prompts |
| [`@weaveintel/a2a`](packages/a2a) | Agent-to-agent protocol — remote HTTP + in-process bus for multi-agent systems |
| [`@weaveintel/evals`](packages/evals) | Evaluation runner with 6 assertion types (exact, contains, regex, schema, latency, cost) |
| [`@weaveintel/testing`](packages/testing) | Fake models, embeddings, vector stores, and MCP transports for deterministic tests |

## Quick Start

### Prerequisites

- Node.js >= 20
- npm >= 10

### Install

```bash
git clone https://github.com/gibyvarghese/weaveintel.git
cd weaveintel
cp .env.example .env   # then fill in your API keys
npm install
npm run build
```

### Simple Chat Completion

```typescript
import { createExecutionContext } from '@weaveintel/core';
import { createOpenAIModel } from '@weaveintel/provider-openai';

const ctx = createExecutionContext({ userId: 'demo' });
const model = createOpenAIModel({ apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o-mini' });

const response = await model.generate(ctx, {
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is the capital of France?' },
  ],
});

console.log(response.content); // "Paris"
```

### Model Router with Fallback

```typescript
import { createModel, registerModelProvider } from '@weaveintel/models';
import '@weaveintel/provider-openai'; // auto-registers 'openai' provider

const model = createModel({
  provider: 'openai',
  model: 'gpt-4o',
  fallback: [
    { provider: 'openai', model: 'gpt-4o-mini' },
  ],
  middleware: [modelObservabilityMiddleware(eventBus)],
});
```

### Tool-Calling Agent

```typescript
import { createToolRegistry, defineTool, createExecutionContext } from '@weaveintel/core';
import { createToolCallingAgent } from '@weaveintel/agents';
import { createFakeModel } from '@weaveintel/testing';

const tools = createToolRegistry();

tools.register(defineTool({
  name: 'get_weather',
  description: 'Get weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  execute: async (args) => '22°C, Sunny',
}));

const agent = createToolCallingAgent({
  model,
  tools,
  systemPrompt: 'You are a weather assistant.',
});

const result = await agent.run({ messages: [{ role: 'user', content: 'Weather in Paris?' }] }, ctx);
```

### RAG Pipeline

```typescript
import { createChunker, createEmbeddingPipeline, createVectorRetriever } from '@weaveintel/retrieval';

const chunker = createChunker({ strategy: 'fixed-size', chunkSize: 512, overlap: 50 });
const pipeline = createEmbeddingPipeline({ embeddingModel, vectorStore, chunker });
const retriever = createVectorRetriever({ embeddingModel, vectorStore, topK: 5 });

// Ingest
await pipeline.ingestDocument(document, ctx);

// Retrieve
const results = await retriever.retrieve({ query: 'How does TypeScript handle generics?' }, ctx);
```

### MCP Server

```typescript
import { createMCPServer } from '@weaveintel/mcp-server';

const server = createMCPServer({ name: 'my-tools', version: '1.0.0' });

server.addTool(
  { name: 'greet', description: 'Greet a user', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  async (args) => ({ content: [{ type: 'text', text: `Hello, ${args.name}!` }] }),
);

await server.start(transport);
```

### PII Redaction

```typescript
import { createRedactor } from '@weaveintel/redaction';

const redactor = createRedactor({ patterns: ['email', 'phone', 'ssn', 'credit_card'] });
const result = redactor.redact('Contact john@example.com or 555-123-4567');

console.log(result.redacted);  // "Contact [EMAIL_0] or [PHONE_0]"
console.log(result.restore(result.redacted)); // original text
```

### Evaluation Suite

```typescript
import { createEvalRunner } from '@weaveintel/evals';

const runner = createEvalRunner({ model });

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
```

## Project Structure

```
weaveintel/
├── packages/
│   ├── core/           # Contracts & types (zero deps)
│   ├── models/         # Router, fallback, middleware
│   ├── provider-openai/# OpenAI adapter
│   ├── agents/         # Tool-calling agent, supervisor
│   ├── retrieval/      # Chunking, embedding pipeline, retriever
│   ├── memory/         # Conversation, semantic, entity memory
│   ├── observability/  # Tracer, spans, usage tracking
│   ├── redaction/      # PII detection & policy engine
│   ├── mcp-client/     # MCP protocol client
│   ├── mcp-server/     # MCP protocol server
│   ├── a2a/            # Agent-to-agent communication
│   ├── evals/          # Evaluation runner & assertions
│   └── testing/        # Fakes & test harnesses
├── examples/           # 10 runnable examples
├── turbo.json          # Turborepo config
├── tsconfig.base.json  # Shared TypeScript config
└── package.json        # Workspace root
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

### Adding a New Provider

1. Create `packages/provider-<name>/` with `package.json`, `tsconfig.json`, and `src/index.ts`
2. Implement the `Model` interface from `@weaveintel/core`
3. Call `registerModelProvider('<name>', factory)` from `@weaveintel/models` at import time
4. Optional: call `registerEmbeddingProvider('<name>', factory)` for embedding support

### Core Design Principles

- **Interfaces in core, implementations in leaf packages** — core never imports from providers or runtime packages.
- **Middleware is generic** — `Middleware<T, R>` works for any request/response pair. Compose with `composeMiddleware()`.
- **Everything is capability-gated** — `HasCapabilities` interface + `createCapabilitySet()` let the router and consumers check model abilities at runtime.
- **Context flows everywhere** — `ExecutionContext` carries userId, traceId, budget, deadline, and cancellation signal through every call.

## Examples

The [`examples/`](examples/) directory contains 10 runnable demonstrations:

| # | File | What It Shows |
|---|---|---|
| 01 | [Simple Chat](examples/01-simple-chat.ts) | Basic completion, streaming, structured output |
| 02 | [Tool-Calling Agent](examples/02-tool-calling-agent.ts) | ReAct loop, tool registry, fake model |
| 03 | [RAG Pipeline](examples/03-rag-pipeline.ts) | Chunking, embedding, vector search, retrieval-augmented generation |
| 04 | [Hierarchical Agents](examples/04-hierarchical-agents.ts) | Supervisor-worker delegation |
| 05 | [MCP Integration](examples/05-mcp-integration.ts) | MCP server + client, tool bridge |
| 06 | [A2A Communication](examples/06-a2a-communication.ts) | Agent-to-agent bus, discovery, task delegation |
| 07 | [Memory-Augmented Agent](examples/07-memory-augmented-agent.ts) | Conversation, semantic, and entity memory |
| 08 | [PII Redaction](examples/08-pii-redaction.ts) | Detection, replacement, restoration, policy engine |
| 09 | [Eval Suite](examples/09-eval-suite.ts) | Assertions, scoring, aggregate results |
| 10 | [Observability](examples/10-observability.ts) | Tracing, spans, event bus, usage tracking |

## Tech Stack

- **TypeScript 5.7+** — strict mode, ESM-first (`"module": "Node16"`)
- **npm workspaces** — monorepo dependency management
- **Turborepo** — parallel builds with dependency-aware caching
- **Vitest** — test runner (configured, ready for test files)
- **Prettier** — code formatting
- **Changesets** — versioning and changelog generation

## License

MIT
