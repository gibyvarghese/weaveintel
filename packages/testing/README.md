# @weaveintel/testing

**Fakes and an eval runner for testing weaveIntel code without real models, vector stores, or network calls.**

## Why it exists

Testing code that calls a language model is like rehearsing a play with a stand-in actor: you don't want the real, expensive, unpredictable star for every rehearsal — you want a reliable stand-in who says exactly the line you scripted, every time. `testing` gives you those stand-ins: a fake model that returns what you told it to, a fake vector store, a fake transport, and a whole fake runtime — so your tests are fast, deterministic, and free of network flakiness. When you *do* want to grade quality against a rubric, the eval runner is there too.

## When to reach for it

Reach for it in unit and integration tests, or anywhere you want deterministic behavior instead of live model output — CI, local dev, reproducing a bug. Use the `./evals` subpath when you're scoring outputs against a rubric rather than just stubbing a dependency. For hand-built inline mocks aimed at DX scaffolding rather than test suites, see `@weaveintel/devtools`.

## How to use it

```ts
import { weaveFakeModel, FakeRuntime } from '@weaveintel/testing';

const model = weaveFakeModel({ responses: ['Hello from the stand-in.'] });
const runtime = new FakeRuntime();

const res = await model.generate({
  messages: [{ role: 'user', content: 'hi' }],
});

console.log(res.content); // "Hello from the stand-in."
```

## What's in the box

- **Fakes** — `weaveFakeModel`, `weaveFakeEmbedding`, `weaveFakeVectorStore`, `weaveFakeTransport` (fake MCP server transport), `weaveFakeContainerRuntime`.
- **Fake provider servers** — `startFakeOpenAICompatibleServer`, `startFakeBedrockServer`, `startFakeGoogleServer`: in-process HTTP servers that speak each provider's wire format (chat, streaming, tool calls, embeddings, model lists) and can be switched into failure modes (`rate_limit`, `server_error`, `malformed`, `hang`). They record every request so a test can check what was sent. Loopback only, test keys only.
- **Fake runtime** — `FakeRuntime`, with `FakeModelOptions` / `FakeRuntimeOptions` to script behavior.
- **Container types** — `ContainerRuntime`, `ContainerRunResult`.

Subpath entry point: `@weaveintel/testing/evals` — the eval runner and rubric scoring.

## License

MIT.
