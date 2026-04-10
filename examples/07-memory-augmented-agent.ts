/**
 * Example 07: Memory-Augmented Agent
 *
 * Demonstrates conversation memory, semantic memory, and entity memory
 * working together to give an agent persistent context.
 */
import {
  createExecutionContext,
  createEventBus,
  createToolRegistry,
  defineTool,
} from '@weaveintel/core';
import {
  createInMemoryStore,
  createConversationMemory,
  createSemanticMemory,
  createEntityMemory,
} from '@weaveintel/memory';
import { createFakeEmbeddingModel } from '@weaveintel/testing';

async function main() {
  const ctx = createExecutionContext({ userId: 'demo-user' });

  // --- Conversation Memory ---
  console.log('=== Conversation Memory ===');
  const conversationMemory = createConversationMemory({ maxTurns: 50 });

  // Simulate a multi-turn conversation
  await conversationMemory.addMessage({ role: 'user', content: 'My name is Alice.' }, ctx);
  await conversationMemory.addMessage({
    role: 'assistant',
    content: 'Nice to meet you, Alice! How can I help?',
  }, ctx);
  await conversationMemory.addMessage({
    role: 'user',
    content: 'I work at Acme Corp on the AI team.',
  }, ctx);
  await conversationMemory.addMessage({
    role: 'assistant',
    content: 'That sounds exciting! What are you working on?',
  }, ctx);

  const history = await conversationMemory.getMessages(ctx);
  console.log(`Stored ${history.length} messages`);
  for (const msg of history) {
    console.log(`  [${msg.role}] ${msg.content}`);
  }

  // --- Semantic Memory ---
  console.log('\n=== Semantic Memory ===');
  const embeddingModel = createFakeEmbeddingModel({ dimensions: 64 });
  const store = createInMemoryStore();
  const semanticMemory = createSemanticMemory({ store, embeddingModel });

  // Store some knowledge
  await semanticMemory.store('Alice prefers TypeScript over Python.', {}, ctx);
  await semanticMemory.store('Alice is working on a RAG pipeline at Acme Corp.', {}, ctx);
  await semanticMemory.store('The team meeting is every Tuesday at 10am.', {}, ctx);
  await semanticMemory.store('Project deadline is end of Q4 2025.', {}, ctx);

  // Recall relevant memories
  const recalled = await semanticMemory.recall('What is Alice working on?', 2, ctx);
  console.log('Recalled memories for "What is Alice working on?":');
  for (const mem of recalled) {
    console.log(`  [score=${mem.score?.toFixed(3)}] ${mem.content}`);
  }

  // --- Entity Memory ---
  console.log('\n=== Entity Memory ===');
  const entityMemory = createEntityMemory();

  await entityMemory.setFact('Alice', 'role', 'AI Engineer', ctx);
  await entityMemory.setFact('Alice', 'company', 'Acme Corp', ctx);
  await entityMemory.setFact('Alice', 'preference', 'TypeScript > Python', ctx);
  await entityMemory.setFact('Acme Corp', 'industry', 'Technology', ctx);
  await entityMemory.setFact('Acme Corp', 'team_size', '15 engineers', ctx);

  const aliceFacts = await entityMemory.getFacts('Alice', ctx);
  console.log('Facts about Alice:');
  for (const [key, value] of Object.entries(aliceFacts)) {
    console.log(`  ${key}: ${value}`);
  }

  const acmeFacts = await entityMemory.getFacts('Acme Corp', ctx);
  console.log('Facts about Acme Corp:');
  for (const [key, value] of Object.entries(acmeFacts)) {
    console.log(`  ${key}: ${value}`);
  }

  // --- Combined: Build a rich prompt from all memories ---
  console.log('\n=== Combined Context for Prompt ===');
  const query = 'Help Alice with her current project';

  const conversationContext = (await conversationMemory.getMessages(ctx))
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  const semanticContext = (await semanticMemory.recall(query, 3, ctx))
    .map((m) => m.content)
    .join('\n');

  const entityContext = Object.entries(await entityMemory.getFacts('Alice', ctx))
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  console.log('Conversation context:\n', conversationContext);
  console.log('\nSemantic context:\n', semanticContext);
  console.log('\nEntity context:\n', entityContext);
}

main().catch(console.error);
