/**
 * Example 93 — Live-agents Phase 3: `LiveAgentPolicy` as a first-class capability.
 *
 * Demonstrates the per-tick policy enforcement pattern:
 *
 *   - `weaveLiveAgentPolicy({ ... })` bundles the four tool-policy primitives
 *     from `@weaveintel/tools` (resolver, approval, rate-limit, audit) into a
 *     single capability slot mirroring `weaveAgent`'s pinned `policy:`.
 *   - When set, `createAgenticTaskHandler` wraps the per-tick `tools` registry
 *     with `createPolicyEnforcedRegistry` BEFORE handing it to the ReAct loop.
 *   - `permissivePolicyResolver` (internal) falls back to `DEFAULT_TOOL_POLICY`
 *     so audit-only or rate-limit-only configurations still work without a
 *     dedicated resolver.
 *
 * Run:
 *   npx tsx examples/93-live-agents-policy.ts
 *
 * Expected output:
 *   - Three scenarios printed in sequence, each completing without throwing.
 *   - Audit emitter prints every tool invocation in scenario 1.
 *   - Rate limiter denies the second call in scenario 2.
 *   - Approval gate denies the call in scenario 3 — the ReAct loop receives
 *     the error as a tool result and terminates cleanly.
 *   - No external services required (uses a stub model + stub tools + an
 *     in-memory ActionExecutionContext stub with an empty inbox).
 */

import {
  createAgenticTaskHandler,
  weaveLiveAgentPolicy,
  type LiveAgentPolicy,
} from '@weaveintel/live-agents';
import {
  weaveToolRegistry,
  weaveTool,
  type ExecutionContext,
  type Model,
  type ToolAuditEvent,
} from '@weaveintel/core';
import type {
  ToolApprovalGate,
  ToolAuditEmitter,
  ToolPolicyResolver,
  ToolRateLimiter,
} from '@weaveintel/tools';

// ─── Stub Model that calls one tool then finishes ─────────────────
function stubReactModel(toolName: string, toolCalls = 1): Model {
  let call = 0;
  return {
    info: { provider: 'fake', modelId: 'stub-react', capabilities: new Set() },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate() {
      call += 1;
      if (call <= toolCalls) {
        return {
          id: `r${call}`,
          model: 'stub-react',
          content: '',
          toolCalls: [
            { id: `t${call}`, name: toolName, arguments: JSON.stringify({ input: `hello-${call}` }) },
          ],
          finishReason: 'tool_use',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      }
      return {
        id: `r${call}`,
        model: 'stub-react',
        content: 'all done',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  } as unknown as Model;
}

// ─── Stub tool registry ───────────────────────────────────────────
function makeStubTools() {
  const echoTool = weaveTool({
    name: 'echo',
    description: 'Echo input',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
    },
    riskLevel: 'read-only',
    async execute(args: Record<string, unknown>) {
      return `echo:${JSON.stringify(args)}`;
    },
  });
  const reg = weaveToolRegistry();
  reg.register(echoTool);
  return reg;
}

// Stub ActionExecutionContext — handler only needs agent.id/meshId and an
// empty inbox. State store returns no inbound messages so the loop runs
// the no-inbound branch.
function stubActionContext() {
  return {
    agent: { id: 'agent-demo', meshId: 'mesh-demo' },
    stateStore: {
      async listMessagesForRecipient() {
        return [];
      },
    },
  } as never;
}
function stubAction() {
  return { type: 'StartTask', agentId: 'agent-demo' } as never;
}
function stubExecCtx(): ExecutionContext {
  return { userId: 'demo', logger: console } as unknown as ExecutionContext;
}

const HR = (label: string) => console.log(`\n=== ${label} ===`);

// ─── Scenario 1 — audit-only policy ───────────────────────────────
async function demoAuditOnly() {
  HR('1) Audit-only LiveAgentPolicy');
  const events: ToolAuditEvent[] = [];
  const auditEmitter: ToolAuditEmitter = {
    async emit(ev) {
      events.push(ev);
      console.log(`  [audit] ${ev.toolName} → ${ev.outcome} (${ev.durationMs}ms)`);
    },
  };
  const policy: LiveAgentPolicy = weaveLiveAgentPolicy({ auditEmitter });

  const handler = createAgenticTaskHandler({
    name: 'audit-demo',
    model: stubReactModel('echo'),
    policy,
    maxSteps: 4,
    prepare: async () => ({
      systemPrompt: 'You are an echo agent.',
      userGoal: 'Echo "hello"',
      tools: makeStubTools(),
    }),
  });

  await handler(stubAction(), stubActionContext(), stubExecCtx());
  console.log(`  total audit events captured: ${events.length}`);
}

// ─── Scenario 2 — rate-limited policy ─────────────────────────────
async function demoRateLimited() {
  HR('2) Rate-limited LiveAgentPolicy (limit = 1/min)');
  let allowed = 1;
  const rateLimiter: ToolRateLimiter = {
    async check(toolName) {
      const ok = allowed > 0;
      allowed -= 1;
      console.log(`  [rate-limit] ${toolName} → ${ok ? 'allowed' : 'DENIED'}`);
      return ok;
    },
    async remaining() {
      return Math.max(0, allowed);
    },
  };
  const policy = weaveLiveAgentPolicy({
    rateLimiter,
    // Resolver injects rateLimitPerMinute=1 so the rate-limit gate fires.
    policyResolver: {
      async resolve() {
        return {
          enabled: true,
          riskLevel: 'read-only',
          requiresApproval: false,
          requireDryRun: false,
          logInputOutput: false,
          allowedRiskLevels: ['read-only', 'write'],
          rateLimitPerMinute: 1,
          source: 'global_policy',
        };
      },
    },
  });

  const handler = createAgenticTaskHandler({
    name: 'rate-demo',
    model: stubReactModel('echo', 2),
    policy,
    maxSteps: 6,
    prepare: async () => ({
      systemPrompt: 'You are an echo agent.',
      userGoal: 'Echo "hello"',
      tools: makeStubTools(),
    }),
  });

  await handler(stubAction(), stubActionContext(), stubExecCtx());
}

// ─── Scenario 3 — approval-required policy ────────────────────────
async function demoApprovalRequired() {
  HR('3) Approval-required LiveAgentPolicy (auto-deny)');
  const approvalGate: ToolApprovalGate = {
    async check(toolName) {
      console.log(`  [approval] ${toolName} requested → DENIED (demo)`);
      return { status: 'denied', reason: 'demo policy denies all' };
    },
  };
  const policyResolver: ToolPolicyResolver = {
    async resolve() {
      return {
        enabled: true,
        riskLevel: 'write',
        requiresApproval: true,
        requireDryRun: false,
        logInputOutput: false,
        allowedRiskLevels: ['read-only', 'write'],
        source: 'global_policy',
      };
    },
  };
  const policy = weaveLiveAgentPolicy({ policyResolver, approvalGate });

  const handler = createAgenticTaskHandler({
    name: 'approval-demo',
    model: stubReactModel('echo'),
    policy,
    maxSteps: 4,
    prepare: async () => ({
      systemPrompt: 'You are an echo agent.',
      userGoal: 'Echo "hello"',
      tools: makeStubTools(),
    }),
  });

  await handler(stubAction(), stubActionContext(), stubExecCtx());
}

async function main() {
  console.log('Live-Agents Phase 3 — LiveAgentPolicy demo');
  await demoAuditOnly();
  await demoRateLimited();
  await demoApprovalRequired();
  console.log('\nAll three policy scenarios completed without throwing.');
}

main().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
