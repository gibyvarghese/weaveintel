/**
 * @weaveintel/workflows — resolvers.ts
 *
 * Built-in `HandlerResolver` implementations.
 *
 * Pure / dependency-free:
 *   - createNoopResolver()        kind="noop"        — does nothing, returns config
 *   - createScriptResolver()      kind="script"      — evaluates a JS expression
 *
 * Dependency-injected (apps wire these with their concrete adapters):
 *   - createToolResolver(deps)    kind="tool"        — looks up a tool by key
 *   - createPromptResolver(deps)  kind="prompt"      — renders + invokes a prompt
 *   - createAgentResolver(deps)   kind="agent"       — runs a registered agent
 *   - createMcpResolver(deps)     kind="mcp"         — calls an MCP method
 *   - createSubWorkflowResolver(deps) kind="subworkflow" — starts another workflow run
 *
 * The dependency-injected resolvers accept narrow structural interfaces so
 * the package never imports geneweave or service-shaped types.
 */
import type { HandlerResolver } from './handler-resolver.js';
import type { StepHandler } from './steps.js';

// ─── noop ───────────────────────────────────────────────────────────

export function createNoopResolver(): HandlerResolver {
  return {
    kind: 'noop',
    description: 'No-op step. Returns its `config` as the output. Useful as a placeholder.',
    async resolve(ctx) {
      return async () => ctx.config;
    },
  };
}

// ─── script ─────────────────────────────────────────────────────────

/**
 * Script resolver — evaluates a JS expression with access to `variables` and
 * `config`. The script source comes from one of:
 *   - `step.config.script`   (preferred)
 *   - `ctx.ref`              (after the `script:` prefix; e.g. `'script:return variables.x * 2'`)
 *
 * Restrictions: runs inside a `new Function(...)` with no access to globals
 * other than what JavaScript provides natively (Math, Date, JSON, parseInt,
 * etc.). No `require`, no `process`, no `fetch`. This is in-process — for
 * untrusted scripts use a real sandbox (`@weaveintel/sandbox`).
 */
export function createScriptResolver(): HandlerResolver {
  return {
    kind: 'script',
    description:
      'Inline JS expression. The script body has access to `variables` and `config` and must `return` a value. Trusted operators only.',
    configSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript body. Must return a value.' },
      },
    },
    async resolve(ctx) {
      const source =
        (ctx.config['script'] as string | undefined)?.trim() ||
        ctx.ref.trim();
      if (!source) {
        throw new Error(`script resolver: no script body for step "${ctx.stepId}"`);
      }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const fn = new Function('variables', 'config', `"use strict"; ${source}`);
      const handler: StepHandler = async (variables, config) => fn(variables, config);
      return handler;
    },
  };
}

// ─── tool ───────────────────────────────────────────────────────────

export interface ToolResolverDeps {
  /**
   * Look up a tool implementation by key. Returns an async function that
   * accepts the resolved input object and returns a result. The package
   * does not import `@weaveintel/tools` directly so any registry shape works.
   */
  getTool(toolKey: string): Promise<((input: Record<string, unknown>) => Promise<unknown>) | undefined>;
}

export function createToolResolver(deps: ToolResolverDeps): HandlerResolver {
  return {
    kind: 'tool',
    description:
      'Invoke a tool from the tool registry. Reference syntax: `tool:<toolKey>`. The handler input is forwarded as the tool input.',
    async resolve(ctx) {
      const toolKey = ctx.ref;
      if (!toolKey) throw new Error(`tool resolver: missing tool key in step "${ctx.stepId}"`);
      const tool = await deps.getTool(toolKey);
      if (!tool) throw new Error(`tool resolver: no tool registered for key "${toolKey}"`);
      const handler: StepHandler = async (variables) => tool(variables);
      return handler;
    },
  };
}

// ─── prompt ─────────────────────────────────────────────────────────

