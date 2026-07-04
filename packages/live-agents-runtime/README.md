# @weaveintel/live-agents-runtime

**Turns database rows into running live agents — a handler registry plus built-in plugins that hydrate a whole mesh from the DB in one call.**

## Why it exists

`@weaveintel/live-agents` gives you the moving parts of a persistent agent, but someone still has to decide *what kind* of agent each one is and wire it up. In a real product those decisions live in a database: this agent runs an LLM loop, that one just forwards messages, this one waits for human approval. Hard-coding that in TypeScript means a deploy for every change. Think of a stage manager who reads the night's cast list and props sheet, then sets up each performer — same crew, different show every night, no rebuild. This package is that stage manager: register named "handler kinds" once at boot, store which kind each agent uses in a row, and let the runtime resolve and run them.

## When to reach for it

Reach for `@weaveintel/live-agents-runtime` when your agents, meshes, and tool bindings are configured in database rows and you want them provisioned and driven without hand-wiring. If you're constructing agents directly in code, you don't need this layer — use `@weaveintel/live-agents` on its own. This package sits strictly on top of it.

## How to use it

```ts
import {
  createDefaultHandlerRegistry,
  weaveLiveMeshFromDb,
} from '@weaveintel/live-agents-runtime';

// Registry pre-loaded with built-in kinds: agentic.react, deterministic.forward,
// human.approval, a2a.inbound/outbound, and more.
const handlerRegistry = createDefaultHandlerRegistry();

// One call composes provision → registry → heartbeat supervisor → run bridge.
const handle = await weaveLiveMeshFromDb(db, {
  store,
  handlerRegistry,
  modelResolver,      // optional — per-tick model selection
  policy,             // optional — tool approval / rate-limit / audit bundle
});

// ... agents now run against the DB blueprint.
await handle.stop();
```

## What's in the box

| Export | What it does |
|---|---|
| `HandlerRegistry`, `createHandlerRegistry`, `createDefaultHandlerRegistry` | Register named handler kinds; the default comes pre-loaded with the built-ins. |
| `agenticReactHandler` | LLM ReAct loop over the agent's inbox. |
| `deterministicForwardHandler` / `deterministicTemplateHandler` / `deterministicMapReduceHandler` | Pure routers, template renderers, and fan-out/reduce — no LLM. |
| `humanApprovalHandler` | Dual-control gate backed by approval-request rows. |
| `a2aInboundHandler` / `a2aOutboundHandler` | Talk to remote agents over A2A. |
| `agenticComputerUseHandler`, `agenticBrowserHandler`, `agenticCodeInterpreterHandler`, `agenticVoiceRealtimeHandler`, `agenticMultimodalHandler`, `multiAgentSwarmHandler`, `externalMcpToolHandler` | Expanded handler catalog for richer agent behaviours. |
| `weaveLiveMeshFromDb` / `weaveLiveAgentFromDb` | One-call hydration of a whole mesh, or a single agent, from DB rows. |
| `provisionMesh`, `createHeartbeatSupervisor`, `bridgeRunState` | The lower-level pieces `weaveLiveMeshFromDb` composes, if you need them directly. |
| `weaveDbModelResolver`, `resolveAgentModelSpec` | Pick a model per tick from routing hints stored on the agent row. |
| `weaveDbLiveAgentPolicy`, `resolveAgentToolCatalog` | Resolve an agent's tool surface and policy from the DB. |
| `parsePrepareConfig`, `dbPrepareFromConfig` | Turn a JSON `prepare` recipe on the row into a real `prepare()` function. |
| `createDurableLiveAgentCheckpointStore` | Persist tick continuity so a restart resumes cleanly. |

## License

MIT.
