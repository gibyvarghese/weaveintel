# @weaveintel/api-client

**A typed, bearer-token client for the geneWeave `/api/me` surface — auth, runs, catalog, tasks, reminders, memories, devices, notifications, and conversations.**

## Why it exists

Talking to a server over HTTP by hand is fiddly: you have to remember every URL, attach the right token and CSRF header on every call, and hope the JSON that comes back is shaped the way you expected. It's like ordering at a foreign café by pointing and guessing. This package is the phrasebook — it gives you named, typed methods for each thing the geneWeave server can do, injects your credentials automatically, and validates every response with zod so a surprise from the server turns into a clear error instead of a mystery crash. Each client is its own independent instance, so one device can safely run one client per tenant.

## When to reach for it

Reach for it when a mobile app, desktop app, or service needs to call the geneWeave `/api/me` endpoints with a stored bearer token. It stays runtime-agnostic — no React or React Native imports — so you bring your own transport and token storage. If you instead need the low-level run-streaming primitives directly in a browser (SSE decoding, view-model reducer, outbox), reach for `@weaveintel/client`, which this package is built on and re-exports the key pieces of.

## How to use it

```ts
import { createGeneweaveClient, MemoryTokenStore, createHttpTransport } from '@weaveintel/api-client';

const client = createGeneweaveClient({
  host: 'https://api.example.com',
  transport: createHttpTransport(),
  tokens: new MemoryTokenStore(),
});

const runs = await client.listRuns({ limit: 20 });
console.log(runs);
```

## What's in the box

| Export | What it does |
| --- | --- |
| `createGeneweaveClient` | The typed client over the `/api/me` surface |
| `createHttpTransport` | Default HTTP transport seam (injectable/replaceable) |
| `MemoryTokenStore`, `namespacedTokenStore` | Bearer/CSRF token storage (bring your own `KeyValueStore`) |
| `GeneweaveApiError`, `AuthExpiredError`, `ManagedByOrgError`, `ResponseShapeError` | Typed error classes |
| `API_CLIENT_SCHEMA_VERSION`, `HostConfigSchema` | Version pin + connection config schema |
| Re-exported run primitives | `createRunSession`, `streamReducer`, `createRunOutbox`, `parseSseStream`, `parsePartialJson`, `toAGUIEvents` and more from `@weaveintel/client`, so you configure the client without importing it directly |
| `./schemas.js` types | zod schemas + inferred types for every surface (agenda, notes, etc.) |

## License

MIT.
