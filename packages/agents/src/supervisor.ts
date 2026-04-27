/**
 * @weaveintel/agents — Supervisor agent (legacy alias)
 *
 * `weaveSupervisor` is now a thin wrapper around `weaveAgent({ workers: [...] })`.
 * Both names are supported. New code should prefer `weaveAgent` directly with
 * the `workers` option to keep the API surface unified.
 *
 * The shared runtime that builds the supervisor's tool registry and system
 * prompt lives in `./supervisor-runtime.ts` and is consumed by `weaveAgent`.
 */

import type { Agent, AgentMemory, AgentPolicy, EventBus, Model, ToolRegistry } from '@weaveintel/core';
import { weaveAgent } from './agent.js';
import type { WorkerDefinition } from './supervisor-runtime.js';

export type { WorkerDefinition } from './supervisor-runtime.js';

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

/**
 * Build a supervisor-mode agent. Equivalent to calling `weaveAgent` with the
 * `workers` option. Prefer `weaveAgent` directly in new code.
 */
export function weaveSupervisor(opts: SupervisorOptions): Agent {
  return weaveAgent({
    name: opts.name ?? 'supervisor',
    model: opts.model,
    bus: opts.bus,
    memory: opts.memory,
    policy: opts.policy,
    maxSteps: opts.maxSteps,
    systemPrompt: opts.instructions,
    workers: opts.workers,
    additionalTools: opts.additionalTools,
    cseCodeToolNames: opts.cseCodeToolNames,
  });
}
