/**
 * Example 140 — Human-in-the-Loop (HITL) interrupt mechanism (P3-1)
 *
 * Demonstrates how weaveAgent suspends tool execution to await a human
 * approval decision:
 *
 *   onInterrupt — async hook called before any tool that needs approval fires
 *   InterruptResolution — approve / reject / modify the tool call
 *
 * Scenarios shown:
 *   1. Auto-approve: every interrupt immediately approved (baseline)
 *   2. Auto-reject: tool call stopped by human reviewer
 *   3. Modify: human changes tool arguments before execution
 *   4. Queue-backed: tasks enqueued in InMemoryTaskQueue, resolved async
 *
 * Usage:
 *   npx ts-node examples/140-hitl-interrupt.ts
 */

import { weaveContext, weaveRuntime, weaveToolRegistry, weaveTool } from '@weaveintel/core';
import type { ExecutionContext } from '@weaveintel/core';
import {
  weaveAgent,
  autoApproveInterruptHandler,
  autoRejectInterruptHandler,
  createHumanTaskInterruptHandler,
  type InterruptEvent,
  type InterruptResolution,
} from '@weaveintel/agents';
import { InMemoryTaskQueue } from '@weaveintel/human-tasks';
import { createMockModel } from '@weaveintel/devtools';

// ─── Shared setup ─────────────────────────────────────────────

const runtime = weaveRuntime({});

function makeCtx(): ExecutionContext {
  return weaveContext({ executionId: `ex-${Date.now()}`, runtime });
}

// A tool that would normally do something risky (e.g. delete a file)
function makeRiskyTool() {
  return weaveTool({
    name: 'delete_file',
    description: 'Delete a file by path',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
      },
      required: ['path'],
    },
    execute: async (args) => {
      const { path } = args as { path: string };
      return { content: `Deleted ${path}` };
    },
  });
}

// ─── Scenario 1: Auto-approve ──────────────────────────────────

async function scenario1AutoApprove() {
  console.log('\n── Scenario 1: Auto-approve (tool fires immediately) ──');
  const reg = weaveToolRegistry();
  reg.register(makeRiskyTool());

  // Mock model that calls delete_file once, then responds
  const model = createMockModel([
    { toolCalls: [{ id: 'tc1', name: 'delete_file', arguments: '{"path":"/tmp/test.txt"}' }] },
    { content: 'File deleted successfully.' },
  ]);

  const agent = weaveAgent({
    model,
    tools: reg,
    name: 'agent-auto-approve',
    onInterrupt: autoApproveInterruptHandler,
    requireApproval: true,   // ALL tools go through the interrupt
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Delete /tmp/test.txt',
    messages: [{ role: 'user', content: 'Delete /tmp/test.txt' }],
  });
  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Scenario 2: Auto-reject ───────────────────────────────────

async function scenario2AutoReject() {
  console.log('\n── Scenario 2: Auto-reject (tool blocked by reviewer) ──');
  const reg = weaveToolRegistry();
  reg.register(makeRiskyTool());

  const model = createMockModel([
    { toolCalls: [{ id: 'tc2', name: 'delete_file', arguments: '{"path":"/etc/passwd"}' }] },
    { content: 'The deletion was rejected by the safety reviewer.' },
  ]);

  const agent = weaveAgent({
    model,
    tools: reg,
    name: 'agent-auto-reject',
    onInterrupt: autoRejectInterruptHandler,
    requireApproval: true,
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Delete /etc/passwd',
    messages: [{ role: 'user', content: 'Delete /etc/passwd' }],
  });
  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Scenario 3: Modify args ───────────────────────────────────

async function scenario3Modify() {
  console.log('\n── Scenario 3: Reviewer modifies tool arguments ──');
  const reg = weaveToolRegistry();
  reg.register(makeRiskyTool());

  // Model asks to delete /prod/data — reviewer redirects to /tmp/data
  const model = createMockModel([
    { toolCalls: [{ id: 'tc3', name: 'delete_file', arguments: '{"path":"/prod/data"}' }] },
    { content: 'Deleted file (path was redirected to safe location by reviewer).' },
  ]);

  const modifyHandler = async (_ctx: ExecutionContext, event: InterruptEvent): Promise<InterruptResolution> => {
    console.log('  Reviewer intercepted tool:', event.toolName, event.toolArgs);
    const originalPath = (event.toolArgs['path'] as string) ?? '';
    if (originalPath.startsWith('/prod/')) {
      const safePath = originalPath.replace('/prod/', '/tmp/');
      console.log(`  Redirecting path: ${originalPath} → ${safePath}`);
      return {
        action: 'modify',
        modifiedArgs: { path: safePath },
        feedback: `Path was redirected from production to staging area.`,
      };
    }
    return { action: 'approve' };
  };

  const agent = weaveAgent({
    model,
    tools: reg,
    name: 'agent-modify',
    onInterrupt: modifyHandler,
    requireApproval: true,
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Clean up prod data',
    messages: [{ role: 'user', content: 'Delete /prod/data' }],
  });
  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Scenario 4: Queue-backed HITL (async decision) ────────────

async function scenario4QueueBacked() {
  console.log('\n── Scenario 4: Queue-backed HITL (human decides async) ──');
  const reg = weaveToolRegistry();
  reg.register(makeRiskyTool());

  const queue = new InMemoryTaskQueue();
  const handler = createHumanTaskInterruptHandler(queue, {
    pollIntervalMs: 100,   // fast poll for demo
    timeoutMs: 5_000,
    assignee: 'admin@acme.com',
  });

  const model = createMockModel([
    { toolCalls: [{ id: 'tc4', name: 'delete_file', arguments: '{"path":"/tmp/demo.txt"}' }] },
    { content: 'File deleted after human approval.' },
  ]);

  const agent = weaveAgent({
    model,
    tools: reg,
    name: 'agent-queue',
    onInterrupt: handler,
    requireApproval: true,
  });

  // Simulate a human approving the task concurrently
  const approveTask = async () => {
    // Wait for the task to be enqueued
    while (true) {
      const tasks = await queue.list({ status: 'pending' });
      if (tasks.length > 0) {
        const task = tasks[0]!;
        console.log(`  Human reviewer received task: "${task.title}"`);
        await queue.complete(task.id, {
          decision: 'approved',
          decidedAt: new Date().toISOString(),
          data: { decision: 'approve', feedback: 'Looks safe to delete.' },
        });
        console.log('  Human reviewer approved the task.');
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  const [result] = await Promise.all([
    agent.run(makeCtx(), {
      goal: 'Delete /tmp/demo.txt',
      messages: [{ role: 'user', content: 'Delete /tmp/demo.txt' }],
    }),
    approveTask(),
  ]);
  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Run all scenarios ─────────────────────────────────────────

(async () => {
  await scenario1AutoApprove();
  await scenario2AutoReject();
  await scenario3Modify();
  await scenario4QueueBacked();
  console.log('\n✓ All HITL scenarios complete.');
})().catch(console.error);
