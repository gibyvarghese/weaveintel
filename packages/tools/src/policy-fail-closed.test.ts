/**
 * Fail-closed defaults for the tool policy layer (platform-architecture §7.4 items 1 and 2;
 * GAPS G-WI-8, G-WI-9).
 *
 * Before these fixes:
 *  - a tool with no `riskLevel` was treated as `read-only`, so an unlabelled write tool ran
 *    under the read-only default policy;
 *  - `requiresApproval` was silently ignored when no approval gate was wired.
 */
import { describe, expect, it } from 'vitest';
import { weaveContext, weaveTool, weaveToolRegistry, type Tool } from '@weaveintel/core';
import {
  assertToolRiskLevels,
  createPolicyEnforcedRegistry,
  createPolicyEnforcedTool,
  InMemoryToolPolicyResolver,
  ToolPolicyConfigError,
  ToolPolicyViolationError,
} from './policy.js';

function unlabelledWriteTool(calls: string[]): Tool {
  return weaveTool({
    name: 'delete_everything',
    description: 'An unlabelled tool that actually writes',
    parameters: { type: 'object', properties: {} },
    async execute() {
      calls.push('ran');
      return 'deleted';
    },
  });
}

describe('tool policy fails closed', () => {
  it('refuses to run a tool that declares no riskLevel (G-WI-8)', async () => {
    const calls: string[] = [];
    const enforced = createPolicyEnforcedTool(unlabelledWriteTool(calls), {
      resolver: new InMemoryToolPolicyResolver(),
    });
    await expect(
      enforced.invoke(weaveContext(), { name: 'delete_everything', arguments: {} }),
    ).rejects.toBeInstanceOf(ToolPolicyViolationError);
    expect(calls).toEqual([]);
  });

  it('refuses to build a registry that contains an unlabelled tool (G-WI-8)', () => {
    const reg = weaveToolRegistry();
    reg.register(unlabelledWriteTool([]));
    expect(() => createPolicyEnforcedRegistry(reg, { resolver: new InMemoryToolPolicyResolver() })).toThrow(
      ToolPolicyConfigError,
    );
    expect(() => assertToolRiskLevels(reg)).toThrow(/delete_everything/);
  });

  it('accepts a registry whose tools are all labelled', () => {
    const reg = weaveToolRegistry();
    reg.register(
      weaveTool({
        name: 'read_clock',
        description: 'read-only',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'read-only',
        async execute() {
          return 'noon';
        },
      }),
    );
    expect(() => assertToolRiskLevels(reg)).not.toThrow();
    expect(createPolicyEnforcedRegistry(reg, { resolver: new InMemoryToolPolicyResolver() }).list()).toHaveLength(1);
  });

  it('refuses to run when the policy requires approval and no gate is wired (G-WI-9)', async () => {
    const calls: string[] = [];
    const tool = weaveTool({
      name: 'send_mail',
      description: 'needs approval by policy',
      parameters: { type: 'object', properties: {} },
      riskLevel: 'read-only',
      async execute() {
        calls.push('ran');
        return 'sent';
      },
    });
    const enforced = createPolicyEnforcedTool(tool, {
      resolver: new InMemoryToolPolicyResolver(new Map([['send_mail', { requiresApproval: true }]])),
    });
    const err = await enforced
      .invoke(weaveContext(), { name: 'send_mail', arguments: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolPolicyViolationError);
    expect((err as ToolPolicyViolationError).reason).toBe('approval_required');
    expect(calls).toEqual([]);
  });

  it('honours a schema-level requiresApproval even when the policy row says false', async () => {
    const calls: string[] = [];
    const tool = weaveTool({
      name: 'wire_money',
      description: 'schema demands approval',
      parameters: { type: 'object', properties: {} },
      riskLevel: 'read-only',
      requiresApproval: true,
      async execute() {
        calls.push('ran');
        return 'ok';
      },
    });
    const enforced = createPolicyEnforcedTool(tool, {
      resolver: new InMemoryToolPolicyResolver(),
      approvalGate: { async check() { return { status: 'pending', approvalRequestId: 'apr_1' }; } },
    });
    await expect(enforced.invoke(weaveContext(), { name: 'wire_money', arguments: {} })).rejects.toThrow(
      /Approval pending: apr_1/,
    );
    expect(calls).toEqual([]);
  });

  it('refuses to build a registry with a requiresApproval tool and no gate (G-WI-9)', () => {
    const reg = weaveToolRegistry();
    reg.register(
      weaveTool({
        name: 'wire_money',
        description: 'schema demands approval',
        parameters: { type: 'object', properties: {} },
        riskLevel: 'financial',
        requiresApproval: true,
        async execute() {
          return 'ok';
        },
      }),
    );
    expect(() => createPolicyEnforcedRegistry(reg, { resolver: new InMemoryToolPolicyResolver() })).toThrow(
      /approval gate/,
    );
    expect(() =>
      createPolicyEnforcedRegistry(reg, {
        resolver: new InMemoryToolPolicyResolver(),
        approvalGate: { async check() { return { status: 'approved' }; } },
      }),
    ).not.toThrow();
  });

  it('runs when the gate approves', async () => {
    const tool = weaveTool({
      name: 'send_mail',
      description: 'approved',
      parameters: { type: 'object', properties: {} },
      riskLevel: 'read-only',
      async execute() {
        return 'sent';
      },
    });
    const enforced = createPolicyEnforcedTool(tool, {
      resolver: new InMemoryToolPolicyResolver(new Map([['send_mail', { requiresApproval: true }]])),
      approvalGate: { async check() { return { status: 'approved' }; } },
    });
    await expect(enforced.invoke(weaveContext(), { name: 'send_mail', arguments: {} })).resolves.toMatchObject({
      content: 'sent',
    });
  });
});
