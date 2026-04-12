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

  supervisorTools.register(weaveTool<{ worker: string; goal: string }>({
    name: 'delegate_to_worker',
    description: `Delegate a task to a worker agent. Available workers: ${[...workers.keys()].join(', ')}. Each worker has specialized capabilities. Describe the goal clearly.`,
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

      return result.output || '(Worker returned no output)';
    },
  }));

  // Build instructions for the supervisor with explicit phases
  const workerDescriptions = Object.entries(config.workers)
    .map(([name, wc]) => `- **${name}**: ${wc.description ?? 'No description'}`)
    .join('\n');

  const supervisorInstructions = [
    config.instructions ?? 'You are a supervisor that delegates work to specialized workers.',
    '',
    '## Available Workers:',
    workerDescriptions,
    '',
    '## Your Workflow (CRITICAL - FOLLOW STRICTLY):',
    '',
    '### PHASE 1: UNDERSTANDING & PLANNING',
    '1. First, use the `think` tool with reasoning_phase="planning" to analyze the user request:',
    '   - What is the user actually asking for?',
    '   - What information or capabilities do I need?',
    '   - Which workers are qualified to handle this?',
    '2. Use the `plan` tool to create an explicit decomposition:',
    '   - State the objective clearly',
    '   - Describe your approach',
    '   - List which workers will help and why',
    '   - Note any potential issues',
    '',
    '### PHASE 2: DELEGATION & EXECUTION',
    '3. Delegate to workers using `delegate_to_worker`:',
    '   - Break complex work into focused subtasks',
    '   - Give each worker a clear, specific goal',
    '   - Let workers complete their tasks fully',
    '',
    '### PHASE 3: ANALYSIS & REASONING',
    '4. After receiving all worker results, use the `think` tool with reasoning_phase="reasoning":',
    '   - Did the worker results answer the question?',
    '   - What do the results tell us?',
    '   - Are there gaps or inconsistencies?',
    '   - How do the results connect to what the user asked?',
    '',
    '### PHASE 4: SYNTHESIS & RESPONSE',
    '5. Use the `think` tool with reasoning_phase="synthesis" before responding:',
    '   - Formulate your final answer based on the reasoning',
    '   - Include relevant details from worker results',
    '   - Explain your reasoning briefly',
    '',
    '## CRITICAL RULES:',
    '- NEVER skip the planning phase. Always use `plan` before delegating.',
    '- NEVER fire-and-forget. Always reason about worker results before responding.',
    '- ALWAYS use `think` with the appropriate reasoning_phase.',
    '- Take your time. Multiple thinking steps are better than fast answers.',
    '- If unsure, ask: "Do I have all the information needed?"',
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
