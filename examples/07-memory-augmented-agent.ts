/**
 * Example 07: Memory-Augmented Agent
 *
 * Demonstrates conversation memory, semantic memory, and entity memory
 * working together to give an agent persistent context.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core    — ExecutionContext (carries userId for per-user memory isolation)
 *   @weaveintel/memory  — Three memory subsystems that can be composed together:
 *     • weaveConversationMemory — Rolling chat history (FIFO, max N messages)
 *     • weaveSemanticMemory     — Embedding-based long-term memory (store / recall by similarity)
 *     • weaveEntityMemory       — Key-value store of structured facts about named entities
 *   @weaveintel/testing — weaveFakeEmbedding() for deterministic vector operations
 *
 * Why three memory types?
 *   Conversation memory captures recent dialogue (short-term). Semantic memory
 *   captures long-term knowledge and recalls it by meaning. Entity memory tracks
 *   structured facts about people, orgs, or concepts. Combining all three gives
 *   an agent a rich, multi-layered context that mitigates the LLM's limited
 *   context window.
 */
import {
  weaveContext,
} from '@weaveintel/core';
import {
  weaveConversationMemory,
  weaveSemanticMemory,
  weaveEntityMemory,
} from '@weaveintel/memory';
import { weaveFakeEmbedding } from '@weaveintel/testing';

async function main() {
  const ctx = weaveContext({ userId: 'demo-user' });

  // --- Conversation Memory ---
  // weaveConversationMemory keeps a sliding window of chat messages.
  // maxHistory limits how many messages are stored (oldest are evicted).
  // This is the simplest memory: it just stores the raw conversation.
  console.log('=== Conversation Memory ===');
  const conversationMemory = weaveConversationMemory({ maxHistory: 50 });

  // Simulate a multi-turn conversation
  await conversationMemory.addMessage(ctx, { role: 'user', content: 'My name is Alice.' });
  await conversationMemory.addMessage(ctx, {
    role: 'assistant',
    content: 'Nice to meet you, Alice! How can I help?',
  });
  await conversationMemory.addMessage(ctx, {
    role: 'user',
    content: 'I work at Acme Corp on the AI team.',
  });
  await conversationMemory.addMessage(ctx, {
    role: 'assistant',
    content: 'That sounds exciting! What are you working on?',
  });

  const history = await conversationMemory.getMessages(ctx);
  console.log(`Stored ${history.length} messages`);
  for (const msg of history) {
    console.log(`  [${msg.role}] ${msg.content}`);
  }

  // --- Semantic Memory ---
  // weaveSemanticMemory uses an embedding model to convert text into vectors,
  // then stores them in an internal vector index. The .recall() method embeds
  // a query and returns the top-K most semantically similar stored memories.
  // This lets the agent recall relevant long-term knowledge even if it wasn't
  // in the recent conversation window.
  console.log('\n=== Semantic Memory ===');
  const embeddingModel = weaveFakeEmbedding({ dimensions: 64 });
  const semanticMemory = weaveSemanticMemory(embeddingModel);

  // Store some knowledge
  await semanticMemory.store(ctx, 'Alice prefers TypeScript over Python.');
  await semanticMemory.store(ctx, 'Alice is working on a RAG pipeline at Acme Corp.');
  await semanticMemory.store(ctx, 'The team meeting is every Tuesday at 10am.');
  await semanticMemory.store(ctx, 'Project deadline is end of Q4 2025.');

  // Recall relevant memories
  const recalled = await semanticMemory.recall(ctx, 'What is Alice working on?', 2);
  console.log('Recalled memories for "What is Alice working on?":');
  for (const mem of recalled) {
    console.log(`  ${mem.content}`);
  }

  // --- Entity Memory ---
  // weaveEntityMemory stores structured key-value facts about named entities
  // (people, companies, concepts). Unlike semantic memory (free-text), entity
  // memory gives you exact lookups by name and typed metadata fields.
  // Useful for "Alice works at Acme" style facts that need precise retrieval.
  console.log('\n=== Entity Memory ===');
  const entityMemory = weaveEntityMemory();

  await entityMemory.upsertEntity(ctx, 'Alice', {
    role: 'AI Engineer',
    company: 'Acme Corp',
    preference: 'TypeScript > Python',
  });
  await entityMemory.upsertEntity(ctx, 'Acme Corp', {
    industry: 'Technology',
    team_size: '15 engineers',
  });

  const aliceEntry = await entityMemory.getEntity(ctx, 'Alice');
  console.log('Facts about Alice:');
  if (aliceEntry?.metadata) {
    for (const [key, value] of Object.entries(aliceEntry.metadata)) {
      console.log(`  ${key}: ${value}`);
    }
  }

  const acmeEntry = await entityMemory.getEntity(ctx, 'Acme Corp');
  console.log('Facts about Acme Corp:');
  if (acmeEntry?.metadata) {
    for (const [key, value] of Object.entries(acmeEntry.metadata)) {
      console.log(`  ${key}: ${value}`);
    }
  }

  // --- Combined: Build a rich prompt from all memories ---
  // In a real agent, you'd concatenate these three context sources into the
  // system prompt so the LLM has: (1) recent conversation, (2) relevant
  // long-term knowledge, and (3) precise entity facts — all in one prompt.
  console.log('\n=== Combined Context for Prompt ===');
  const query = 'Help Alice with her current project';

  const conversationContext = (await conversationMemory.getMessages(ctx))
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  const semanticContext = (await semanticMemory.recall(ctx, query, 3))
    .map((m) => m.content)
    .join('\n');

  const aliceEntity = await entityMemory.getEntity(ctx, 'Alice');
  const entityContext = aliceEntity?.metadata
    ? Object.entries(aliceEntity.metadata).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '';

  console.log('Conversation context:\n', conversationContext);
  console.log('\nSemantic context:\n', semanticContext);
  console.log('\nEntity context:\n', entityContext);
}

main().catch(console.error);
