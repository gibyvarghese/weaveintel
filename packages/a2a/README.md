# @weaveintel/a2a

**Let your agents talk to other agents over the Agent-to-Agent (A2A) protocol — as a client, a server, or both.**

## Why it exists

One agent rarely knows everything. Sometimes the right move is to delegate: hand a task to a specialist agent that lives somewhere else and wait for it to report back. A2A is the shared etiquette for that hand-off — like two colleagues agreeing on how to send a work request, check on its progress, and get notified when it's done. This package speaks that etiquette on both sides: it can hire other agents, and it can turn one of your own agents into a hireable service.

## When to reach for it

Reach for it when agents in *different* processes or services need to delegate tasks to each other. If you just want your agent to call plain tools (not other agents), you don't need this — use a `ToolRegistry` from `@weaveintel/core`. For a single in-process test you can skip HTTP entirely with `weaveA2ABus`.

## How to use it

```ts
import { weaveA2AClient } from '@weaveintel/a2a';
import { weaveContext } from '@weaveintel/core';

const client = weaveA2AClient();
const ctx = weaveContext();

const card = await client.discover('https://agents.example.com/research');
const agentUrl = card.supportedInterfaces?.[0]?.url ?? card.url!;

const task = await client.sendMessage(ctx, agentUrl, {
  message: { role: 'user', parts: [{ text: 'Summarize Q3 sales' }], messageId: 'm1', contextId: 'c1' },
});

console.log(task.status.state);   // e.g. "TASK_STATE_COMPLETED"
```

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveA2AClient()` | Client: `discover`, `sendMessage`, `streamMessage`, `getTask` |
| `weaveAgentAsA2AServer(opts)` | Turn one of your agents into an A2A-serving endpoint |
| `weaveA2ABus()` | In-process client↔server bus (no HTTP) for tests/embedding |
| `createA2ADispatcher`, `weaveA2AServer`, `streamToSse` | JSON-RPC 2.0 server dispatch + SSE streaming |
| `create*A2ATaskStore` / `createSqliteA2ATaskStore` | In-memory, durable, or SQLite task persistence |
| `signAgentCard`, `verifyAgentCard`, `createJwtValidator` | Card signing and JWT auth for trusted agents |
| `createInMemoryPushNotificationStore`, `deliverToWebhook` | Webhook push notifications for task updates |

## License

MIT.
