/**
 * @weaveintel/core — Tool contracts
 *
 * Why: Tools are the primary extension mechanism for agents. A unified tool
 * interface lets tools come from local code, MCP servers, A2A agents, or
 * any other source — all through the same contract.
 */

import type { CapabilityId } from './capabilities.js';
import type { ExecutionContext } from './context.js';
import type { JsonSchema } from './models.js';
import { assertRuntimeRequires, type WeaveRuntime } from './runtime.js';
import type { ToolRiskLevel } from './tool-lifecycle.js';

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly returns?: JsonSchema;
  readonly requiresApproval?: boolean;
  readonly tags?: readonly string[];
  /** Declared risk level for this tool. Used by syncToolCatalog to populate tool_catalog. Defaults to 'read-only'. */
  readonly riskLevel?: ToolRiskLevel;
  /**
   * Cross-cutting runtime capabilities this tool needs (Phase 2). The
   * registry / runtime asserts these are present on the active
   * `WeaveRuntime` before the tool can be invoked. Use the ids exported
   * from `RuntimeCapabilities` (e.g. `'runtime.net.egress'`).
   */
  readonly requires?: readonly (CapabilityId | string)[];
}

export interface ToolInput {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface ToolOutput {
  readonly content: string;
  readonly isError?: boolean;
  readonly metadata?: Record<string, unknown>;
}

/** A tool that can be invoked */
export interface Tool {
  readonly schema: ToolSchema;
  invoke(ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput>;
}

/** Policy that decides whether a tool invocation is allowed */
export interface ToolPolicy {
  evaluate(
    ctx: ExecutionContext,
    tool: ToolSchema,
    input: ToolInput,
  ): Promise<PolicyDecision>;
}

export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly modified?: ToolInput;
}

/** Registry of available tools with capability queries */
export interface ToolRegistry {
  register(tool: Tool): void;
  unregister(name: string): void;
  get(name: string): Tool | undefined;
  list(): Tool[];
  listByTag(tag: string): Tool[];
  toDefinitions(): { name: string; description: string; parameters: JsonSchema }[];
}

export function createToolRegistry(opts?: {
  /**
   * Optional runtime used to assert `tool.schema.requires` at *registration*
   * time (Phase 3). If supplied, `register(tool)` throws immediately when
   * the runtime does not satisfy a tool's declared cross-cutting needs \u2014
   * surfacing the misconfiguration at boot rather than on the first
   * invocation hours later.
   */
  runtime?: WeaveRuntime;
}): ToolRegistry {
  const tools = new Map<string, Tool>();
  const runtime = opts?.runtime;

  return {
    register(tool: Tool): void {
      if (runtime && tool.schema.requires && tool.schema.requires.length > 0) {
        assertRuntimeRequires(runtime, tool.schema.requires, `tool:${tool.schema.name}`);
      }
      tools.set(tool.schema.name, tool);
    },
    unregister(name: string): void {
      tools.delete(name);
    },
    get(name: string): Tool | undefined {
      return tools.get(name);
    },
    list(): Tool[] {
      return [...tools.values()];
    },
    listByTag(tag: string): Tool[] {
      return [...tools.values()].filter((t) => t.schema.tags?.includes(tag));
    },
    toDefinitions() {
      return [...tools.values()].map((t) => ({
        name: t.schema.name,
        description: t.schema.description,
        parameters: t.schema.parameters,
      }));
    },
  };
}

/**
 * Helper to define a tool from a plain function.
 * This is the "small lines of code" API for tool creation.
 */
export function defineTool<TArgs extends Record<string, unknown>>(opts: {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: TArgs, ctx: ExecutionContext) => Promise<string | ToolOutput>;
  requiresApproval?: boolean;
  tags?: string[];
  riskLevel?: ToolRiskLevel;
  /**
   * Cross-cutting runtime capabilities this tool needs (Phase 2).
   * Use the ids exported from `RuntimeCapabilities`. The active runtime is
   * asserted to satisfy these before the tool invokes — there is no way to
   * silently bypass.
   */
  requires?: readonly (CapabilityId | string)[];
}): Tool {
  return {
    schema: {
      name: opts.name,
      description: opts.description,
      parameters: opts.parameters,
      requiresApproval: opts.requiresApproval,
      tags: opts.tags,
      riskLevel: opts.riskLevel,
      ...(opts.requires ? { requires: opts.requires } : {}),
    },
    async invoke(ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
      // Phase 2 capability gate: if the tool declares requires and an
      // ambient runtime is present on the context, assert satisfaction
      // before executing. When no runtime is present we trust the caller
      // (preserves zero-config DX for tests and tiny adopters).
      if (opts.requires && opts.requires.length > 0 && ctx.runtime) {
        ctx.runtime.require(...opts.requires.map((r) => (typeof r === 'string' ? (r as CapabilityId) : r)));
      }
      const result = await opts.execute(input.arguments as TArgs, ctx);
      if (typeof result === 'string') {
        return { content: result };
      }
      return result;
    },
  };
}
