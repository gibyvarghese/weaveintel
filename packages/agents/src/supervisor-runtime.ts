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
  /** Worker agents the supervisor can delegate to. Required. */
  workers: WorkerDefinition[];
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
}

export interface SupervisorRuntime {
  tools: ToolRegistry;
  systemPrompt: string;
  workersConfig: Record<string, AgentConfig>;
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

  // Build worker agents up-front
  const workersMap = new Map<string, Agent>();
  for (const w of workers) {
    workersMap.set(w.name, buildWorkerAgent(w, bus));
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

  // Merge caller's additional tools BEFORE delegate_to_worker so they appear earlier.
  if (additionalTools) {
    for (const tool of additionalTools.list()) {
      tools.register(tool);
    }
  }

  // delegate_to_worker — the core supervisor capability
  tools.register(weaveTool<{ worker: string; goal: string }>({
    name: 'delegate_to_worker',
    description: `Delegate a task to a worker agent. Available workers: ${[...workersMap.keys()].join(', ')}. Each worker has specialized capabilities. Describe the goal clearly. IMPORTANT: Do NOT use this for tasks that can be handled by an available tool (including MCP-wrapped tools like cse_run_code).`,
    parameters: {
      type: 'object',
      properties: {
        worker: {
          type: 'string',
          description: `Name of the worker to delegate to. One of: ${[...workersMap.keys()].join(', ')}`,
          enum: [...workersMap.keys()],
        },
        goal: { type: 'string', description: 'Clear description of what the worker should accomplish' },
      },
      required: ['worker', 'goal'],
    },
    async execute(args, ctx) {
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

      const worker = workersMap.get(args.worker);
      if (!worker) {
        return `Error: Worker "${args.worker}" not found. Available: ${[...workersMap.keys()].join(', ')}`;
      }

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

  // Compose the supervisor instruction prompt
  const directToolNames = additionalTools?.list().map((t) => t.schema.name) ?? [];
  const directToolSection = directToolNames.length > 0
    ? [
        '',
        '## Available Tools (direct or MCP-wrapped — call these yourself when applicable):',
        directToolNames.map((n) => `- \`${n}\``).join('\n'),
        'When a task can be accomplished with a tool above, call it yourself instead of delegating.',
      ].join('\n')
    : '';

  const workerDescriptions = workers
    .map((w) => `- **${w.name}**: ${w.description ?? 'No description'}`)
    .join('\n');

  const systemPrompt = [
    baseInstructions ?? 'You are a supervisor that delegates work to specialized workers.',
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
    workers.map((w) => [w.name, { name: w.name, instructions: w.systemPrompt }]),
  );

  return { tools, systemPrompt, workersConfig };
}

/** Optional helper kept for back-compat with packages that referenced the type. */
export type { AgentMemory, ExecutionContext };
