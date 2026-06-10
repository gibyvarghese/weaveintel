/**
 * Example 135 — A2A-out: wrapping an agent as an A2A server (W6)
 *
 * Demonstrates `weaveAgentAsA2AServer` which adapts any `Agent` to the
 * `A2AServer` interface — enabling in-process discovery, HTTP serving,
 * and cross-agent task delegation.
 *
 * Key concepts:
 *   • `weaveAgentAsA2AServer` — wraps an Agent as an A2AServer
 *   • `weaveA2ABus`           — in-process bus: register/discover/send
 *   • The server can also be served over HTTP via start(port)
 *   • handleStreamTask provides SSE-compatible streaming
 *
 * No API key needed — uses createMockModel from @weaveintel/devtools.
 *
 * Run: npx tsx examples/135-a2a-out.ts
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveAgentAsA2AServer } from '@weaveintel/a2a';
import { weaveA2ABus } from '@weaveintel/a2a';
import { weaveContext, newUUIDv7 } from '@weaveintel/core';
import { createMockModel } from '@weaveintel/devtools';

async function main() {
  // Create an agent that answers questions.
  const agent = weaveAgent({
    model: createMockModel({
      name: 'mock-a2a-agent',
      responses: ['The capital of France is Paris.'],
    }),
    maxSteps: 3,
    name: 'geography-expert',
  });

  // Wrap the agent as an A2A server.
  const server = weaveAgentAsA2AServer({
    agent,
    card: {
      name: 'geography-expert',
      description: 'Expert agent for geography questions',
      url: 'http://localhost:3001/a2a',
      version: '1.0.0',
      capabilities: ['text'],
    },
  });

  console.log('Agent card:', server.card);

  // Register on the in-process bus.
  const bus = weaveA2ABus();
  bus.register(server.card.name, server);

  // Submit a task via the bus (same as direct call but routed through the bus).
  const ctx = weaveContext({});
  const task = {
    id: newUUIDv7(),
    input: {
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'What is the capital of France?' }],
    },
  };

  console.log('\nSubmitting task:', task.id);

  // Direct handleTask call (same interface the bus uses internally).
  const result = await server.handleTask(ctx, task);
  console.log('Status:', result.status);
  console.log('Output:', result.output?.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));

  // Streaming variant — yields working chunks then final result.
  if (server.handleStreamTask) {
    console.log('\nStreaming task:');
    const streamTask = { id: newUUIDv7(), ...task };
    for await (const event of server.handleStreamTask(ctx, streamTask)) {
      if (event.status === 'working' && event.output) {
        process.stdout.write('[chunk] ' + event.output.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
      } else if (event.status === 'completed') {
        console.log('\n[done]  ' + event.output?.parts.map((p) => (p.type === 'text' ? p.text : '')).join(''));
      }
    }
  }
}

main().catch(console.error);
