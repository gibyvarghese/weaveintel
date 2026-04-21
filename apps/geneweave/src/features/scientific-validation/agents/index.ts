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
 * System prompts are resolved from the DB at runner construction time (via
 * sv-seed.ts keys like `sv.decomposer`) and passed in as plain strings.
 * No prompt constants live in TypeScript — edit prompts via the admin UI.
 */

import { weaveAgent } from '@weaveintel/agents';
import type { Agent, Model, ToolRegistry } from '@weaveintel/core';

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
  /** System prompts loaded from DB, keyed by agent name. */
  prompts: Record<string, string>;
}

/** Create the decomposer agent — splits hypothesis into sub-claims (no tools). */
export function createDecomposerAgent(opts: { model: Model; systemPrompt: string }): Agent {
  return weaveAgent({
    name: 'decomposer',
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    maxSteps: 1,
  });
}

/** Create the literature agent — retrieves prior work using evidence tools. */
export function createLiteratureAgent(opts: { model: Model; tools: ToolRegistry; systemPrompt: string }): Agent {
  return weaveAgent({
    name: 'literature',
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    maxSteps: 8,
  });
}

/** Create the statistical agent — numerical analysis and meta-analysis. */
export function createStatisticalAgent(opts: { model: Model; tools: ToolRegistry; systemPrompt: string }): Agent {
  return weaveAgent({
    name: 'statistical',
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    maxSteps: 10,
  });
}

/** Create the mathematical agent — symbolic verification and derivations. */
export function createMathematicalAgent(opts: { model: Model; tools: ToolRegistry; systemPrompt: string }): Agent {
  return weaveAgent({
    name: 'mathematical',
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    maxSteps: 10,
  });
}

/** Create the simulation agent — Monte Carlo, ODE/PDE, and domain simulations. */
export function createSimulationAgent(opts: { model: Model; tools: ToolRegistry; systemPrompt: string }): Agent {
  return weaveAgent({
    name: 'simulation',
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    maxSteps: 12,
  });
}

/** Create the adversarial agent — falsification and counter-evidence. */
export function createAdversarialAgent(opts: { model: Model; tools: ToolRegistry; systemPrompt: string }): Agent {
  return weaveAgent({
    name: 'adversarial',
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    maxSteps: 8,
  });
}

/** Create the supervisor agent — no tool calls; synthesises evidence and emits verdict. */
export function createSupervisorAgent(opts: { model: Model; systemPrompt: string }): Agent {
  return weaveAgent({
    name: 'supervisor',
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    maxSteps: 1,
  });
}

/** Convenience: create all seven agents from a unified options object. */
export function createSVAgents(opts: SVAgentOptions): Record<string, Agent> {
  const p = opts.prompts;
  const numericalAndDomain = opts.numericalTools;

  return {
    decomposer:  createDecomposerAgent({ model: opts.reasoningModel, systemPrompt: p['decomposer'] ?? '' }),
    literature:  createLiteratureAgent({ model: opts.toolModel, tools: opts.evidenceTools, systemPrompt: p['literature'] ?? '' }),
    statistical: createStatisticalAgent({ model: opts.toolModel, tools: opts.numericalTools, systemPrompt: p['statistical'] ?? '' }),
    mathematical: createMathematicalAgent({ model: opts.toolModel, tools: opts.symbolicTools, systemPrompt: p['mathematical'] ?? '' }),
    simulation:  createSimulationAgent({ model: opts.toolModel, tools: numericalAndDomain, systemPrompt: p['simulation'] ?? '' }),
    adversarial: createAdversarialAgent({ model: opts.reasoningModel, tools: opts.tools, systemPrompt: p['adversarial'] ?? '' }),
    supervisor:  createSupervisorAgent({ model: opts.reasoningModel, systemPrompt: p['supervisor'] ?? '' }),
  };
}

