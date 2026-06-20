/**
 * Example 164: A2A-native supervisor (P6-2)
 *
 * Shows how `weaveA2ASupervisor` creates an agent that is simultaneously:
 *   - A fully functional weaveAgent (can be called locally)
 *   - An A2AServer (handles external A2A protocol messages)
 *   - Persists task state (pluggable store)
 *   - Supports streaming updates
 *   - Exposes an Agent Card for discovery
 */

import { weaveA2ASupervisor, createInMemoryA2ATaskStore } from '@weaveintel/agents';
import type { ExecutionContext, A2ATaskSendParams } from '@weaveintel/core';
import { a2aPartsText, newUUIDv7 } from '@weaveintel/core';

import type { Model } from '@weaveintel/core';

// Stub model that responds to research + summary tasks
const model: Model = {
  async generate(_ctx, req) {
    const lastUser = req.messages.findLast((m) => m.role === 'user');
    const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
    if (/research|find|look/i.test(text)) {
      return {
        content: 'Research complete: Found 3 relevant papers on quantum computing published in 2024.',
        toolCalls: [],
        usage: { promptTokens: 20, completionTokens: 25, totalTokens: 45 },
      };
    }
    return {
      content: 'Summary: Task completed successfully with all sub-goals achieved.',
      toolCalls: [],
      usage: { promptTokens: 15, completionTokens: 20, totalTokens: 35 },
    };
  },
};

// ── Create the supervisor ─────────────────────────────────────

const taskStore = createInMemoryA2ATaskStore();

const supervisor = weaveA2ASupervisor({
  name: 'research-orchestrator',
  description: 'Orchestrates research tasks across specialist agents',
  model,
  taskStore,
  serverUrl: 'https://agents.example.com/research-orchestrator',
  agentCard: {
    name: 'Research Orchestrator',
    description: 'Delegates research tasks to specialist workers and aggregates results',
    url: 'https://agents.example.com/research-orchestrator',
    skills: [
      {
        id: 'research',
        name: 'Research',
        description: 'Find information on any topic',
        tags: ['research', 'information-retrieval'],
      },
      {
        id: 'summarize',
        name: 'Summarize',
        description: 'Summarize research findings',
        tags: ['summary', 'synthesis'],
      },
    ],
  },
});

async function main(): Promise<void> {
  const ctx = { userId: 'demo-user', sessionId: 'a2a-demo' } as ExecutionContext;

  // 1. Discover — inspect Agent Card
  console.log('=== Agent Card ===');
  console.log('Name:', supervisor.card.name);
  console.log('Description:', supervisor.card.description);
  console.log('Skills:', supervisor.card.skills.map((s) => s.name).join(', '));
  console.log('Interfaces:', supervisor.card.supportedInterfaces.map((i) => i.url).join(', '));

  // 2. Send a task via A2A protocol
  console.log('\n=== A2A Message: Research Task ===');
  const taskId = newUUIDv7();
  const params: A2ATaskSendParams = {
    message: {
      role: 'user',
      parts: [{ text: 'Research recent advances in quantum computing — find 3 key papers from 2024' }],
      messageId: newUUIDv7(),
      contextId: newUUIDv7(),
    },
    metadata: { taskId },
  };

  const task = await supervisor.handleMessage(ctx, params);
  console.log('Task ID:', task.id);
  console.log('Status:', task.status.state);
  console.log('Output:', a2aPartsText(task.status.message?.parts ?? []));
  console.log('Artifacts:', task.artifacts.length);

  // 3. Retrieve the task by ID
  console.log('\n=== Task Retrieval ===');
  const fetched = await supervisor.getTask(ctx, task.id);
  console.log('Fetched task ID:', fetched?.id);
  console.log('History turns:', fetched?.history.length);

  // 4. List all tasks
  console.log('\n=== Task Listing ===');
  const page = await supervisor.listTasks(ctx);
  console.log('Total tasks:', page.tasks.length);

  // 5. Streaming task
  console.log('\n=== Streaming A2A Task ===');
  const streamParams: A2ATaskSendParams = {
    message: {
      role: 'user',
      parts: [{ text: 'Summarize findings from the research' }],
      messageId: newUUIDv7(),
      contextId: newUUIDv7(),
    },
  };

  let eventCount = 0;
  let finalState = '';
  for await (const event of supervisor.handleStreamMessage(ctx, streamParams)) {
    eventCount++;
    finalState = event.task.status.state;
  }
  console.log('Stream events received:', eventCount);
  console.log('Final task state:', finalState);

  // 6. Push notification config
  console.log('\n=== Push Notification Config ===');
  const pushEntry = await supervisor.createPushConfig!(ctx, task.id, {
    url: 'https://webhooks.example.com/agent-updates',
    token: 'secret-webhook-token',
  });
  console.log('Config ID:', pushEntry.pushConfigId);
  console.log('Task ID on entry:', pushEntry.taskId);

  const fetched2 = await supervisor.getPushConfig!(ctx, task.id, pushEntry.pushConfigId);
  console.log('Push URL:', fetched2?.url);

  // 7. Cancel a task (best-effort)
  console.log('\n=== Task Cancellation ===');
  await supervisor.cancelTask(ctx, task.id);
  const cancelled = await supervisor.getTask(ctx, task.id);
  console.log('Cancelled state:', cancelled?.status.state);

  // 8. Use as a regular Agent (local call)
  console.log('\n=== Local Agent Call ===');
  const localResult = await supervisor.run(ctx, {
    messages: [{ role: 'user', content: 'Find papers on large language models' }],
    goal: 'Research LLMs',
  });
  console.log('Local result status:', localResult.status);
  console.log('Local result output:', localResult.output);

  // 9. Graceful shutdown
  await supervisor.stop();
  console.log('\nSupervisor stopped gracefully.');
}

main().catch(console.error);
