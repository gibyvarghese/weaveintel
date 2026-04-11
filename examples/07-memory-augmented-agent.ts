/**
 * Example 07: Memory-Augmented Agent
 *
 * Demonstrates conversation memory, semantic memory, and entity memory
 * working together to give an agent persistent context.
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
