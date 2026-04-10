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
  childContext,
  createEvent,
  EventTypes,
  defineTool,
  createToolRegistry,
} from '@weaveintel/core';
import { createToolCallingAgent } from './agent.js';

export interface SupervisorOptions {
  config: SupervisorConfig;
  model: Model;
  workerModels?: Record<string, Model>;
  workerTools?: Record<string, ToolRegistry>;
  policy?: AgentPolicy;
  memory?: AgentMemory;
  eventBus?: EventBus;
}

export function createSupervisor(opts: SupervisorOptions): Agent {
  const { config, model, workerModels, workerTools, policy, memory, eventBus } = opts;
  const maxDelegations = config.maxDelegations ?? 10;

  // Build worker agents
  const workers = new Map<string, Agent>();
  for (const [name, workerConfig] of Object.entries(config.workers)) {
    const workerModel = workerModels?.[name] ?? model;
    const workerToolReg = workerTools?.[name];
    workers.set(name, createToolCallingAgent({
      config: { ...workerConfig, name: workerConfig.name ?? name },
      model: workerModel,
      tools: workerToolReg,
      eventBus,
    }));
  }

  // Create a delegation tool that the supervisor model can call
  const delegationResults: DelegationResult[] = [];

  const supervisorTools = createToolRegistry();

  supervisorTools.register(defineTool<{ worker: string; goal: string }>({
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

      eventBus?.emit(createEvent(EventTypes.AgentDelegation, {
        supervisor: config.name,
        worker: args.worker,
        goal: args.goal,
      }, ctx));

      const delegateStart = Date.now();
      const childCtx = childContext(ctx, {
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
  const innerAgent = createToolCallingAgent({
    config: {
      ...config,
      instructions: supervisorInstructions,
      maxSteps: config.maxSteps ?? 30,
    },
    model,
    tools: supervisorTools,
    memory,
    policy,
    eventBus,
  });

  return {
    config,
    run: innerAgent.run.bind(innerAgent),
    runStream: innerAgent.runStream?.bind(innerAgent),
  };
}
