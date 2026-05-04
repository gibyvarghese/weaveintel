/**
 * Phase 4 — `weaveLiveAgent` parity demo
 * --------------------------------------------------------------------
 * Shows side-by-side construction of:
 *   1. `weaveAgent({ ... })`     — request-scoped agent from `@weaveintel/agents`
 *   2. `weaveLiveAgent({ ... })` — long-running task handler from
 *      `@weaveintel/live-agents`
 *
 * The point of this example is API ergonomics: a developer who knows one
 * should know the other. Both constructors share the same field names
 * (`name`, `model`, `tools`, `systemPrompt`, `policy`, `maxSteps`).
 *
 * No external services or DB required — uses a stub model that returns a
 * single final answer.
 *
 * Run:
 *   npx tsx examples/94-weave-live-agent-parity.ts
 */

import {
  weaveContext,
  weaveToolRegistry,
  type ExecutionContext,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type Tool,
  type ToolInput,
  type ToolOutput,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import {
  weaveLiveAgent,
  weaveLiveAgentPolicy,
} from '@weaveintel/live-agents';
import type { ActionExecutionContext } from '@weaveintel/live-agents';

// ─── 1. Shared building blocks (model + tool) ────────────────

function stubModel(): Model {
  return {
    info: { provider: 'demo', modelId: 'demo-1', capabilities: new Set() },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate(
      _ctx: ExecutionContext,
      _req: ModelRequest,
    ): Promise<ModelResponse> {
      return {
        id: 'res-1',
        model: 'demo-1',
        content: '42',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  } as unknown as Model;
}

function stubTool(): Tool {
  return {
    name: 'lookup',
    description: 'a stub lookup',
    schema: { type: 'object', properties: {} },
    riskLevel: 'read-only',
    async invoke(_i: ToolInput): Promise<ToolOutput> {
      return { content: 'looked up' };
    },
  } as unknown as Tool;
}

const SHARED_PROMPT = 'You are a numerical assistant. Answer concisely.';

async function main() {
  console.log('=== weaveAgent vs weaveLiveAgent — API parity demo ===\n');

  // ─── 2. weaveAgent — request-scoped ──────────────────────
  console.log('1) weaveAgent (request-scoped, @weaveintel/agents)');
  const tools1 = weaveToolRegistry();
  tools1.register(stubTool());
  const agent = weaveAgent({
    name: 'requester',
    model: stubModel(),
    tools: tools1,
    systemPrompt: SHARED_PROMPT,
    maxSteps: 4,
  });
  const ctx = weaveContext({ userId: 'demo' });
  const result = await agent.run(ctx, {
    messages: [{ role: 'user', content: 'What is the answer?' }],
    goal: 'Answer the question',
  });
  console.log(`   final → ${result.output}\n`);

  // ─── 3. weaveLiveAgent — long-running task handler ──────
  console.log('2) weaveLiveAgent (long-running, @weaveintel/live-agents)');
  const tools2 = weaveToolRegistry();
  tools2.register(stubTool());
  const { handler, definition } = weaveLiveAgent({
    name: 'live-requester',
    role: 'researcher',
    model: stubModel(),
    tools: tools2,
    systemPrompt: SHARED_PROMPT,
    maxSteps: 4,
    // Same policy slot shape as weaveAgent, just composed differently.
    policy: weaveLiveAgentPolicy({
      auditEmitter: {
        async emit(ev) {
          console.log(`   [audit] ${ev.toolName} → ${ev.outcome}`);
        },
      },
    }),
    log: (msg) => console.log(`   [live] ${msg}`),
  });
  console.log(
    `   definition → name=${definition.name} role=${definition.role} ` +
      `caps=${JSON.stringify(definition.capabilities)}`,
  );

  const stubActionCtx = {
    agent: { id: 'live-requester-1', meshId: 'mesh-demo' },
    stateStore: { async listMessagesForRecipient() { return []; } },
  } as unknown as ActionExecutionContext;
  const stubAction = { type: 'StartTask', agentId: 'live-requester-1' } as never;
  const liveResult = (await handler(stubAction, stubActionCtx, ctx)) as {
    completed: boolean;
    summaryProse?: string;
  };
  console.log(`   completed=${liveResult.completed}\n`);

  // ─── 4. Recap — the slot names line up ──────────────────
  console.log('Both accept the same slot names:');
  console.log('   - name, model, tools, systemPrompt, policy, maxSteps');
  console.log(
    'weaveLiveAgent additionally accepts: modelResolver, prepare, ' +
      'modelCapability, summarize, log, onError, memory, bus.',
  );
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
