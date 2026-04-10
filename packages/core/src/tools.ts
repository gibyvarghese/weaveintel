/**
 * @weaveintel/core — Tool contracts
 *
 * Why: Tools are the primary extension mechanism for agents. A unified tool
 * interface lets tools come from local code, MCP servers, A2A agents, or
 * any other source — all through the same contract.
 */

import type { ExecutionContext } from './context.js';
import type { JsonSchema } from './models.js';

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly returns?: JsonSchema;
  readonly requiresApproval?: boolean;
  readonly tags?: readonly string[];
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

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, Tool>();

  return {
    register(tool: Tool): void {
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
}): Tool {
  return {
    schema: {
      name: opts.name,
      description: opts.description,
      parameters: opts.parameters,
      requiresApproval: opts.requiresApproval,
      tags: opts.tags,
    },
    async invoke(ctx: ExecutionContext, input: ToolInput): Promise<ToolOutput> {
      const result = await opts.execute(input.arguments as TArgs, ctx);
      if (typeof result === 'string') {
        return { content: result };
      }
      return result;
    },
  };
}
