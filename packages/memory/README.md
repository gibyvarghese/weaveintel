# @weaveintel/memory

**Gives an AI agent a memory — the running conversation, durable facts, the people and things it has met, and how they connect.**

## Why it exists

A fresh AI call is an amnesiac: it knows only what you paste into this one prompt. Real assistants need to remember — that you already introduced yourself, that "the Munich office" is the same place you mentioned last week, that a correction you made should stick. Think of it as the difference between a stranger and a colleague: the colleague carries context forward. This package is that carried-forward context — short-term chat history, long-term facts, the entities involved, and a small knowledge graph of how they relate (it absorbed the old standalone graph package, so entities and relationships live here too).

## When to reach for it

Reach for it whenever an agent should recall anything across turns or sessions: conversation history, learned facts, or a graph of people/orgs/topics. Pick a backend to match your scale — in-memory for tests, SQLite/Postgres/pgvector/Redis/Mongo/DynamoDB for production. If all you need is to look up passages from a document corpus at query time (RAG over files), use `@weaveintel/retrieval` instead; memory is about what the agent *remembers*, not what it can *fetch on demand*.

## How to use it

```ts
import { weaveConversationMemory } from '@weaveintel/memory';
import { weaveContext } from '@weaveintel/core';

const memory = weaveConversationMemory({ maxHistory: 50 });
const ctx = weaveContext();

await memory.addMessage(ctx, { role: 'user', content: 'I work in Munich.' });
await memory.addMessage(ctx, { role: 'assistant', content: 'Noted!' });

const recent = await memory.getMessages(ctx, 10); // last 10 turns, ready to re-prompt
```

## What's in the box

- **Conversation** — `weaveConversationMemory`, `createConfiguredConversationMemory`.
- **Stores (pick a backend)** — `weaveMemoryStore`, `weaveRuntimeMemoryStore`, `weaveSqliteMemoryStore`, `weavePostgresMemoryStore`, `weavePgVectorMemoryStore`, `weaveRedisMemoryStore`, `weaveMongoDbMemoryStore`, `weaveCloudNoSqlMemoryStore`, plus `createConfiguredMemoryStore` / `…Async`.
  - **Sharing one Postgres pool:** the Postgres stores take either a connection string *or* an existing pool — `weavePostgresMemoryStore({ url })` **or** `weavePostgresMemoryStore({ pool })` (same for `weavePgVectorMemoryStore`). Pass a shared `pool` (e.g. from `weaveSharedPostgres` in `@weaveintel/persistence`) so your whole app runs on one connection instead of each store opening its own. When you inject a pool, the store leaves it open on `close()` — you own its lifecycle.
  - **One implementation for SQLite + Postgres:** the plain `weaveSqliteMemoryStore` and `weavePostgresMemoryStore` now share a single query implementation (built with Drizzle), so the two databases can't drift apart. `memoryStoreContract` runs the same battery against both to prove it. (The `pgvector` store is separate — it's Postgres-only by nature.)
- **Semantic & entity** — `weaveSemanticMemory`, `weaveEntityMemory`, `fusedMemorySearch` (recency × importance × relevance fusion).
- **Working memory & context** — `weaveWorkingMemory`, `createContextAssembler`, compressor registry.
- **Lifecycle** — `deduplicateExact`/`deduplicateByKey`, `recordCorrection`/`supersede`, `enforceRetention`/`forgetUser`/`forgetSession`, `weaveMemoryConsolidator`.
- **Extraction & procedural** — `runHybridMemoryExtraction`, `extractEntitiesByRegexRules`, `createProceduralEntry`/`runProceduralCurator`.
- **Knowledge graph** — `createGraphMemoryStore`, `createEntityNode`, `createRelationshipEdge`, `createEntityLinker`, `createTimelineGraph`, `createGraphRetriever`.
- **Governance & provenance** — `weaveGovernancePolicy`, `setProvenance`/`filterByConfidence`.

## License

MIT.
