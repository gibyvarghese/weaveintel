# @weaveintel/a2a

Agent-to-Agent (A2A) protocol — remote HTTP-based and in-process communication between agents.

## Usage

### In-Process Bus

```typescript
import { createInternalA2ABus } from '@weaveintel/a2a';

const bus = createInternalA2ABus();

// Register agents
bus.register({
  card: { name: 'summarizer', description: 'Summarizes text', skills: [{ name: 'summarize' }] },
  handler: async (task) => ({ status: 'completed', result: `Summary of: ${task.input}` }),
});

// Discover agents
const agents = bus.discover();

// Send a task
const result = await bus.send('summarizer', { input: 'Long article text...' });
```

### Remote HTTP Client

```typescript
import { createA2AClient } from '@weaveintel/a2a';

const client = createA2AClient({ baseUrl: 'https://remote-agent.example.com' });

const card = await client.discover();
const result = await client.sendTask({ input: 'Translate to French: Hello' });
```
