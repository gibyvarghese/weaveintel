/**
 * @weaveintel/agents — Supervisor agent (hierarchical delegation)
 *
 * A supervisor agent can delegate tasks to worker agents. The supervisor
 * decides which worker to use based on the delegation strategy (model-decided,
 * capability-match, or round-robin). Worker results are aggregated back.
 *
 * This enables multi-agent workflows: a planner that breaks work into
 * subtasks, each handled by a specialized worker agent.
 */

import type {
  Agent,
  AgentConfig,
  AgentInput,
  AgentResult,
  AgentStep,
  AgentStepEvent,
  AgentUsage,
  AgentPolicy,
  SupervisorConfig,
  DelegationRequest,
  DelegationResult,
  Model,
  ToolRegistry,
  ExecutionContext,
  EventBus,
  AgentMemory,
} from '@weaveintel/core';
import {
  WeaveIntelError,
  isExpired,
  weaveChildContext,
  weaveEvent,
  EventTypes,
  weaveTool,
  weaveToolRegistry,
} from '@weaveintel/core';
import { weaveAgent } from './agent.js';

export interface WorkerDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  model: Model;
  tools?: ToolRegistry;
}

export interface SupervisorOptions {
  /** Model the supervisor uses for reasoning / delegation */
  model: Model;
  /** Event bus for observability */
  bus?: EventBus;
  /** Worker agent definitions */
  workers: WorkerDefinition[];
  /** Maximum supervisor steps */
  maxSteps?: number;
  /** Policy */
  policy?: AgentPolicy;
  /** Memory */
  memory?: AgentMemory;
  /** Name */
  name?: string;
  /** Optional system instructions for the supervisor itself */
  instructions?: string;
  /** Additional tools the supervisor can call directly (e.g. CSE execution tools) */
  additionalTools?: ToolRegistry;
  /** Tool names considered CSE code execution endpoints (direct or MCP-wrapped). */
  cseCodeToolNames?: string[];
}

