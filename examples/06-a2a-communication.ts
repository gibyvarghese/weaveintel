/**
 * Example 06: Agent-to-Agent (A2A) Communication
 *
 * Demonstrates the internal A2A bus for in-process agent delegation.
 * Two agents (summarizer and translator) communicate via the bus.
 */
import {
  weaveContext,
  weaveEventBus,
  weaveToolRegistry,
} from '@weaveintel/core';
import type { AgentCard, A2AServer, A2ATask, A2ATaskResult, ExecutionContext } from '@weaveintel/core';
import { weaveA2ABus } from '@weaveintel/a2a';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

/** Helper to extract text from an A2ATask input */
function taskText(task: A2ATask): string {
  return task.input.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

async function main() {
  const bus = weaveEventBus();
  const ctx = weaveContext({ userId: 'demo-user' });

  // Create the A2A bus
  const a2aBus = weaveA2ABus();

  // --- Register Agent 1: Summarizer ---
  const summarizerModel = weaveFakeModel({
    responses: [
      {
        content: 'Summary: weaveIntel is a modular, protocol-first AI framework for TypeScript.',
        toolCalls: [],
      },
    ],
  });

  const summarizerAgent = weaveAgent({
    model: summarizerModel,
    tools: weaveToolRegistry(),
    bus,
    systemPrompt: 'You summarize text concisely.',
    maxSteps: 3,
  });

  const summarizerServer: A2AServer = {
    card: {
      name: 'summarizer',
      description: 'Summarizes text into concise bullet points',
      url: 'a2a://internal/summarizer',
      capabilities: ['text.summarize'],
      version: '1.0.0',
    },
    async handleTask(taskCtx: ExecutionContext, task: A2ATask): Promise<A2ATaskResult> {
      const result = await summarizerAgent.run(taskCtx, {
        messages: [{ role: 'user', content: taskText(task) }],
      });
      return {
        id: task.id,
        status: 'completed',
        output: { role: 'agent', parts: [{ type: 'text', text: result.output }] },
      };
    },
    async start() {},
    async stop() {},
  };

  a2aBus.register('summarizer', summarizerServer);

  // --- Register Agent 2: Translator ---
  const translatorModel = weaveFakeModel({
    responses: [
      {
        content: 'Translation (French): weaveIntel est un framework IA modulaire pour TypeScript.',
        toolCalls: [],
      },
    ],
  });

  const translatorAgent = weaveAgent({
    model: translatorModel,
    tools: weaveToolRegistry(),
    bus,
    systemPrompt: 'You translate text to the requested language.',
    maxSteps: 3,
  });

  const translatorServer: A2AServer = {
    card: {
      name: 'translator',
      description: 'Translates text to other languages',
      url: 'a2a://internal/translator',
      capabilities: ['text.translate'],
      version: '1.0.0',
    },
    async handleTask(taskCtx: ExecutionContext, task: A2ATask): Promise<A2ATaskResult> {
      const result = await translatorAgent.run(taskCtx, {
        messages: [{ role: 'user', content: taskText(task) }],
      });
      return {
        id: task.id,
        status: 'completed',
        output: { role: 'agent', parts: [{ type: 'text', text: result.output }] },
      };
    },
    async start() {},
    async stop() {},
  };

  a2aBus.register('translator', translatorServer);

  // --- Use the bus ---
  console.log('=== Discover Agents ===');
  const agents = a2aBus.listAgents();
  for (const card of agents) {
    console.log(`  ${card.name}: ${card.description} [${card.capabilities.join(', ')}]`);
  }

  // Send a task to the summarizer
  console.log('\n=== Summarize ===');
  const summaryResult = await a2aBus.send(ctx, 'summarizer', {
    id: 'task-1',
    input: {
      role: 'user',
      parts: [{
        type: 'text',
        text: 'weaveIntel is a production-grade, protocol-first, capability-driven AI framework written in TypeScript. It supports multiple LLM types, vector stores, agents, MCP, A2A, memory, redaction, and observability.',
      }],
    },
  });
  const summaryText = summaryResult.output?.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('') ?? '';
  console.log('Result:', summaryText);

  // Send to translator
  console.log('\n=== Translate ===');
  const translateResult = await a2aBus.send(ctx, 'translator', {
    id: 'task-2',
    input: {
      role: 'user',
      parts: [{ type: 'text', text: `Translate to French: ${summaryText}` }],
    },
  });
  const translateText = translateResult.output?.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('') ?? '';
  console.log('Result:', translateText);
}

main().catch(console.error);
