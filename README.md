# weaveIntel

**Protocol-first, capability-driven AI framework for TypeScript.**

weaveIntel is a modular monorepo that provides composable building blocks for building production-grade AI applications — from simple chat completions to multi-agent orchestration with tool calling, RAG, memory, observability, and inter-agent communication.

## Why weaveIntel?

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
│  openai  │ anthropic│  (azure) │mcp-client│  mcp-server │
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│                    core (contracts)                       │
└─────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description |
|---|---|
| [`@weaveintel/core`](packages/core) | Contracts, types, context, events, middleware, plugin registry — zero vendor deps |
| [`@weaveintel/models`](packages/models) | Unified model router with fallback chains, streaming, middleware, capability selection |
| [`@weaveintel/provider-openai`](packages/provider-openai) | OpenAI adapter — chat, streaming, embeddings, image, audio, structured output, vision |
| [`@weaveintel/provider-anthropic`](packages/provider-anthropic) | Anthropic adapter — chat, streaming, tool use, extended thinking, vision, token counting, batches, computer use, prompt caching |
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
npm install
npm run build
```

### Environment Variables

Set API keys as needed:

```bash
export OPENAI_API_KEY="sk-..."          # For OpenAI provider
export ANTHROPIC_API_KEY="sk-ant-..."   # For Anthropic provider
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
│   ├── retrieval/          # Chunking, embedding pipeline, retriever
│   ├── memory/             # Conversation, semantic, entity memory
│   ├── observability/      # Tracer, spans, usage tracking
│   ├── redaction/          # PII detection & policy engine
│   ├── mcp-client/         # MCP protocol client
│   ├── mcp-server/         # MCP protocol server
│   ├── a2a/                # Agent-to-agent communication
│   ├── evals/              # Evaluation runner & assertions
│   └── testing/            # Fakes & test harnesses
├── examples/               # 11 runnable examples
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
# No API key needed (uses fake models)
npx tsx examples/02-tool-calling-agent.ts
npx tsx examples/03-rag-pipeline.ts
npx tsx examples/04-hierarchical-agents.ts
npx tsx examples/05-mcp-integration.ts
npx tsx examples/06-a2a-communication.ts
npx tsx examples/07-memory-augmented-agent.ts
npx tsx examples/08-pii-redaction.ts
npx tsx examples/09-eval-suite.ts
npx tsx examples/10-observability.ts

# Requires OPENAI_API_KEY
OPENAI_API_KEY=sk-... npx tsx examples/01-simple-chat.ts

# Requires ANTHROPIC_API_KEY
ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/11-anthropic-provider.ts
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

The [`examples/`](examples/) directory contains 11 runnable demonstrations:

| # | File | What It Shows | API Key |
|---|---|---|---|
| 01 | [Simple Chat](examples/01-simple-chat.ts) | Basic completion, streaming, structured output | OpenAI |
| 02 | [Tool-Calling Agent](examples/02-tool-calling-agent.ts) | ReAct loop, tool registry, fake model | None |
| 03 | [RAG Pipeline](examples/03-rag-pipeline.ts) | Chunking, embedding, vector search, RAG | None |
| 04 | [Hierarchical Agents](examples/04-hierarchical-agents.ts) | Supervisor-worker delegation | None |
| 05 | [MCP Integration](examples/05-mcp-integration.ts) | MCP server + client, tool bridge | None |
| 06 | [A2A Communication](examples/06-a2a-communication.ts) | Agent-to-agent bus, discovery, task delegation | None |
| 07 | [Memory-Augmented Agent](examples/07-memory-augmented-agent.ts) | Conversation, semantic, and entity memory | None |
| 08 | [PII Redaction](examples/08-pii-redaction.ts) | Detection, replacement, restoration, policy engine | None |
| 09 | [Eval Suite](examples/09-eval-suite.ts) | Assertions, scoring, aggregate results | None |
| 10 | [Observability](examples/10-observability.ts) | Tracing, spans, event bus, usage tracking | None |
| 11 | [Anthropic Provider](examples/11-anthropic-provider.ts) | Chat, streaming, tools, thinking, vision, caching, batches, computer use (77 tests) | Anthropic |

## Tech Stack

- **TypeScript 5.7+** — strict mode, ESM-first (`"module": "Node16"`)
- **npm workspaces** — monorepo dependency management
- **Turborepo** — parallel builds with dependency-aware caching
- **Vitest** — test runner (configured, ready for test files)
- **Prettier** — code formatting
- **Changesets** — versioning and changelog generation

## License

MIT
