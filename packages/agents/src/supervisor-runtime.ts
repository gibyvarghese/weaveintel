/**
 * @weaveintel/agents — Supervisor runtime helpers
 *
 * Builds the tool registry, system prompt, and worker map used when
 * `weaveAgent({ workers: [...] })` is invoked in supervisor mode. The
 * legacy `weaveSupervisor()` is now a thin alias that delegates here.
 */

import type {
  Agent,
  AgentConfig,
  AgentMemory,
  AgentPolicy,
  DelegationRequest,
  DelegationResult,
  EventBus,
  ExecutionContext,
  Model,
  ToolRegistry,
} from '@weaveintel/core';
import {
  EventTypes,
  weaveChildContext,
  weaveEvent,
  weaveTool,
  weaveToolRegistry,
} from '@weaveintel/core';
import { buildSupervisorUtilityTools } from './supervisor-tools.js';
import type { WorkerRegistry } from './worker-registry.js';

export type { WorkerRegistry };

export interface WorkerDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  model: Model;
  tools?: ToolRegistry;
}

export interface SupervisorRuntimeOptions {
  /** Display name for the supervisor (used in events and child contexts). */
  supervisorName: string;
  /** Optional system instructions authored by the caller (prepended). */
  baseInstructions?: string;
  /**
   * Static list of workers built at construction time.
   * Use `workerRegistry` instead when workers need to change at runtime.
   */
  workers: WorkerDefinition[];
  /**
   * P5-2 — Dynamic worker registry.
   * When provided, the `delegate_to_worker` tool queries this registry at call
   * time so workers can be registered/unregistered without rebuilding the
   * supervisor. Replaces `workers` for runtime lookups; `workers` is still
   * used only to compose the initial system prompt.
   */
  workerRegistry?: WorkerRegistry;
  /**
   * Function used to build a worker as a `weaveAgent`. Passed in to avoid a
   * circular import with `agent.ts`.
   */
  buildWorkerAgent: (worker: WorkerDefinition, bus?: EventBus) => Agent;
  /** Maximum number of delegations before the gate fails. */
  maxDelegations: number;
  /** Optional shared bus for events/observability. */
  bus?: EventBus;
  /** Optional policy controlling delegation approval. */
  policy?: AgentPolicy;
  /** Tools the supervisor can call directly (e.g. CSE / MCP tools). */
  additionalTools?: ToolRegistry;
  /** Tool names treated as CSE code-execution endpoints. */
  cseCodeToolNames?: string[];
  /**
   * When true (default), the supervisor automatically gets pure utility tools:
   * `datetime`, `math_eval`, `unit_convert`. These are deterministic, network-
   * free, and safe at the supervisor level. Set to false to opt out.
   */
  includeUtilityTools?: boolean;
  /** Default timezone passed to the `datetime` utility tool. */
  defaultTimezone?: string;
  /**
   * W3 — Re-plan on failure: when a delegated worker returns a failed/empty
   * result, inject an explicit re-plan instruction back into the supervisor's
   * conversation so it can revise its plan and re-delegate. When false (default),
   * the raw failure result is surfaced to the supervisor without special handling.
   */
  replanOnFailure?: boolean;
  /**
   * W3 — Parallel delegation: registers a `delegate_to_workers_parallel` batch
   * tool that dispatches multiple sub-tasks concurrently via `Promise.all`.
   * Results are aggregated and returned together. When false (default), only
   * the sequential `delegate_to_worker` tool is available.
   */
  parallelDelegation?: boolean;
}

export interface SupervisorRuntime {
  tools: ToolRegistry;
  systemPrompt: string;
  workersConfig: Record<string, AgentConfig>;
  /**
   * Reset per-run mutable state so that a single supervisor instance can be
   * invoked across multiple `run()` calls without carrying over delegation
   * counts or thinking logs from a previous invocation.
   *
   * Must be called at the start of every `weaveAgent.run()` / `runStream()`.
   */
  reset(): void;
}

/**
 * Build the supervisor's tool registry + composed instructions. The returned
 * `tools` registry contains: `think`, `plan`, any caller-provided
 * `additionalTools`, then `delegate_to_worker`. Order matters — the model
 * sees direct tools before the delegation tool and prefers them.
 */
