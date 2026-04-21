/**
 * Scientific Validation — Agent roster
 *
 * Seven agents wired through @weaveintel/agents:
 *   decomposer    — splits hypothesis into sub-claims (LLM only)
 *   literature    — retrieves prior work using evidence tools
 *   statistical   — meta-analysis / power / p-value audits (numerical layer)
 *   mathematical  — symbolic verification and derivations (symbolic layer)
 *   simulation    — Monte Carlo, ODE/PDE, domain sims (numerical + domain)
 *   adversarial   — falsification and confounders (all layers read)
 *   supervisor    — weighs evidence and emits verdict (no tool calls)
 *
 * Callers supply a model-factory and a ToolRegistry; the agents are
 * stateless factories that create a new weaveAgent per workflow run.
 */

import { weaveAgent } from '@weaveintel/agents';
import type { Agent, Model, ToolRegistry } from '@weaveintel/core';
import { DECOMPOSER_PROMPT } from '../prompts/decomposer.js';
import { LITERATURE_PROMPT } from '../prompts/literature.js';
import { STATISTICAL_PROMPT } from '../prompts/statistical.js';
import { MATHEMATICAL_PROMPT } from '../prompts/mathematical.js';
import { SIMULATION_PROMPT } from '../prompts/simulation.js';
import { ADVERSARIAL_PROMPT } from '../prompts/adversarial.js';
import { SUPERVISOR_PROMPT } from '../prompts/supervisor.js';

export interface SVAgentOptions {
  /** Model used for reasoning-only agents (decomposer, adversarial, supervisor). */
  reasoningModel: Model;
  /** Model used for tool-calling agents. */
  toolModel: Model;
  /** Full tool registry for the sv feature. */
  tools: ToolRegistry;
  /** Evidence-layer tools only (subset). */
  evidenceTools: ToolRegistry;
  /** Symbolic-layer tools only. */
  symbolicTools: ToolRegistry;
  /** Numerical-layer tools only. */
  numericalTools: ToolRegistry;
  /** Domain-layer tools only. */
  domainTools: ToolRegistry;
}

/** Create the decomposer agent — splits hypothesis into sub-claims (no tools). */
export function createDecomposerAgent(opts: { model: Model }): Agent {
  return weaveAgent({
    name: 'decomposer',
    model: opts.model,
    systemPrompt: DECOMPOSER_PROMPT,
    maxSteps: 1,
  });
}

/** Create the literature agent — retrieves prior work using evidence tools. */
export function createLiteratureAgent(opts: { model: Model; tools: ToolRegistry }): Agent {
  return weaveAgent({
    name: 'literature',
    model: opts.model,
    systemPrompt: LITERATURE_PROMPT,
    tools: opts.tools,
    maxSteps: 8,
  });
}

/** Create the statistical agent — numerical analysis and meta-analysis. */
export function createStatisticalAgent(opts: { model: Model; tools: ToolRegistry }): Agent {
  return weaveAgent({
    name: 'statistical',
    model: opts.model,
    systemPrompt: STATISTICAL_PROMPT,
    tools: opts.tools,
    maxSteps: 10,
  });
}

/** Create the mathematical agent — symbolic verification and derivations. */
export function createMathematicalAgent(opts: { model: Model; tools: ToolRegistry }): Agent {
  return weaveAgent({
    name: 'mathematical',
    model: opts.model,
    systemPrompt: MATHEMATICAL_PROMPT,
    tools: opts.tools,
    maxSteps: 10,
  });
}

/** Create the simulation agent — Monte Carlo, ODE/PDE, and domain simulations. */
export function createSimulationAgent(opts: { model: Model; tools: ToolRegistry }): Agent {
  return weaveAgent({
    name: 'simulation',
    model: opts.model,
    systemPrompt: SIMULATION_PROMPT,
    tools: opts.tools,
    maxSteps: 12,
  });
}

/** Create the adversarial agent — falsification and counter-evidence. */
export function createAdversarialAgent(opts: { model: Model; tools: ToolRegistry }): Agent {
  return weaveAgent({
    name: 'adversarial',
    model: opts.model,
    systemPrompt: ADVERSARIAL_PROMPT,
    tools: opts.tools,
    maxSteps: 8,
  });
}

/** Create the supervisor agent — no tool calls; synthesises evidence and emits verdict. */
export function createSupervisorAgent(opts: { model: Model }): Agent {
  return weaveAgent({
    name: 'supervisor',
    model: opts.model,
    systemPrompt: SUPERVISOR_PROMPT,
    maxSteps: 1,
  });
}

/** Convenience: create all seven agents from a unified options object. */
export function createSVAgents(opts: SVAgentOptions): Record<string, Agent> {
  // Build tool registries per layer
  const numericalAndDomain = opts.numericalTools;

  return {
    decomposer: createDecomposerAgent({ model: opts.reasoningModel }),
    literature: createLiteratureAgent({ model: opts.toolModel, tools: opts.evidenceTools }),
    statistical: createStatisticalAgent({ model: opts.toolModel, tools: opts.numericalTools }),
    mathematical: createMathematicalAgent({ model: opts.toolModel, tools: opts.symbolicTools }),
    simulation: createSimulationAgent({ model: opts.toolModel, tools: numericalAndDomain }),
    adversarial: createAdversarialAgent({ model: opts.reasoningModel, tools: opts.tools }),
    supervisor: createSupervisorAgent({ model: opts.reasoningModel }),
  };
}
