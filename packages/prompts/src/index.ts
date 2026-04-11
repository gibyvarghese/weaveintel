/**
 * @weaveintel/prompts — Public API
 */

// Template engine
export { createTemplate, extractVariables } from './template.js';

// Registry
export { InMemoryPromptRegistry } from './registry.js';

// Resolver
export { PromptResolver } from './resolver.js';
export type { PromptVersionStore } from './resolver.js';

// Experiments
export { InMemoryExperimentStore, weightedSelect } from './experiment.js';
export type { PromptExperimentStore } from './experiment.js';

// Instructions
export {
  InstructionBundleBuilder,
  composeInstructions,
  createInstructionBundle,
} from './instructions.js';
