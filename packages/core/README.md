# @weaveintel/core

**The dependency-free foundation every other weaveIntel package is built on: shared contracts, types, the WeaveRuntime, and persistence interfaces.**

## Why it exists

Imagine a big building where the plumbing, wiring, and doorframes all have to line up. If every team invented its own pipe diameter, nothing would connect. `core` is the set of agreed-upon fittings: the exact shape of a `Model`, a `Tool`, a run event, an audit log. Every provider, router, and app speaks these shapes, so a piece written by one team drops cleanly into work by another. Crucially, `core` depends on *no* other `@weaveintel` package — everyone depends on it, never the reverse.

## When to reach for it

Reach for `core` whenever you need a type or interface that crosses package boundaries — defining a model, describing a tool, wiring the `WeaveRuntime` slots (egress, secrets, audit, persistence, resilience) that features run against. If you want a working model client, router, or prompt engine, don't stop here — install the package that *implements* the contract (e.g. `@weaveintel/routing`). `core` is the vocabulary, not the machinery.

## How to use it

```ts
import { weaveRuntime, weaveContext, defineTool as weaveTool } from '@weaveintel/core';

const clock = weaveTool({
  name: 'now',
  description: 'Return the current ISO timestamp',
  schema: { type: 'object', properties: {} },
  async execute() {
    return { iso: new Date().toISOString() };
  },
});

const runtime = weaveRuntime({ /* egress, secrets, audit, persistence slots */ });
const ctx = weaveContext({ runtime });

console.log(await clock.execute({}, ctx));
```

## What's in the box

- **Runtime** — `weaveRuntime`, its typed slots (`RuntimeEgressSlot`, `RuntimePersistenceSlot`, `RuntimeRoutingSlot`, …), `assertRuntimeRequires`, in-memory persistence and audit.
- **Model & tool contracts** — `Model`, `ModelRequest`, `Message`, `Tool`, `weaveTool`, `weaveToolRegistry`.
- **Execution** — `weaveContext`, `ExecutionBudget`, `WeaveIntelError`, `classifyError`, `weaveEventBus`, `WeavePipeline`/middleware.
- **Contracts galore** — memory, security, guardrails, observability, agents, workflows, MCP, A2A, RAG/vectorstore, compliance, and more.
- **Runtime plumbing** — `newUUIDv7`, `createLogger`, `assertSafeOutboundUrl`, `createHardenedFetch`, `parseSseStream`, `applyJsonPatch`.

Subpath entry points: `@weaveintel/core/models`, `/contracts`, `/plugins`, `/capability-packs`, `/i18n`.

## License

MIT.
