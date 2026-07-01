# @weaveintel/memory

Memory implementations — conversation history, semantic recall, and entity facts.

## Usage

```typescript
import {
  createInMemoryStore,
  createConversationMemory,
  createSemanticMemory,
  createEntityMemory,
} from '@weaveintel/memory';

// Conversation memory — recent message history
const conversation = createConversationMemory({ maxMessages: 50 });
await conversation.add({ role: 'user', content: 'Hello' }, ctx);
const history = await conversation.getHistory(ctx);

// Semantic memory — embedding-based recall
const store = createInMemoryStore();
const semantic = createSemanticMemory(embeddingModel, store);
await semantic.store('Alice prefers TypeScript over Python', ctx);
const recalls = await semantic.recall('What language does Alice like?', ctx);

// Entity memory — structured facts about named entities
const entity = createEntityMemory(store);
await entity.set('Alice', 'role', 'Senior Engineer', ctx);
const role = await entity.get('Alice', 'role', ctx);
```

## Temporally-aware retrieval (`fusedMemorySearch`)

`fusedMemorySearch(store, ctx, opts)` ranks memories by a weighted blend of **semantic** similarity,
**keyword** overlap, and **entity**-name match. It also supports two optional temporal signals (off by
default, so existing callers are unaffected):

- `recencyWeight` — exponential **recency decay** (`halfLifeMs`, `nowMs`): newer memories score higher.
- `importanceWeight` — the entry's **importance**/salience (from `entry.importance` or `metadata.importance`).
- `excludeSuperseded: true` — drop facts invalidated via the bi-temporal `invalidAt` (e.g. a preference
  you've since changed).

Together these give the Generative-Agents *recency × importance × relevance* scoring used by the
weaveNotes "second brain": recent, important and relevant memories surface first, superseded ones fade.

```ts
const hits = await fusedMemorySearch(store, ctx, {
  query: 'launch plan', embedding, userId,
  recencyWeight: 0.2, importanceWeight: 0.15, excludeSuperseded: true,
  halfLifeMs: 30 * 24 * 3600 * 1000,
});
```
