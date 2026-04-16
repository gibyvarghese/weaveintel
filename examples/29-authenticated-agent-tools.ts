/**
 * Example 29: Authenticated agent + tool execution
 *
 * Run:
 *   npx tsx examples/29-authenticated-agent-tools.ts
 *
 * Demonstrates a full agent/tool setup where tool execution is authorized
 * using package-level identity + access evaluation.
 */

import {
  weaveContext,
  weaveEventBus,
  weaveTool,
  weaveToolRegistry,
} from '@weaveintel/core';
import type { IdentityContext } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';
import {
  createIdentity,
  createIdentityContext,
  DEFAULT_RBAC_POLICY,
  extendIdentityWithPersona,
  evaluateAccess,
} from '@weaveintel/identity';
import type { AccessRule } from '@weaveintel/identity';

interface AuditRow {
  tool: string;
  allowed: boolean;
  reason?: string;
}

function readIdentityContext(ctx: { metadata: Readonly<Record<string, unknown>> }): IdentityContext | null {
  const value = ctx.metadata['identityContext'];
  if (!value || typeof value !== 'object') return null;
  return value as IdentityContext;
}

function canExecute(
  idCtx: IdentityContext | null,
  resource: string,
  action: string,
  rules: AccessRule[],
): { allowed: boolean; reason: string } {
  if (!idCtx) return { allowed: false, reason: 'Missing identity context' };
  const decision = evaluateAccess(idCtx, { resource, action }, rules);
  return {
    allowed: decision.result === 'allow',
    reason: decision.reason ?? 'No reason',
  };
}

function assertScenario(
  persona: string,
  audit: AuditRow[],
): void {
  const adminCall = audit.find((a) => a.tool === 'admin_delete_user');
  if (!adminCall) throw new Error(`Scenario ${persona}: admin_delete_user was not invoked`);

  if (persona === 'tenant_user' && adminCall.allowed) {
    throw new Error('tenant_user should not be allowed to run admin_delete_user');
  }
  if (persona === 'tenant_admin' && !adminCall.allowed) {
    throw new Error('tenant_admin should be allowed to run admin_delete_user');
  }
}

async function runScenario(persona: 'tenant_user' | 'tenant_admin'): Promise<void> {
  console.log(`\n=== Scenario: ${persona} ===`);

  const baseIdentity = createIdentity({
    type: 'user',
    id: `demo-${persona}`,
    name: `Demo ${persona}`,
    tenantId: 'tenant-a',
  });
  const identity = extendIdentityWithPersona(baseIdentity, DEFAULT_RBAC_POLICY, persona);
  const idCtx = createIdentityContext(identity, {
    permissions: identity.scopes ?? [],
  });

  const ctx = weaveContext({
    userId: identity.id,
    tenantId: identity.tenantId,
    metadata: { identityContext: idCtx },
  });

  const bus = weaveEventBus();
  const tools = weaveToolRegistry();
  const audit: AuditRow[] = [];

  const authRules: AccessRule[] = [
    {
      id: 'allow-tools-search',
      name: 'Allow tools:search',
      resource: 'tools:search',
      action: 'execute',
      scopes: ['tools:search'],
      result: 'allow',
      enabled: true,
    },
    {
      id: 'allow-admin-tenant-write',
      name: 'Allow tenant admin writes',
      resource: 'admin:tenant',
      action: 'write',
      scopes: ['admin:tenant:*'],
      result: 'allow',
      enabled: true,
    },
  ];

  tools.register(weaveTool({
    name: 'search_docs',
    description: 'Search internal docs.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    execute: async (args, invokeCtx) => {
      const auth = canExecute(readIdentityContext(invokeCtx), 'tools:search', 'execute', authRules);
      audit.push({ tool: 'search_docs', allowed: auth.allowed, reason: auth.reason });
      if (!auth.allowed) {
        return { content: `Denied search_docs: ${auth.reason}`, isError: true };
      }
      return `Found docs for query: ${(args as { query: string }).query}`;
    },
  }));

  tools.register(weaveTool({
    name: 'admin_delete_user',
    description: 'Delete a user from tenant directory.',
    parameters: {
      type: 'object',
      properties: { userId: { type: 'string' } },
      required: ['userId'],
    },
    execute: async (args, invokeCtx) => {
      const auth = canExecute(readIdentityContext(invokeCtx), 'admin:tenant', 'write', authRules);
      audit.push({ tool: 'admin_delete_user', allowed: auth.allowed, reason: auth.reason });
      if (!auth.allowed) {
        return { content: `Denied admin_delete_user: ${auth.reason}`, isError: true };
      }
      return `Deleted user ${(args as { userId: string }).userId}`;
    },
  }));

  const model = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          { id: 'call_1', function: { name: 'search_docs', arguments: '{"query":"rbac defaults"}' } },
        ],
      },
      {
        content: '',
        toolCalls: [
          { id: 'call_2', function: { name: 'admin_delete_user', arguments: '{"userId":"u-123"}' } },
        ],
      },
      {
        content: `Completed auth-aware tool run for ${persona}.`,
        toolCalls: [],
      },
    ],
  });

  const agent = weaveAgent({
    model,
    tools,
    bus,
    systemPrompt: 'Use tools to complete the task. Respect permission boundaries from execution context.',
    maxSteps: 6,
  });

  const result = await agent.run(ctx, {
    messages: [{ role: 'user', content: 'Find docs then delete user u-123.' }],
  });

  for (const row of audit) {
    console.log(`  ${row.tool}: ${row.allowed ? 'ALLOWED' : 'DENIED'} (${row.reason})`);
  }
  console.log(`  Agent output: ${result.output}`);

  assertScenario(persona, audit);
}

async function main(): Promise<void> {
  console.log('\n=== Authenticated Agent + Tools ===');
  await runScenario('tenant_user');
  await runScenario('tenant_admin');
  console.log('\nAll auth scenarios passed.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
