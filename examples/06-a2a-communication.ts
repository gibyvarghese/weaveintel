/**
 * Example 06: Agent-to-Agent (A2A) Communication
 *
 * Demonstrates the internal A2A bus for in-process agent delegation.
 * Two agents (summarizer and translator) communicate via the bus.
 */
import {
  createExecutionContext,
  createEventBus,
  createToolRegistry,
} from '@weaveintel/core';
import type { AgentCard } from '@weaveintel/core';
import { createInternalA2ABus } from '@weaveintel/a2a';
import { createToolCallingAgent } from '@weaveintel/agents';
import { createFakeModel } from '@weaveintel/testing';

async function main() {
  const bus = createEventBus();
  const ctx = createExecutionContext({ userId: 'demo-user' });

  // Create the A2A bus
  const a2aBus = createInternalA2ABus();

  // --- Register Agent 1: Summarizer ---
  const summarizerModel = createFakeModel({
    responses: [
      {
        content: 'Summary: WeaveIntel is a modular, protocol-first AI framework for TypeScript.',
        toolCalls: [],
      },
    ],
  });

  const summarizerAgent = createToolCallingAgent({
    model: summarizerModel,
    tools: createToolRegistry(),
    bus,
    systemPrompt: 'You summarize text concisely.',
    maxSteps: 3,
  });

  const summarizerCard: AgentCard = {
    name: 'summarizer',
    description: 'Summarizes text into concise bullet points',
    url: 'a2a://internal/summarizer',
    capabilities: ['text.summarize'],
    version: '1.0.0',
  };

  a2aBus.register(summarizerCard, async (task) => {
    const result = await summarizerAgent.run(
      { messages: [{ role: 'user', content: task.input }] },
      ctx,
    );
    return { ...task, status: 'completed', output: result.output };
  });

  // --- Register Agent 2: Translator ---
  const translatorModel = createFakeModel({
    responses: [
      {
        content: 'Translation (French): WeaveIntel est un framework IA modulaire pour TypeScript.',
        toolCalls: [],
      },
    ],
  });

  const translatorAgent = createToolCallingAgent({
    model: translatorModel,
    tools: createToolRegistry(),
    bus,
    systemPrompt: 'You translate text to the requested language.',
    maxSteps: 3,
  });

  const translatorCard: AgentCard = {
    name: 'translator',
    description: 'Translates text to other languages',
    url: 'a2a://internal/translator',
    capabilities: ['text.translate'],
    version: '1.0.0',
  };

  a2aBus.register(translatorCard, async (task) => {
    const result = await translatorAgent.run(
      { messages: [{ role: 'user', content: task.input }] },
      ctx,
    );
    return { ...task, status: 'completed', output: result.output };
  });

  // --- Use the bus ---
  console.log('=== Discover Agents ===');
  const agents = a2aBus.discover();
  for (const card of agents) {
    console.log(`  ${card.name}: ${card.description} [${card.capabilities.join(', ')}]`);
  }

  // Send a task to the summarizer
  console.log('\n=== Summarize ===');
  const summaryTask = await a2aBus.send('summarizer', {
    id: 'task-1',
    input: 'WeaveIntel is a production-grade, protocol-first, capability-driven AI framework written in TypeScript. It supports multiple LLM types, vector stores, agents, MCP, A2A, memory, redaction, and observability.',
    status: 'pending',
  });
  console.log('Result:', summaryTask.output);

  // Send to translator
  console.log('\n=== Translate ===');
  const translateTask = await a2aBus.send('translator', {
    id: 'task-2',
    input: `Translate to French: ${summaryTask.output}`,
    status: 'pending',
  });
  console.log('Result:', translateTask.output);
}

main().catch(console.error);
