// SPDX-License-Identifier: MIT
/**
 * @weaveintel/agents/swarm — set a group of agents to one task, under hard limits.
 *
 * A swarm is described by a `SwarmDefinition` (plain data) and run by
 * `weaveSwarm({ host })`. The host supplies models, tools, the permission and
 * approval ports, and optionally a store so runs survive a restart.
 */

export * from './types.js';
export {
  validateSwarmDefinition,
  estimateSwarm,
  roleOf,
  SwarmDefinitionError,
  type SwarmValidation,
} from './validate.js';
export {
  createInMemorySwarmRunStore,
  markSwarmInterrupted,
  type InMemorySwarmRunStore,
} from './store.js';
export {
  weaveSwarm,
  SwarmResumeError,
  type SwarmEngine,
  type SwarmEngineOptions,
  type SwarmResumeOptions,
} from './engine.js';
export { SwarmStopSignal, SwarmAgentStepLimit } from './guard.js';
export { SWARM_TEXT_LIMITS } from './prompts.js';
