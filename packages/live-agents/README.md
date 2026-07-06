# @weaveintel/live-agents

**Persistent, long-lived agents that live in a mesh, watch a mailbox, and wake up to act on their own schedule.**

## Why it exists

Most agents answer one question and disappear. But some jobs never end: a support agent that watches an inbox all day, a monitor that checks a dashboard every ten minutes, a coordinator that hands work between teammates. Those agents need a mailbox, a heartbeat, a budget, and a memory that survives restarts. Think of the difference between a phone call and a colleague who shows up every morning, reads their email, does the work within their remit, and knows to escalate when something's over their head. This package is the framework for that colleague. A key rule keeps it safe: **agents are not security principals — accounts are.** An agent only ever acts *as* an account (a Gmail inbox, a Slack channel) through a narrowly-scoped binding that a *human* granted.

## When to reach for it

Reach for `@weaveintel/live-agents` when the agent must outlive a single request — react to events, run on a cron, sit in a mesh and message other agents. If you only need one goal answered in one process and then you're done, use `@weaveintel/agents` instead (this package is built on top of it). If your agent definitions, meshes, and tool bindings live in database rows and you want them hydrated with one call, layer `@weaveintel/live-agents-runtime` on top.

## How to use it

```ts
import { weaveLiveAgent, weaveInMemoryStateStore, createHeartbeat, createActionExecutor } from '@weaveintel/live-agents';
import { weaveContext } from '@weaveintel/core';

// Define a persistent agent (parity with weaveAgent, but tick-driven).
const { handler } = weaveLiveAgent({
  name: 'support',
  model,                                       // any @weaveintel/core Model
  systemPrompt: 'You are a helpful support agent.',
});

// A heartbeat processes the agent's mailbox one batch at a time.
const stateStore = weaveInMemoryStateStore();
const heartbeat = createHeartbeat({
  stateStore,
  workerId: 'worker-1',
  concurrency: 4,
  actionExecutor: createActionExecutor(),
});

const result = await heartbeat.tick(weaveContext({ userId: 'human:ops' }));
console.log(`Processed ${result.processed} ticks`);
```

Run-scoped trace tools (read-only run timeline, failed attempts, recent events) live under the `/trace-tools` subpath:

```ts
import { createLiveTraceTools } from '@weaveintel/live-agents/trace-tools';
```

## What's in the box

| Export | What it does |
|---|---|
| `weaveLiveAgent` | The canonical constructor for a persistent agent (prefer over `createAgenticTaskHandler`). |
| `createLiveAgentsRuntime` | Wires the whole runtime — heartbeat, compression, event handling. |
| `createHeartbeat` | Claims and processes agent ticks (the "pulse" that drives everything). |
| `createActionExecutor` | Executes the action an agent's attention policy chose. |
| `createStandardAttentionPolicy` / `createCronAttentionPolicy` / `createModelAttentionPolicy` | How an agent picks its next action — heuristic, scheduled, or LLM-driven. |
| `weaveModelResolver`, `composeModelResolvers` | Resolve which model to use per tick. |
| `weaveLiveAgentPolicy` | Bundle tool-approval, rate-limit, and audit into one policy slot. |
| `runLiveReactLoop`, `BudgetExhausted` | The budget-bounded ReAct loop that runs inside a tick. |
| `weaveInMemoryStateStore`, `weaveRedisStateStore`, `weavePostgresStateStore`, `weaveSqliteStateStore`, `weaveMongoDbStateStore`, `weaveDynamoDbStateStore` | Pluggable persistence for meshes, agents, contracts, and messages. `weavePostgresStateStore` takes either `{ url }` (opens its own pool) or `{ pool }` (shares an existing one — e.g. from `weaveSharedPostgres`, so the whole runtime uses one connection; an injected pool is left open on `close()`). |
| `createMcpAccountSessionProvider` | Open MCP sessions so an agent can act as a bound external account. |
| `InMemoryLiveAgentsRunLogger`, `replayLiveAgentsRun` | Record and deterministically replay a run. |
| `LiveAgentsError` (+ typed subclasses) | Guardrail errors — e.g. `SelfGrantForbiddenError`, `OnlyHumansMayBindAccountsError`. |

## License

MIT.
