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
}

export function weaveSupervisor(opts: SupervisorOptions): Agent {
  const eventBus = opts.bus;
  const { model, policy, memory } = opts;
  const maxDelegations = (opts.maxSteps ?? 10);

  const config: SupervisorConfig = {
    name: opts.name ?? 'supervisor',
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

  // Create a delegation tool that the supervisor model can call
  const delegationResults: DelegationResult[] = [];

  const supervisorTools = weaveToolRegistry();

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

  // Build instructions for the supervisor
  const workerDescriptions = Object.entries(config.workers)
    .map(([name, wc]) => `- **${name}**: ${wc.description ?? 'No description'}`)
    .join('\n');

  const supervisorInstructions = [
    config.instructions ?? 'You are a supervisor that delegates work to specialized workers.',
    '',
    'Available workers:',
    workerDescriptions,
    '',
    'Use the delegate_to_worker tool to assign tasks. Break complex work into subtasks for workers.',
    'After receiving all worker results, synthesize a final response.',
  ].join('\n');

  // The supervisor IS a tool-calling agent, but its only tool is delegation
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