export function buildSupervisorRuntime(opts: SupervisorRuntimeOptions): SupervisorRuntime {
  const {
    supervisorName,
    baseInstructions,
    workers,
    buildWorkerAgent,
    maxDelegations,
    bus,
    policy,
    additionalTools,
  } = opts;
  const cseCodeToolNames = opts.cseCodeToolNames ?? ['cse_run_code', 'cse.run_code'];

  // P5-2: Dynamic registry takes precedence for runtime lookups; static map
  // is built from the initial workers list only when no registry is provided.
  const workerRegistry = opts.workerRegistry;

  // Agent instance cache — built lazily so runtime-registered workers can
  // also be discovered on first delegation without recreating the supervisor.
  const agentCache = new Map<string, Agent>();

  function resolveAgent(def: WorkerDefinition): Agent {
    if (!agentCache.has(def.name)) {
      agentCache.set(def.name, buildWorkerAgent(def, bus));
    }
    return agentCache.get(def.name)!;
  }

  // Build static worker agents up-front (only when no dynamic registry).
  if (!workerRegistry) {
    for (const w of workers) {
      agentCache.set(w.name, buildWorkerAgent(w, bus));
    }
  }

  const delegationResults: DelegationResult[] = [];
  const thinkingLog: Array<{ phase: string; thought: string }> = [];

  const tools = weaveToolRegistry();

  // think — explicit chain-of-thought
  tools.register(weaveTool<{ thought: string; reasoning_phase?: 'planning' | 'analysis' | 'reasoning' | 'synthesis' }>({
    name: 'think',
    description: 'Use this tool to reason through the problem step-by-step. Write your thinking process before delegating or responding. Supports planning phase, analysis of requirements, reasoning about results, or synthesis of findings.',
    parameters: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your explicit chain-of-thought reasoning. Be thorough and articulate your logic.' },
        reasoning_phase: {
          type: 'string',
          enum: ['planning', 'analysis', 'reasoning', 'synthesis'],
          description: 'The phase of reasoning: planning (initial approach), analysis (understanding requirements), reasoning (connecting results), synthesis (formulating response)',
        },
      },
      required: ['thought'],
    },
    async execute(args) {
      const phase = args.reasoning_phase ?? 'analysis';
      thinkingLog.push({ phase, thought: args.thought });
      return `[${phase.toUpperCase()}] Logged: ${args.thought}`;
    },
  }));

  // Supervisor-safe utility tools (datetime, math_eval, unit_convert).
  // Registered after think/plan so the model sees reasoning tools first,
  // then quick deterministic helpers, then any caller-provided extras,
  // and finally `delegate_to_worker` as the fallback.
  // plan — explicit problem decomposition
  tools.register(weaveTool<{ objective: string; approach: string; workers_needed: string; blockers?: string }>({
    name: 'plan',
    description: 'Create an explicit plan before delegating work. Decompose the problem, identify which workers you need, and state any blockers.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'Clear restatement of what you need to accomplish' },
        approach: { type: 'string', description: 'Your strategy: what steps will you take? What information do you need?' },
        workers_needed: { type: 'string', description: 'Which workers do you plan to delegate to, and why each one?' },
        blockers: { type: 'string', description: 'Any potential issues or unknowns you need to address' },
      },
      required: ['objective', 'approach', 'workers_needed'],
    },
    async execute(args) {
      const plan = `PLAN:\nObjective: ${args.objective}\nApproach: ${args.approach}\nWorkers: ${args.workers_needed}${args.blockers ? `\nBlockers: ${args.blockers}` : ''}`;
      thinkingLog.push({ phase: 'planning', thought: plan });
      return plan;
    },
  }));

  // Supervisor-safe utility tools (datetime, math_eval, unit_convert).
  // Pure, deterministic helpers — registered after think/plan, before any
  // caller-provided additionalTools and before delegate_to_worker.
  if (opts.includeUtilityTools !== false) {
    for (const utilityTool of buildSupervisorUtilityTools({ defaultTimezone: opts.defaultTimezone })) {
      tools.register(utilityTool);
    }
  }

  // Merge caller's additional tools BEFORE delegate_to_worker so they appear earlier.
  if (additionalTools) {
    for (const tool of additionalTools.list()) {
      tools.register(tool);
    }
  }

  // P5-2: For dynamic registries, omit the fixed `enum` so the tool description
  // stays valid even as workers change. The description lists current workers
  // at construction time but delegates look up the live list at call time.
  const initialWorkerNames = workerRegistry
    ? workerRegistry.list().map((w) => w.name)
    : workers.map((w) => w.name);
  const workerEnumProps: Record<string, unknown> = initialWorkerNames.length > 0 && !workerRegistry
    ? { enum: initialWorkerNames }
    : {};

  // delegate_to_worker — the core supervisor capability
  tools.register(weaveTool<{ worker: string; goal: string }>({
    name: 'delegate_to_worker',
    description: `Delegate a task to a worker agent. Available workers: ${initialWorkerNames.join(', ')}. Each worker has specialized capabilities. Describe the goal clearly. IMPORTANT: Do NOT use this for tasks that can be handled by an available tool (including MCP-wrapped tools like cse_run_code).`,
    parameters: {
      type: 'object',
      properties: {
        worker: {
          type: 'string',
          description: `Name of the worker to delegate to. Currently registered workers: ${initialWorkerNames.join(', ')}`,
          ...workerEnumProps,
        },
        goal: { type: 'string', description: 'Clear description of what the worker should accomplish' },
      },
      required: ['worker', 'goal'],
    },
    async execute(args, ctx) {
      // P5-2: Resolve worker from registry (dynamic) or static cache.
      const currentWorkers = workerRegistry ? workerRegistry.list() : workers;
      const currentWorkerNames = currentWorkers.map((w) => w.name);

      // Auto-redirect code execution goals to a CSE tool when one is available.
      const cseRunCode = additionalTools?.list().find((t) => cseCodeToolNames.includes(t.schema.name));
      if (cseRunCode) {
        const codeBlockMatch = args.goal.match(/```[\w]*\n([\s\S]*?)```/);
        const inlineCodeMatch = args.goal.match(/`([^`]{20,})`/);
        const executionKeyword = /\b(run|execute|print\(|console\.log|import |def |class |echo |bash|python|javascript|typescript)\b/i.test(args.goal);
        if (executionKeyword && (codeBlockMatch || inlineCodeMatch)) {
          const code = codeBlockMatch?.[1] ?? inlineCodeMatch?.[1] ?? args.goal;
          const lang = args.goal.match(/```(\w+)/)?.[1] ?? 'python';
          const output = await cseRunCode.invoke(ctx, {
            name: cseRunCode.schema.name,
            arguments: { code, language: lang, chatId: ctx.metadata['chatId'] },
          });
          return output.content;
        }
      }

      const workerDef = workerRegistry
        ? workerRegistry.get(args.worker)
        : workers.find((w) => w.name === args.worker);

      if (!workerDef) {
        return `Error: Worker "${args.worker}" not found. Available: ${currentWorkerNames.join(', ')}`;
      }

      const worker = resolveAgent(workerDef);

      if (delegationResults.length >= maxDelegations) {
        return 'Error: Maximum number of delegations reached.';
      }

      if (policy?.approveDelegation) {
        const req: DelegationRequest = { targetAgent: args.worker, goal: args.goal };
        const decision = await policy.approveDelegation(ctx, req);
        if (!decision.approved) {
          return `Delegation denied: ${decision.reason ?? 'no reason'}`;
        }
      }

      bus?.emit(weaveEvent(EventTypes.AgentDelegation, {
        supervisor: supervisorName,
        worker: args.worker,
        goal: args.goal,
      }, ctx));

      const delegateStart = Date.now();
      const childCtx = weaveChildContext(ctx, {
        metadata: { delegatedBy: supervisorName, delegatedTo: args.worker },
      });

      const result = await worker.run(childCtx, {
        messages: [{ role: 'user', content: args.goal }],
        goal: args.goal,
      });

      delegationResults.push({
        agent: args.worker,
        result,
        durationMs: Date.now() - delegateStart,
      });

      const baseOutput = result.output || '(Worker returned no output)';

      // W3 — Re-plan on failure: if the worker failed or returned empty output,
      // surface a structured failure signal so the supervisor knows to revise.
      const workerFailed = result.status === 'failed' || result.status === 'cancelled' || !result.output;
      if (opts.replanOnFailure && workerFailed) {
        bus?.emit(weaveEvent(EventTypes.AgentDelegation, {
          supervisor: supervisorName,
          worker: args.worker,
          goal: args.goal,
          outcome: 'failed',
        }, ctx));
        return [
          `[WORKER_FAILED] Worker "${args.worker}" could not complete the task.`,
          `Status: ${result.status}`,
          `Output: ${baseOutput}`,
          '',
          'REPLAN_REQUIRED: Please revise your plan. Consider a different approach, a different worker, or breaking the task into smaller sub-tasks.',
        ].join('\n');
      }

      const workerToolTrace = result.steps
        .filter((s) => s.type === 'tool_call' && s.toolCall?.name)
        .map((s) => ({
          name: s.toolCall?.name,
          arguments: s.toolCall?.arguments,
          result: s.toolCall?.result,
          durationMs: s.durationMs,
        }));

      if (workerToolTrace.length === 0) {
        return baseOutput;
      }

      return `${baseOutput}\n\n[WorkerToolTrace]\n${JSON.stringify(workerToolTrace)}`;
    },
  }));

  // W3 — Parallel fan-out tool (only registered when parallelDelegation is enabled)
  if (opts.parallelDelegation) {
    tools.register(weaveTool<{ tasks: Array<{ worker: string; goal: string }> }>({
      name: 'delegate_to_workers_parallel',
      description: `Dispatch multiple independent sub-tasks to workers concurrently. All tasks run in parallel via Promise.all and results are returned together. Use this when tasks are independent and can be done simultaneously. Available workers: ${initialWorkerNames.join(', ')}.`,
      parameters: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            description: 'Array of { worker, goal } pairs to dispatch concurrently.',
            items: {
              type: 'object',
              properties: {
                worker: { type: 'string', ...workerEnumProps, description: 'Worker name' },
                goal: { type: 'string', description: 'Task description for this worker' },
              },
              required: ['worker', 'goal'],
            },
          },
        },
        required: ['tasks'],
      },
      async execute(args, ctx) {
        if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
          return 'Error: tasks array must be non-empty.';
        }
        if (delegationResults.length + args.tasks.length > maxDelegations) {
          return `Error: Parallel dispatch of ${args.tasks.length} tasks would exceed maxDelegations (${maxDelegations}).`;
        }

        const results = await Promise.all(args.tasks.map(async (task) => {
          // P5-2: Live registry lookup for parallel delegation too.
          const def = workerRegistry
            ? workerRegistry.get(task.worker)
            : workers.find((w) => w.name === task.worker);
          if (!def) {
            const avail = (workerRegistry ? workerRegistry.list() : workers).map((w) => w.name).join(', ');
            return { worker: task.worker, goal: task.goal, output: `Error: Worker "${task.worker}" not found. Available: ${avail}`, status: 'failed' };
          }
          const w = resolveAgent(def);
          const childCtx = weaveChildContext(ctx, { metadata: { delegatedBy: supervisorName, delegatedTo: task.worker, parallel: true } });
          const delegateStart = Date.now();
          bus?.emit(weaveEvent(EventTypes.AgentDelegation, { supervisor: supervisorName, worker: task.worker, goal: task.goal, parallel: true }, ctx));
          try {
            const result = await w.run(childCtx, { messages: [{ role: 'user', content: task.goal }], goal: task.goal });
            delegationResults.push({ agent: task.worker, result, durationMs: Date.now() - delegateStart });
            const failed = result.status === 'failed' || result.status === 'cancelled' || !result.output;
            const output = opts.replanOnFailure && failed
              ? `[WORKER_FAILED] ${task.worker}: ${result.output || 'no output'} — REPLAN_REQUIRED`
              : (result.output || '(no output)');
            return { worker: task.worker, goal: task.goal, output, status: result.status };
          } catch (err) {
            return { worker: task.worker, goal: task.goal, output: `Error: ${err instanceof Error ? err.message : String(err)}`, status: 'failed' };
          }
        }));

        return results.map(r => `[${r.worker}] ${r.output}`).join('\n\n---\n\n');
      },
    }));
  }

  // Compose the supervisor instruction prompt.
  // The utility section lists supervisor-safe pure helpers (datetime, math_eval,
  // unit_convert) so the model knows it can answer simple time/math/unit
  // questions without delegating.
  const utilitySection = opts.includeUtilityTools !== false
    ? [
        '',
        '## Supervisor Utility Tools (call directly — pure, fast, no I/O):',
        '- `datetime` — current date/time, formats: iso, unix, unix_ms, date, time, weekday, rfc2822',
        '- `math_eval` — arithmetic expressions (+ - * / ** % parens)',
        '- `unit_convert` — length, mass, volume, time, temperature conversions',
      ].join('\n')
    : '';

  const directToolNames = additionalTools?.list().map((t) => t.schema.name) ?? [];
  const directToolSection = directToolNames.length > 0
    ? [
        '',
        '## Additional Direct Tools (call these yourself when applicable):',
        directToolNames.map((n) => `- \`${n}\``).join('\n'),
        'When a task can be accomplished with a tool above, call it yourself instead of delegating.',
      ].join('\n')
    : '';

  const initialWorkerList = workerRegistry ? workerRegistry.list() : workers;
  const workerDescriptions = initialWorkerList
    .map((w) => `- **${w.name}**: ${w.description ?? 'No description'}`)
    .join('\n');

  const systemPrompt = [
    baseInstructions ?? 'You are a supervisor that delegates work to specialized workers.',
    utilitySection,
    directToolSection,
    '',
    '## Available Workers:',
    workerDescriptions,
    '',
    '## Your Workflow (CRITICAL - FOLLOW STRICTLY):',
    '',
    '### PHASE 1: UNDERSTANDING & PLANNING',
    '1. First, use the `think` tool with reasoning_phase="planning" to analyze the user request:',
    '   - What is the user actually asking for?',
    '   - Can I fulfill this directly with an available tool listed above (e.g. cse_run_code for CSE execution)?',
    '   - If yes → skip delegation, call the direct tool yourself in Phase 2.',
    '   - If no → which workers are qualified to handle this?',
    '2. Use the `plan` tool to create an explicit decomposition.',
    '',
    '### PHASE 2: DIRECT TOOL CALLS OR DELEGATION',
    '3a. If an available tool can handle the task: call it directly (e.g. `cse_run_code` to execute code).',
    '3b. Otherwise, delegate to workers using `delegate_to_worker`.',
    '',
    '### PHASE 3: ANALYSIS & REASONING',
    '4. After receiving results, use the `think` tool with reasoning_phase="reasoning":',
    '   - Did the results answer the question?',
    '   - Are there gaps or inconsistencies?',
    '',
    '### PHASE 4: SYNTHESIS & RESPONSE',
    '5. Use the `think` tool with reasoning_phase="synthesis" before responding.',
    '',
    '## CRITICAL RULES:',
    '- NEVER skip the planning phase. Always use `plan` before acting.',
    '- NEVER fire-and-forget. Always reason about results before responding.',
    '- ALWAYS use `think` with the appropriate reasoning_phase.',
    '- If an available tool can handle the task, YOU MUST call it yourself. Do NOT call delegate_to_worker.',
    '- NEVER call `delegate_to_worker` for code execution when a CSE code tool (for example cse_run_code) is available.',
  ].join('\n');

  const workersConfig: Record<string, AgentConfig> = Object.fromEntries(
    initialWorkerList.map((w) => [w.name, { name: w.name, instructions: w.systemPrompt }]),
  );

  return {
    tools,
    systemPrompt,
    workersConfig,
    reset() {
      delegationResults.length = 0;
      thinkingLog.length = 0;
    },
  };
}

/** Optional helper kept for back-compat with packages that referenced the type. */
export type { AgentMemory, ExecutionContext };
