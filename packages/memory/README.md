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
