/**
 * Example 135 — Tool retry with exponential back-off (P2-4)
 *
 * Demonstrates how weaveAgent automatically retries transient tool failures
 * using full-jitter exponential back-off:
 *
 *   delay = random() * min(maxBackoffMs, backoffMs * 2^attempt)
 *
 * Transient errors (network / 429 / 5xx) are retried transparently before
 * the error is surfaced to the model as an is_error tool result.
 * Non-transient errors (e.g. invalid arguments) are propagated immediately.
 *
 * Usage:
 *   npx ts-node examples/135-tool-retry.ts
 */

import { weaveContext, weaveRuntime, weaveToolRegistry } from '@weaveintel/core';
import type { ExecutionContext, Tool } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { createMockModel } from '@weaveintel/devtools';

// ── Helpers ───────────────────────────────────────────────────────────────────

function flakyApiTool(name: string, failTimes: number, errorType: 'transient' | 'permanent'): Tool & { attempts: number } {
  let calls = 0;
  return Object.assign(
    {
      schema: { name, description: `API tool: ${name}`, parameters: { type: 'object', properties: {} } },
      async invoke(_ctx: ExecutionContext) {
        calls++;
        if (calls <= failTimes) {
          const msg = errorType === 'transient'
            ? `ECONNRESET: connection reset on attempt ${calls}`
            : `400 Bad Request: invalid API key`;
          throw new Error(msg);
        }
        return { content: `${name} succeeded on attempt ${calls}` };
      },
    },
    { get attempts() { return calls; } },
  );
}

// ── Model that calls one tool per response ────────────────────────────────────

function oneToolModel(toolName: string) {
  let n = 0;
  const base = createMockModel({ name: 'retry-demo', responses: ['Analysis complete.'] });
  return {
    ...base,
    async generate(ctx: ExecutionContext, req: Parameters<typeof base.generate>[1]) {
      n++;
      if (n === 1) {
        return {
          id: 'r1', model: 'retry-demo', content: '',
          toolCalls: [{ id: 'tc1', name: toolName, arguments: '{}' }],
          finishReason: 'tool_calls' as const,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      }
      return base.generate(ctx, req);
    },
  };
}

const runtime = weaveRuntime({ audit: { async log() {} } });
const ctx = weaveContext({ runtime });

// ── Scenario 1: Transient failure — succeeded on retry ────────────────────────

console.log('=== Scenario 1: Transient ECONNRESET — succeeds on attempt 3 ===');
const tool1 = flakyApiTool('weather_api', 2, 'transient');
const tools1 = weaveToolRegistry();
tools1.register(tool1);

const agent1 = weaveAgent({
  model: oneToolModel('weather_api'),
  tools: tools1,
  name: 'retry-scenario-1',
  toolRetry: { maxAttempts: 5, backoffMs: 1, maxBackoffMs: 10 },
});

const result1 = await agent1.run(ctx, {
  messages: [{ role: 'user', content: 'What is the current weather?' }],
});
console.log('Status:', result1.status);
console.log('Tool attempts:', tool1.attempts, '(2 transient + 1 success)');
const step1 = result1.steps.find((s) => s.toolCall?.name === 'weather_api');
console.log('Tool result:', step1?.toolCall?.result);

// ── Scenario 2: Non-transient failure — not retried ───────────────────────────

console.log('\n=== Scenario 2: Permanent 400 error — NOT retried ===');
const tool2 = flakyApiTool('billing_api', 5, 'permanent');
const tools2 = weaveToolRegistry();
tools2.register(tool2);

const agent2 = weaveAgent({
  model: oneToolModel('billing_api'),
  tools: tools2,
  name: 'retry-scenario-2',
  toolRetry: { maxAttempts: 5, backoffMs: 1, maxBackoffMs: 10 },
});

const result2 = await agent2.run(ctx, {
  messages: [{ role: 'user', content: 'Look up my billing history.' }],
});
console.log('Status:', result2.status);
console.log('Tool attempts:', tool2.attempts, '(should be 1 — not retried)');
const step2 = result2.steps.find((s) => s.toolCall?.name === 'billing_api');
console.log('Error surfaced to model:', step2?.toolCall?.result?.includes('400'));

// ── Scenario 3: All retries exhausted ────────────────────────────────────────

console.log('\n=== Scenario 3: Transient error — all 3 attempts fail ===');
const tool3 = flakyApiTool('flaky_db', 100, 'transient');
const tools3 = weaveToolRegistry();
tools3.register(tool3);

const agent3 = weaveAgent({
  model: oneToolModel('flaky_db'),
  tools: tools3,
  name: 'retry-scenario-3',
  toolRetry: { maxAttempts: 3, backoffMs: 1, maxBackoffMs: 5 },
});

const result3 = await agent3.run(ctx, {
  messages: [{ role: 'user', content: 'Query the database.' }],
});
console.log('Status:', result3.status);
console.log('Tool attempts:', tool3.attempts, '(should be 3 — exhausted)');
const step3 = result3.steps.find((s) => s.toolCall?.name === 'flaky_db');
console.log('Error in result:', step3?.toolCall?.result?.includes('connection reset'));