export function weaveSupervisor(opts: SupervisorOptions): Agent {
  const eventBus = opts.bus;
  const { model, policy, memory } = opts;
  const maxDelegations = (opts.maxSteps ?? 10);

  const config: SupervisorConfig = {
    name: opts.name ?? 'supervisor',
    instructions: opts.instructions,
    maxSteps: opts.maxSteps ?? 30,
    maxDelegations,
    workers: Object.fromEntries(
      opts.workers.map((w) => [w.name, { name: w.name, description: w.description }]),
    ),
  };
  const cseCodeToolNames = opts.cseCodeToolNames ?? ['cse_run_code', 'cse.run_code'];

  // Build worker agents
  const workers = new Map<string, Agent>();
  for (const w of opts.workers) {
    workers.set(w.name, weaveAgent({
      name: w.name,
      model: w.model,
      systemPrompt: w.systemPrompt,
      tools: w.tools,
      bus: eventBus,
    }));
  }

  // Create tools that the supervisor model can call
  const delegationResults: DelegationResult[] = [];
  const thinkingLog: Array<{ phase: string; thought: string }> = [];

  const supervisorTools = weaveToolRegistry();

  // Add a "think" tool for explicit reasoning and chain-of-thought
  supervisorTools.register(weaveTool<{ thought: string; reasoning_phase?: 'planning' | 'analysis' | 'reasoning' | 'synthesis' }>({
    name: 'think',
    description: 'Use this tool to reason through the problem step-by-step. Write your thinking process before delegating or responding. Supports planning phase, analysis of requirements, reasoning about results, or synthesis of findings.',
    parameters: {
      type: 'object',
      properties: {
        thought: {
          type: 'string',
          description: 'Your explicit chain-of-thought reasoning. Be thorough and articulate your logic.',
        },
        reasoning_phase: {
          type: 'string',
          enum: ['planning', 'analysis', 'reasoning', 'synthesis'],
          description: 'The phase of reasoning: planning (initial approach), analysis (understanding requirements), reasoning (connecting results), synthesis (formulating response)',
        },
      },
      required: ['thought'],
    },
    async execute(args, ctx) {
      const phase = args.reasoning_phase ?? 'analysis';
      thinkingLog.push({ phase, thought: args.thought });
      return `[${phase.toUpperCase()}] Logged: ${args.thought}`;
    },
  }));

  // Add a "plan" tool for explicit problem decomposition
  supervisorTools.register(weaveTool<{ objective: string; approach: string; workers_needed: string; blockers?: string }>({
    name: 'plan',
    description: 'Create an explicit plan before delegating work. Decompose the problem, identify which workers you need, and state any blockers.',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'Clear restatement of what you need to accomplish',
        },
        approach: {
          type: 'string',
          description: 'Your strategy: what steps will you take? What information do you need?',
        },
        workers_needed: {
          type: 'string',
          description: 'Which workers do you plan to delegate to, and why each one?',
        },
        blockers: {
          type: 'string',
          description: 'Any potential issues or unknowns you need to address',
        },
      },
      required: ['objective', 'approach', 'workers_needed'],
    },
    async execute(args, ctx) {
      const plan = `PLAN:\nObjective: ${args.objective}\nApproach: ${args.approach}\nWorkers: ${args.workers_needed}${args.blockers ? `\nBlockers: ${args.blockers}` : ''}`;
      thinkingLog.push({ phase: 'planning', thought: plan });
      return plan;
    },
  }));

  // Merge any additional tools (including MCP-wrapped CSE execution tools) BEFORE delegate_to_worker
  // so they appear earlier in the tool list and the model prefers them.
  if (opts.additionalTools) {
    for (const tool of opts.additionalTools.list()) {
      supervisorTools.register(tool);
    }
  }

  supervisorTools.register(weaveTool<{ worker: string; goal: string }>({
    name: 'delegate_to_worker',
    description: `Delegate a task to a worker agent. Available workers: ${[...workers.keys()].join(', ')}. Each worker has specialized capabilities. Describe the goal clearly. IMPORTANT: Do NOT use this for tasks that can be handled by an available tool (including MCP-wrapped tools like cse_run_code).`,
    parameters: {
      type: 'object',
      properties: {
        worker: {
          type: 'string',
          description: `Name of the worker to delegate to. One of: ${[...workers.keys()].join(', ')}`,
          enum: [...workers.keys()],
        },
        goal: {
          type: 'string',
          description: 'Clear description of what the worker should accomplish',
        },
      },
      required: ['worker', 'goal'],
    },
    async execute(args, ctx) {
      // If a CSE code-execution tool is available and the goal looks like code execution,
      // redirect automatically rather than delegating to a worker.
      const cseRunCode = opts.additionalTools?.list().find((t) => cseCodeToolNames.includes(t.schema.name));
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

      const worker = workers.get(args.worker);
      if (!worker) {
        return `Error: Worker "${args.worker}" not found. Available: ${[...workers.keys()].join(', ')}`;
      }

      // Check delegation budget
      if (delegationResults.length >= maxDelegations) {
        return 'Error: Maximum number of delegations reached.';
      }

      // Policy check
      if (policy?.approveDelegation) {
        const req: DelegationRequest = { targetAgent: args.worker, goal: args.goal };
        const decision = await policy.approveDelegation(ctx, req);
        if (!decision.approved) {
          return `Delegation denied: ${decision.reason ?? 'no reason'}`;
        }
      }

      eventBus?.emit(weaveEvent(EventTypes.AgentDelegation, {
        supervisor: config.name,
        worker: args.worker,
        goal: args.goal,
      }, ctx));

      const delegateStart = Date.now();
      const childCtx = weaveChildContext(ctx, {
        metadata: { delegatedBy: config.name, delegatedTo: args.worker },
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

  // Build instructions for the supervisor with explicit phases
  const directToolNames = opts.additionalTools?.list().map((t) => t.schema.name) ?? [];
  const directToolSection = directToolNames.length > 0
    ? [
        '',
        '## Available Tools (direct or MCP-wrapped — call these yourself when applicable):',
        directToolNames.map((n) => `- \`${n}\``).join('\n'),
        'When a task can be accomplished with a tool above, call it yourself instead of delegating.',
      ].join('\n')
    : '';

  const workerDescriptions = Object.entries(config.workers)
    .map(([name, wc]) => `- **${name}**: ${wc.description ?? 'No description'}`)
    .join('\n');

  const supervisorInstructions = [
    config.instructions ?? 'You are a supervisor that delegates work to specialized workers.',
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

  // The supervisor IS a tool-calling agent with thinking + delegation tools
  const innerAgent = weaveAgent({
    name: config.name,
    systemPrompt: supervisorInstructions,
    maxSteps: config.maxSteps ?? 30,
    model,
    tools: supervisorTools,
    memory,
    policy,
    bus: eventBus,
  });

  return {
    config,
    run: innerAgent.run.bind(innerAgent),
    runStream: innerAgent.runStream?.bind(innerAgent),
  };
}
