# @weaveintel/a2a

Agent-to-Agent (A2A) protocol v1.0 — remote HTTP-based and in-process communication between agents.

## Usage

### In-Process Bus

```typescript
import { weaveA2ABus } from '@weaveintel/a2a';
import { weaveContext } from '@weaveintel/core';
import type { A2AServer, A2ATask } from '@weaveintel/core';

const bus = weaveA2ABus();

// Build and register an agent
const summarizerServer: A2AServer = {
  card: {
    name: 'summarizer',
    description: 'Summarises text',
    version: '1.0.0',
    skills: [{ id: 'summarize', name: 'Summarize', description: 'Summarises long text' }],
    capabilities: { streaming: false },
    supportedInterfaces: [{ url: 'http://localhost/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  },
  async handleMessage(_ctx, params): Promise<A2ATask> {
    const text = params.message.parts.map((p) => p.text ?? '').join(' ');
    return {
      id: 'task-1',
      contextId: params.message.contextId ?? 'ctx-1',
      status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
      artifacts: [{ artifactId: 'out', name: 'output', parts: [{ text: `Summary of: ${text}` }] }],
      history: [params.message],
    };
  },
  async start() {},
  async stop() {},
};

bus.register('summarizer', summarizerServer);

// Discover agents
const card = bus.discover('summarizer');  // Returns AgentCard
const all = bus.listAgents();            // Returns AgentCard[]

// Send a task in-process
const ctx = weaveContext({ userId: 'u1' });
const task = await bus.send(ctx, 'summarizer', {
  message: {
    role: 'user',
    parts: [{ text: 'Long article text...' }],
    messageId: 'msg-1',
    contextId: 'ctx-1',
  },
});
console.log(task.artifacts[0]?.parts[0]?.text); // "Summary of: Long article text..."

// Unregister when done
bus.unregister('summarizer');
```

### Remote HTTP Client (JSON-RPC 2.0)

```typescript
import { weaveA2AClient } from '@weaveintel/a2a';
import { weaveContext } from '@weaveintel/core';

const client = weaveA2AClient();
const ctx = weaveContext({ userId: 'u1' });

// Discover remote agent
const card = await client.discover('https://remote-agent.example.com');

const agentUrl = card.supportedInterfaces?.[0]?.url ?? card.url!;

// Send a message (synchronous — awaits full result)
const task = await client.sendMessage(ctx, agentUrl, {
  message: {
    role: 'user',
    parts: [{ text: 'Translate to French: Hello' }],
    messageId: 'msg-1',
    contextId: 'ctx-1',
  },
});
console.log(task.status.state); // 'TASK_STATE_COMPLETED'

// Stream a message (SSE)
for await (const event of client.streamMessage(ctx, agentUrl, {
  message: { role: 'user', parts: [{ text: 'Explain quantum computing' }], messageId: 'msg-2', contextId: 'ctx-1' },
})) {
  if ('artifactUpdate' in event) console.log(event.artifactUpdate.artifact.parts[0]?.text);
  if ('task' in event) console.log('Done:', event.task.status.state);
}

// Get / list / cancel tasks
const retrieved = await client.getTask(ctx, agentUrl, task.id);
const page = await client.listTasks(ctx, agentUrl, { state: 'TASK_STATE_COMPLETED', pageSize: 20 });
await client.cancelTask(ctx, agentUrl, task.id);
```

### Push Notifications

```typescript
import { weaveA2AClient } from '@weaveintel/a2a';
import { weaveContext } from '@weaveintel/core';

const client = weaveA2AClient();
const ctx = weaveContext({ userId: 'u1' });

// Register a webhook for task state changes
const config = await client.createPushConfig(ctx, agentUrl, task.id, {
  url: 'https://my-server.example.com/webhooks/a2a',
  token: 'hmac-signing-secret',
  authentication: { schemes: ['bearer'], credentials: 'my-bearer-token' },
});

// List / get / delete configs
const configs = await client.listPushConfigs(ctx, agentUrl, task.id);
const existing = await client.getPushConfig(ctx, agentUrl, task.id, config.pushConfigId);
await client.deletePushConfig(ctx, agentUrl, task.id, config.pushConfigId);
```

### HTTP Server (JSON-RPC 2.0 dispatcher)

```typescript
import { createA2ADispatcher, createInMemoryA2ATaskStore, createInMemoryPushNotificationStore } from '@weaveintel/a2a';
import type { A2AServer } from '@weaveintel/core';

const myServer: A2AServer = { /* ... */ };
const taskStore = createInMemoryA2ATaskStore();
const pushStore = createInMemoryPushNotificationStore();

const dispatcher = createA2ADispatcher(myServer, taskStore, pushStore);

// Wire into any HTTP framework:
// const result = await dispatcher(ctx, { method: 'POST', body: rawBody, headers });
// if (result.kind === 'json') res.json(result.data);
// else for await (const chunk of streamToSse(result.events)) res.write(chunk);
```

### Agent Card Signing

```typescript
import { signAgentCard, verifyAgentCard, generateCardSigningKeyPair } from '@weaveintel/a2a';

const { privateKey, publicKey } = await generateCardSigningKeyPair();

const signedCard = await signAgentCard(card, privateKey, 'https://keys.example.com/jwks.json');

const result = await verifyAgentCard(signedCard, async (keyId) => {
  // fetch publicKey from JWKS endpoint identified by keyId
  return publicKey;
});
console.log(result.valid); // true
```

### JWT Validation

```typescript
import { createJwtValidator, createJtiCache } from '@weaveintel/a2a';

const jtiCache = createJtiCache(10_000);

const validate = createJwtValidator({
  audience: 'my-agent',
  clockSkewSeconds: 60,
  jtiCache,
  // optional: getPublicKey for signature verification
});

const dispatcher = createA2ADispatcher(myServer, taskStore, pushStore, validate);
```
