/**
 * Example 135 — A2A-out: wrapping an agent as an A2A v1.0 server
 *
 * Demonstrates `weaveAgentAsA2AServer` which adapts any `Agent` to the
 * `A2AServer` interface using A2A v1.0 types:
 *   - `handleMessage(ctx, params: A2ATaskSendParams)` → `Promise<A2ATask>`
 *   - `handleStreamMessage(ctx, params)` → `AsyncIterable<A2AStreamEvent>`
 *   - AgentCard v1.0 with supportedInterfaces, capabilities object, skills with id
 *
 * Key concepts:
 *   • `weaveAgentAsA2AServer` — wraps an Agent as an A2AServer (v1.0)
 *   • `weaveA2ABus`           — in-process bus: register/discover/send
 *   • Results returned as `A2ATask` with artifacts[] and history[]
 *   • Stream yields `A2AStreamEvent` (statusUpdate / artifactUpdate / task)
 *
 * No API key needed — uses createMockModel from @weaveintel/devtools.
 *
 * Run: npx tsx examples/135-a2a-out.ts
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveAgentAsA2AServer, weaveA2ABus } from '@weaveintel/a2a';
import { weaveContext, newUUIDv7 } from '@weaveintel/core';
import { a2aTaskOutputText } from '@weaveintel/core';
import { createMockModel } from '@weaveintel/devtools';

async function main() {
  const agent = weaveAgent({
    model: createMockModel({
      name: 'mock-a2a-agent',
      responses: ['The capital of France is Paris.'],
    }),
    maxSteps: 3,
    name: 'geography-expert',
  });

  // ── Wrap agent as A2A v1.0 server ────────────────────────────────────────

  const server = weaveAgentAsA2AServer({
    agent,
    card: {
      name: 'geography-expert',
      description: 'Expert agent for geography questions',
      version: '1.0.0',
      skills: [
        {
          id: 'geography-qa',
          name: 'Geography Q&A',
          description: 'Answer geography questions',
          tags: ['geography', 'facts'],
          examples: ['What is the capital of France?', 'How large is Canada?'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
      ],
      capabilities: {
        streaming: true,
        pushNotifications: false,
        extendedAgentCard: false,
        stateTransitionHistory: false,
      },
      supportedInterfaces: [
        { url: 'http://localhost:3001/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    },
  });

  console.log('Agent card:');
  console.log('  name:', server.card.name);
  console.log('  version:', server.card.version);
  console.log('  skills:', server.card.skills.map((s) => s.id).join(', '));
  console.log('  streaming:', server.card.capabilities.streaming);
  console.log('  endpoint:', server.card.supportedInterfaces[0]?.url);

  // ── Register on in-process bus ───────────────────────────────────────────

  const bus = weaveA2ABus();
  bus.register(server.card.name, server);

  const ctx = weaveContext({});
  const contextId = newUUIDv7();

  // ── Direct handleMessage call (v1.0) ─────────────────────────────────────

  console.log('\n--- Direct handleMessage ---');
  const task = await server.handleMessage(ctx, {
    message: {
      role: 'user',
      parts: [{ text: 'What is the capital of France?' }],
      contextId,
      messageId: newUUIDv7(),
    },
  });

  console.log('Task ID:', task.id);
  console.log('Context ID:', task.contextId);
  console.log('State:', task.status.state);
  console.log('Artifacts:', task.artifacts.length);
  console.log('Output:', a2aTaskOutputText(task));
  console.log('History messages:', task.history.length);

  // ── Same task via bus.send() ──────────────────────────────────────────────

  console.log('\n--- Via bus.send() ---');
  const busResult = await bus.send(ctx, 'geography-expert', {
    message: {
      role: 'user',
      parts: [{ text: 'What is the largest country by area?' }],
      contextId,
      messageId: newUUIDv7(),
    },
  });
  console.log('Bus result state:', busResult.status.state);
  console.log('Bus result output:', a2aTaskOutputText(busResult));

  // ── Streaming via handleStreamMessage (v1.0) ─────────────────────────────

  if (server.handleStreamMessage) {
    console.log('\n--- Streaming handleStreamMessage ---');
    let artifactChunks = 0;
    let statusUpdates = 0;
    let finalTask = null;

    for await (const event of server.handleStreamMessage(ctx, {
      message: {
        role: 'user',
        parts: [{ text: 'Name three European capitals.' }],
        contextId,
        messageId: newUUIDv7(),
      },
    })) {
      if ('statusUpdate' in event) {
        statusUpdates++;
        process.stdout.write(`[status: ${event.statusUpdate.status.state}] `);
      } else if ('artifactUpdate' in event) {
        artifactChunks++;
        const text = event.artifactUpdate.artifact.parts[0]?.text ?? '';
        process.stdout.write(text ? `[chunk] ${text.slice(0, 30)}... ` : '');
      } else if ('task' in event) {
        finalTask = event.task;
        process.stdout.write(`\n[final: ${event.task.status.state}]\n`);
      }
    }

    console.log(`Status updates: ${statusUpdates}, artifact chunks: ${artifactChunks}`);
    if (finalTask) {
      console.log('Final output:', a2aTaskOutputText(finalTask));
    }
  }

  // ── Deprecated handleTask shim (still works) ─────────────────────────────

  console.log('\n--- Deprecated handleTask shim ---');
  if (server.handleTask) {
    const legacyResult = await server.handleTask(ctx, {
      id: newUUIDv7(),
      input: {
        role: 'user',
        parts: [{ text: 'What is the capital of Japan?' }],
      },
    });
    console.log('Legacy status:', legacyResult.status);
    console.log('Legacy output:', legacyResult.output?.parts[0]?.text);
  }
}

main().catch(console.error);
