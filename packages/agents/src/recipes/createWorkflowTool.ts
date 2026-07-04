/**
 * @weaveintel/agents/recipes — Workflow-as-tool adapter (W4)
 *
 * `weaveWorkflowTool` bridges the agent↔workflow gap in the direction that
 * was previously missing: an **agent calling a workflow as a tool**.
 *
 * The reverse direction (workflow calling an agent as a step handler via the
 * `agent:` handler resolver) already works out of the box — this adapter
 * completes the round-trip.
 *
 * Paused workflows (wait/human-task steps) return a resumable handle so the
 * calling agent is not blocked. The agent can surface the `runId` to the user
 * and the workflow can be resumed externally via `engine.resumeRun(runId, ...)`.
 *
 * Risk level: defaults to `'moderate'` so it passes through the host
 * application's six-stage tool policy gate for governed workflows. Lower-risk wrappers (e.g. for
 * read-only query workflows) can override to `'low'`.
 */

import type { WorkflowEngine, WorkflowRun, ExecutionContext } from '@weaveintel/core';
import { weaveTool, type ToolRiskLevel } from '@weaveintel/core';

export interface WorkflowToolOptions {
  /** The workflow engine that manages the target workflow. */
  engine: WorkflowEngine;
  /**
   * The workflow definition ID to start. Must be registered on the engine
   * before the tool is invoked.
   */
  workflowId: string;
  /** Tool name as shown to the model (e.g. `'run_validation_pipeline'`). */
  name: string;
  /** Short human-readable description of what the workflow does. */
  description: string;
  /**
   * JSON Schema describing the input the workflow accepts.
   * Passed verbatim as the tool's `parameters` schema. When omitted, the
   * tool accepts any object input.
   */
  inputSchema?: Record<string, unknown>;
  /**
   * Risk level for the host application's tool policy gate. Defaults to `'moderate'`.
   * Use `'low'` for read-only or low-impact workflows.
   */
  riskLevel?: ToolRiskLevel;
  /**
   * Tenant ID propagated to `engine.startRun` opts for multi-tenant engines.
   * When omitted, the run inherits the engine's default tenancy.
   */
  tenantId?: string;
}

const WORKFLOW_TOOL_DEFAULT_RISK: ToolRiskLevel = 'write';

export type WorkflowToolResult =
  | {
      status: 'completed';
      output: string;
      runId: string;
    }
  | {
      /** Workflow paused waiting for human input or an external event. */
      status: 'paused';
      runId: string;
      message: string;
    }
  | {
      status: 'failed';
      error: string;
      runId: string;
    };

function extractOutput(run: WorkflowRun): string {
  // Walk history in reverse to find the last completed step with string output.
  const history = [...(run.state.history ?? [])].reverse();
  for (const entry of history) {
    if (entry.status === 'completed' && entry.output !== undefined) {
      return typeof entry.output === 'string'
        ? entry.output
        : JSON.stringify(entry.output);
    }
  }
  return JSON.stringify(run.state.variables ?? {});
}

/**
 * Build a `weaveTool` that starts a workflow run and returns the result.
 *
 * For long-running workflows that will pause (wait/human-task steps), the
 * tool returns immediately with `{ status: 'paused', runId }` — the agent
 * can report this to the user and the workflow can be resumed later via
 * `engine.resumeRun(runId, decision)`.
 *
 * @example
 * const tool = weaveWorkflowTool({
 *   engine: myEngine,
 *   workflowId: 'hypothesis-validation',
 *   name: 'run_hypothesis_validation',
 *   description: 'Run the scientific hypothesis validation pipeline',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { hypothesis: { type: 'string' } },
 *     required: ['hypothesis'],
 *   },
 * });
 * const agent = weaveAgent({ model, tools: weaveToolRegistry([tool]) });
 */
export function weaveWorkflowTool(opts: WorkflowToolOptions): ReturnType<typeof weaveTool<Record<string, unknown>>> {
  const {
    engine,
    workflowId,
    name,
    description,
    inputSchema,
    riskLevel = WORKFLOW_TOOL_DEFAULT_RISK,
    tenantId,
  } = opts;

  return weaveTool<Record<string, unknown>>({
    name,
    description,
    parameters: inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
    riskLevel,

    async execute(args: Record<string, unknown>, _ctx: ExecutionContext): Promise<string> {
      let run: WorkflowRun;
      try {
        run = await engine.startRun(workflowId, args, { tenantId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const result: WorkflowToolResult = { status: 'failed', error: msg, runId: '' };
        return JSON.stringify(result);
      }

      if (run.status === 'paused') {
        const result: WorkflowToolResult = {
          status: 'paused',
          runId: run.id,
          message: `Workflow "${workflowId}" is paused and awaiting input. Use runId "${run.id}" to resume it.`,
        };
        return JSON.stringify(result);
      }

      if (run.status === 'failed' || run.status === 'cancelled') {
        const result: WorkflowToolResult = {
          status: 'failed',
          error: (run as unknown as { error?: string }).error ?? `Workflow ended with status: ${run.status}`,
          runId: run.id,
        };
        return JSON.stringify(result);
      }

      // Completed — extract last successful output
      const output = extractOutput(run);
      const result: WorkflowToolResult = { status: 'completed', output, runId: run.id };
      return JSON.stringify(result);
    },
  });
}
