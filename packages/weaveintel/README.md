# @weaveintel/weaveintel

**The one package to install first: it re-exports the curated "golden path" — runtime, agents, tools, observability, and the cross-cutting primitives — so you can build an agent without hunting through dozens of packages.**

## Why it exists

weaveIntel is a big monorepo, and most people need only a small, well-worn slice of it to get going. Importing that slice one package at a time is an onboarding cliff. This is the welcome desk: install this single package and you get the pieces that fit together out of the box — a runtime with ambient observability, hardened network egress, secret resolution, and audit; agents; a tools registry. There's no hidden magic here, only re-exports. When you outgrow the golden path, reach past the desk and install the specific `@weaveintel/*` package you need.

## When to reach for it

Reach for it when you're starting a new project or want the sensible default set with one install. When you need finer control — a specific guardrails engine, a bespoke persistence backend, resilience policies — install that package directly (e.g. `@weaveintel/persistence`, `@weaveintel/guardrails`) alongside this one. This meta-package never hides behavior; it just saves you the import juggling.

## How to use it

```bash
npm install @weaveintel/weaveintel
```

```ts
import { weaveRuntime, weaveAgent, weaveTool, weaveToolRegistry } from '@weaveintel/weaveintel';

const runtime = weaveRuntime();

const weather = weaveTool({
  name: 'get_weather',
  description: 'Look up the current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  execute: async ({ city }) => JSON.stringify({ city, tempC: 21 }),
});

const tools = weaveToolRegistry();
tools.register(weather);

const agent = weaveAgent({
  name: 'assistant',
  model,   // any @weaveintel Model (e.g. from your provider package)
  tools,
});
```

## What's in the box

- **Runtime**: `weaveRuntime`, `RuntimeCapabilities`, `weaveContext` / `weaveChildContext`, `weaveAudit`, plus slots for guardrails, persistence, resilience, and egress.
- **Agents**: `weaveAgent`.
- **Tools**: `weaveTool`, `weaveToolRegistry`.
- **Hardened egress**: `hardenedFetch`, `createHardenedFetch`.
- **Secrets**: `envSecretResolver`, `inMemorySecretResolver`, `chainSecretResolvers`, `requireSecret`.
- **Observability**: `Tracer`/`Span` contracts + `weaveSetDefaultTracer`, with concrete `weaveConsoleTracer` and `weaveInMemoryTracer`.
- **Events**: `EventTypes`, `weaveEvent`, `EventBus`.

## License

MIT.