export interface PromptResolverDeps {
  /**
   * Execute a prompt by key (optionally with a `@version` suffix in the key
   * itself). Returns the model output payload.
   */
  executePrompt(
    promptKey: string,
    variables: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<unknown>;
}

export function createPromptResolver(deps: PromptResolverDeps): HandlerResolver {
  return {
    kind: 'prompt',
    description:
      'Execute a managed prompt from the prompt registry. Reference syntax: `prompt:<promptKey>` or `prompt:<promptKey>@<version>`.',
    async resolve(ctx) {
      const promptKey = ctx.ref;
      if (!promptKey) throw new Error(`prompt resolver: missing prompt key in step "${ctx.stepId}"`);
      const handler: StepHandler = async (variables, config) =>
        deps.executePrompt(promptKey, variables, config ?? {});
      return handler;
    },
  };
}

// ─── agent ──────────────────────────────────────────────────────────

export interface AgentResolverDeps {
  /**
   * Invoke an agent by key. Returns the final response from the agent loop.
   */
  invokeAgent(
    agentKey: string,
    variables: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<unknown>;
}

export function createAgentResolver(deps: AgentResolverDeps): HandlerResolver {
  return {
    kind: 'agent',
    description:
      'Run an agent from the agent registry. Reference syntax: `agent:<agentKey>`. The handler input is forwarded as the agent task input.',
    async resolve(ctx) {
      const agentKey = ctx.ref;
      if (!agentKey) throw new Error(`agent resolver: missing agent key in step "${ctx.stepId}"`);
      const handler: StepHandler = async (variables, config) =>
        deps.invokeAgent(agentKey, variables, config ?? {});
      return handler;
    },
  };
}

// ─── mcp ────────────────────────────────────────────────────────────

export interface McpResolverDeps {
  /**
   * Call a method on a connected MCP server. Reference syntax expects
   * `mcp:<serverKey>:<method>` so `ctx.ref` will be `<serverKey>:<method>`.
   */
  callMcp(
    serverKey: string,
    method: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}

export function createMcpResolver(deps: McpResolverDeps): HandlerResolver {
  return {
    kind: 'mcp',
    description:
      'Call a method on an MCP server. Reference syntax: `mcp:<serverKey>:<method>`. The handler input is forwarded as the method input.',
    async resolve(ctx) {
      const colonAt = ctx.ref.indexOf(':');
      if (colonAt < 0) {
        throw new Error(
          `mcp resolver: reference for step "${ctx.stepId}" must be "<serverKey>:<method>", got "${ctx.ref}"`,
        );
      }
      const serverKey = ctx.ref.slice(0, colonAt);
      const method = ctx.ref.slice(colonAt + 1);
      const handler: StepHandler = async (variables) => deps.callMcp(serverKey, method, variables);
      return handler;
    },
  };
}

// ─── subworkflow ────────────────────────────────────────────────────

export interface SubWorkflowResolverDeps {
  /**
   * Look up the workflow id (PK) for a workflow key (operator-friendly slug).
   * Allows admins to author `subworkflow:my-flow-key` while the engine works
   * with internal ids. Return the input string unchanged when there is no
   * separate key/id distinction.
   */
  resolveWorkflowKey(workflowKey: string): Promise<string | undefined>;
  /** Start a workflow run by id. Returns the new run record. */
  startRun(workflowId: string, input?: Record<string, unknown>): Promise<unknown>;
}

export function createSubWorkflowResolver(deps: SubWorkflowResolverDeps): HandlerResolver {
  return {
    kind: 'subworkflow',
    description:
      'Start another workflow as a child run. Reference syntax: `subworkflow:<workflowKey>`. The handler input is passed as the child run input.',
    async resolve(ctx) {
      const workflowKey = ctx.ref;
      if (!workflowKey) {
        throw new Error(`subworkflow resolver: missing workflow key in step "${ctx.stepId}"`);
      }
      const handler: StepHandler = async (variables) => {
        const workflowId = (await deps.resolveWorkflowKey(workflowKey)) ?? workflowKey;
        return deps.startRun(workflowId, variables);
      };
      return handler;
    },
  };
}

/**
 * Convenience: build a resolver registry pre-populated with the dependency-
 * free resolvers (`noop`, `script`). Apps add the rest via `register(...)`.
 */
export function createDefaultResolvers(): HandlerResolver[] {
  return [createNoopResolver(), createScriptResolver()];
}
