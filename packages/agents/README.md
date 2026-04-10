# @weaveintel/agents

Agent runtime — ReAct-style tool-calling loop and hierarchical supervisor-worker orchestration.

## Features

- **Tool-calling agent** — Iterative generate → tool-call → observe loop with budget enforcement
- **Supervisor-worker** — Hierarchical delegation via a built-in `delegate_to_worker` tool
- **Streaming** — Agents can stream intermediate responses
- **Policy enforcement** — Tool policies checked before execution

## Usage

```typescript
import { createToolCallingAgent } from '@weaveintel/agents';

const agent = createToolCallingAgent({
  model,
  tools: toolRegistry,
  systemPrompt: 'You are a helpful assistant with access to tools.',
  maxSteps: 10,
});

const result = await agent.run(
  { messages: [{ role: 'user', content: 'What is the weather in Paris?' }] },
  ctx,
);
```

### Supervisor

```typescript
import { createSupervisor } from '@weaveintel/agents';

const supervisor = createSupervisor({
  model,
  workers: [
    { name: 'researcher', agent: researchAgent, description: 'Searches the web' },
    { name: 'writer', agent: writerAgent, description: 'Writes documents' },
  ],
  systemPrompt: 'You coordinate research and writing tasks.',
});

const result = await supervisor.run(input, ctx);
```
