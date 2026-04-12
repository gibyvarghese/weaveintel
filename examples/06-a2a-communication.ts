/**
 * Example 06: Agent-to-Agent (A2A) Communication
 *
 * Demonstrates the internal A2A bus for in-process agent delegation.
 * Two agents (summarizer and translator) communicate via the bus.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core    — ExecutionContext, EventBus, ToolRegistry, and A2A type definitions
 *                         (AgentCard, A2AServer, A2ATask, A2ATaskResult)
 *   @weaveintel/a2a     — weaveA2ABus() creates an in-process message bus that implements
 *                         Google's Agent-to-Agent protocol for agent discovery & delegation
 *   @weaveintel/agents  — weaveAgent() for creating the underlying ReAct agents
 *   @weaveintel/testing — weaveFakeModel() for deterministic responses
 *
 * A2A (Agent-to-Agent) is an open protocol for agent interoperability.
 * Each agent publishes an AgentCard describing its capabilities, and other
 * agents can discover and send tasks to it via the bus.
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

  // weaveA2ABus() creates the A2A message bus — a registry + dispatcher.
  // Agents register as A2AServer instances with an AgentCard (name, description,
  // capabilities, version). You can then discover agents via listAgents() and
  // send tasks via send(). The bus handles routing, execution, and result delivery.
  const a2aBus = weaveA2ABus();

  // --- Register Agent 1: Summarizer ---
  // Each A2A agent wraps a weaveAgent with an A2AServer adapter.
  // The A2AServer interface requires:
  //   • card       — AgentCard with name, description, capabilities array, and URL
  //   • handleTask — receives an A2ATask (with input parts) and returns an A2ATaskResult
  //   • start/stop — lifecycle hooks (no-ops here since we're in-process)
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

  // a2aBus.register() adds the agent to the bus under a string key.
  // Other agents (or the main program) can now discover it via listAgents()
  // and send tasks to it via send(ctx, 'summarizer', task).
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
  // listAgents() returns all registered AgentCards — useful for agent discovery.
  // In a distributed setup, agents could be on different machines and discovered
  // via HTTP; the in-process bus is a lightweight alternative for monolith apps.
  console.log('=== Discover Agents ===');
  const agents = a2aBus.listAgents();
  for (const card of agents) {
    console.log(`  ${card.name}: ${card.description} [${card.capabilities.join(', ')}]`);
  }

  // a2aBus.send() dispatches a task to a named agent and awaits its result.
  // The task input uses A2A's multipart message format (role + parts array),
  // supporting text, file, and data parts. The result follows the same format.
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
