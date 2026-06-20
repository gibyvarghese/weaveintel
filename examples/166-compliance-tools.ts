/**
 * Example 166: Compliance-aware tool execution (P6-4)
 *
 * Shows how to wire GDPR/SOC2 consent checks at tool-call time:
 *   - Consent checked against ctx.runtime.compliance.isAllowed()
 *   - Compliance audit events emitted with data classification tags
 *   - Tool calls blocked (with error step) when consent denied and
 *     enforceConsent=true
 *   - Tool calls allowed when consent granted
 *
 * This example uses a mock compliance manager to demonstrate both paths.
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveToolRegistry } from '@weaveintel/core';
import type { ExecutionContext } from '@weaveintel/core';
import type { Model } from '@weaveintel/core';

// ── Stub model ────────────────────────────────────────────────

const model: Model = {
  async generate(_ctx, req) {
    // Only call tool on the first turn (no tool messages yet)
    const hasToolResult = req.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      const lastMsg = req.messages.findLast((m) => m.role === 'user');
      const text = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

      if (/email|contact/i.test(text)) {
        return {
          content: '',
          toolCalls: [{ id: 'tc1', name: 'read_emails', arguments: '{"userId":"u123","limit":10}' }],
          usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
        };
      }

      if (/profile|pii/i.test(text)) {
        return {
          content: '',
          toolCalls: [{ id: 'tc2', name: 'read_user_profile', arguments: '{"userId":"u123"}' }],
          usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
        };
      }
    }

    // After tool result (or no tool needed): summarise
    const hasConsentDenied = req.messages.some((m) =>
      typeof m.content === 'string' && m.content.includes('consent not granted'),
    );
    return {
      content: hasConsentDenied
        ? 'I was unable to access that data due to consent restrictions.'
        : 'Task completed successfully.',
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 },
    };
  },
};

// ── Build compliance-aware agent ──────────────────────────────

const tools = weaveToolRegistry();

tools.register({
  schema: {
    name: 'read_emails',
    description: 'Read user emails (PII: email data)',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['userId'],
    },
  },
  async invoke(_ctx, input) {
    const { userId, limit } = input.arguments as { userId: string; limit?: number };
    return {
      content: JSON.stringify({
        emails: [
          { from: 'alice@example.com', subject: 'Hello!', date: '2024-01-15' },
          { from: 'bob@example.com', subject: 'Meeting', date: '2024-01-14' },
        ].slice(0, limit ?? 2),
        userId,
      }),
    };
  },
});

tools.register({
  schema: {
    name: 'read_user_profile',
    description: 'Read user PII profile (PII: identity data)',
    parameters: {
      type: 'object',
      properties: { userId: { type: 'string' } },
      required: ['userId'],
    },
  },
  async invoke(_ctx, input) {
    const { userId } = input.arguments as { userId: string };
    return {
      content: JSON.stringify({ userId, name: 'Alice Smith', dob: '1990-01-15', email: 'alice@example.com' }),
    };
  },
});

const agent = weaveAgent({
  name: 'pii-aware-agent',
  model,
  tools,
  complianceTools: {
    subjectId: 'user-u123',
    purpose: 'customer-support',
    dataClassifications: {
      read_emails: 'pii.email',
      read_user_profile: 'pii.identity',
    },
    enforceConsent: true,
  },
});

// ── Mock compliance manager ───────────────────────────────────

function makeComplianceRuntime(granted: boolean) {
  const auditLog: Array<{ subjectId: string; purpose: string; allowed: boolean }> = [];
  return {
    compliance: {
      isAllowed: (subjectId: string, purpose: string): boolean => {
        const allowed = granted;
        auditLog.push({ subjectId, purpose, allowed });
        return allowed;
      },
      auditLog,
    },
  };
}

async function main(): Promise<void> {
  // 1) Run with consent GRANTED
  console.log('=== Run with Consent GRANTED ===');
  const grantedRuntime = makeComplianceRuntime(true);
  const grantedCtx = {
    userId: 'u123',
    sessionId: 'compliance-demo-granted',
    runtime: grantedRuntime,
  } as unknown as ExecutionContext;

  const grantedResult = await agent.run(grantedCtx, {
    messages: [{ role: 'user', content: 'Please read my emails' }],
  });
  console.log('Status:', grantedResult.status);
  console.log('Output:', grantedResult.output);
  console.log('Steps with tool calls:', grantedResult.steps.filter((s) => s.toolCall).length);
  console.log('Compliance audit log:', grantedRuntime.compliance.auditLog);

  // 2) Run with consent DENIED
  console.log('\n=== Run with Consent DENIED ===');
  const deniedRuntime = makeComplianceRuntime(false);
  const deniedCtx = {
    userId: 'u123',
    sessionId: 'compliance-demo-denied',
    runtime: deniedRuntime,
  } as unknown as ExecutionContext;

  const deniedResult = await agent.run(deniedCtx, {
    messages: [{ role: 'user', content: 'Please read my emails' }],
  });
  console.log('Status:', deniedResult.status);
  console.log('Output:', deniedResult.output);
  const blockedSteps = deniedResult.steps.filter(
    (s) => s.toolCall?.result?.includes('consent not granted'),
  );
  console.log('Blocked tool steps:', blockedSteps.length);
  console.log('Compliance audit log:', deniedRuntime.compliance.auditLog);

  // 3) PII profile with consent DENIED
  console.log('\n=== PII Profile Read — Consent DENIED ===');
  const deniedResult2 = await agent.run(deniedCtx, {
    messages: [{ role: 'user', content: 'Show my pii profile data' }],
  });
  console.log('Status:', deniedResult2.status);
  console.log('Output:', deniedResult2.output);
}

main().catch(console.error);
