/**
 * Example 06: Agent-to-Agent (A2A) Communication — v1.0
 *
 * Demonstrates the in-process A2A bus using A2A v1.0 types:
 *   - A2ATaskSendParams (message.parts — field-presence, no type discriminator)
 *   - A2ATask response (contextId, artifacts[], history[], status.state)
 *   - AgentCard v1.0 (supportedInterfaces[], capabilities object, skills with id)
 *   - handleMessage() as the primary handler (replaces handleTask)
 *
 * Two agents (summarizer and translator) communicate via the in-process bus.
 *
 * Packages used:
 *   @weaveintel/core    — A2A types, ExecutionContext
 *   @weaveintel/a2a     — weaveA2ABus() in-process bus
 *   @weaveintel/agents  — weaveAgent()
 *   @weaveintel/testing — weaveFakeModel()
 */
import {
  weaveContext,
  weaveEventBus,
  weaveSetDefaultTracer,
  weaveToolRegistry,
  newUUIDv7,
} from '@weaveintel/core';
import type {
  AgentCard,
  A2AServer,
  A2ATask,
  A2ATaskSendParams,
  ExecutionContext,
} from '@weaveintel/core';
import { a2aTaskOutputText } from '@weaveintel/core';
import { weaveA2ABus } from '@weaveintel/a2a';
import { weaveAgent } from '@weaveintel/agents';
import { weaveConsoleTracer } from '@weaveintel/observability';
import { weaveFakeModel } from '@weaveintel/testing';

async function main() {
  weaveSetDefaultTracer(weaveConsoleTracer());

  const bus = weaveEventBus();
  const ctx = weaveContext({ userId: 'demo-user' });
  const a2aBus = weaveA2ABus();

  // ── Register Agent 1: Summarizer ──────────────────────────────────────────

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

  const summarizerCard: AgentCard = {
    name: 'summarizer',
    description: 'Summarizes text into concise bullet points',
    version: '1.0.0',
    skills: [{ id: 'summarize', name: 'Summarize', description: 'Summarize text concisely' }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      stateTransitionHistory: false,
    },
    supportedInterfaces: [
      { url: 'a2a://internal/summarizer', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
  };

  const summarizerServer: A2AServer = {
    card: summarizerCard,
    async handleMessage(taskCtx: ExecutionContext, params: A2ATaskSendParams): Promise<A2ATask> {
      const textParts = params.message.parts
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean);
      const result = await summarizerAgent.run(taskCtx, {
        messages: [{ role: 'user', content: textParts.join('\n') }],
      });
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      return {
        id: taskId,
        contextId,
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
        artifacts: [{ artifactId: `${taskId}-out`, name: 'summary', parts: [{ text: result.output }] }],
        history: [params.message, { role: 'agent', parts: [{ text: result.output }], contextId }],
      };
    },
    async start() {},
    async stop() {},
  };

  a2aBus.register('summarizer', summarizerServer);

  // ── Register Agent 2: Translator ──────────────────────────────────────────

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

  const translatorCard: AgentCard = {
    name: 'translator',
    description: 'Translates text to other languages',
    version: '1.0.0',
    skills: [{ id: 'translate', name: 'Translate', description: 'Translate text to a target language' }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      stateTransitionHistory: false,
    },
    supportedInterfaces: [
      { url: 'a2a://internal/translator', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
  };

  const translatorServer: A2AServer = {
    card: translatorCard,
    async handleMessage(taskCtx: ExecutionContext, params: A2ATaskSendParams): Promise<A2ATask> {
      const textParts = params.message.parts
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean);
      const result = await translatorAgent.run(taskCtx, {
        messages: [{ role: 'user', content: textParts.join('\n') }],
      });
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      return {
        id: taskId,
        contextId,
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
        artifacts: [{ artifactId: `${taskId}-out`, name: 'translation', parts: [{ text: result.output }] }],
        history: [params.message, { role: 'agent', parts: [{ text: result.output }], contextId }],
      };
    },
    async start() {},
    async stop() {},
  };

  a2aBus.register('translator', translatorServer);

  // ── Discover agents via the bus ───────────────────────────────────────────

  console.log('=== Discover Agents ===');
  const agents = a2aBus.listAgents();
  for (const card of agents) {
    const skillNames = card.skills.map((s) => s.id).join(', ');
    console.log(`  ${card.name}: ${card.description} [skills: ${skillNames}]`);
    console.log(`    streaming: ${card.capabilities.streaming}, endpoint: ${card.supportedInterfaces[0]?.url}`);
  }

  // ── Send a task to summarizer ─────────────────────────────────────────────

  console.log('\n=== Summarize ===');
  const sessionContextId = newUUIDv7();

  // v1.0: A2ATaskSendParams with message.parts (no `type` field on parts)
  const summaryResult = await a2aBus.send(ctx, 'summarizer', {
    message: {
      role: 'user',
      parts: [{ text: 'weaveIntel is a production-grade, protocol-first, capability-driven AI framework written in TypeScript. It supports multiple LLM types, vector stores, agents, MCP, A2A, memory, redaction, and observability.' }],
      contextId: sessionContextId,
      messageId: newUUIDv7(),
    },
  });

  console.log('Task state:', summaryResult.status.state);
  const summaryText = a2aTaskOutputText(summaryResult);
  console.log('Summary:', summaryText);
  console.log('Artifacts:', summaryResult.artifacts.length, '| History msgs:', summaryResult.history.length);

  // ── Chain to translator using same contextId ──────────────────────────────

  console.log('\n=== Translate (chained, same contextId) ===');
  const translateResult = await a2aBus.send(ctx, 'translator', {
    message: {
      role: 'user',
      parts: [{ text: `Translate to French: ${summaryText}` }],
      contextId: sessionContextId,  // same session context
      messageId: newUUIDv7(),
      referenceTaskIds: [summaryResult.id],  // reference prior task
    },
  });

  console.log('Task state:', translateResult.status.state);
  console.log('Translation:', a2aTaskOutputText(translateResult));
  console.log('ContextId consistent:', translateResult.contextId === sessionContextId);
}

main().catch(console.error);
