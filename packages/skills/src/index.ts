/**
 * @weaveintel/skills — Text-first Skills runtime
 *
 * Skills are reusable semantic capability packages, not keyword maps.
 * A skill describes when/why/how to execute, completion expectations,
 * governance constraints, and optional tool guidance.
 */

export * from './types.js';
export * from './persistence.js';
export * from './builtin.js';
export { buildSkillInvocationPrompt, buildSkillSystemPrompt, applySkillsToPrompt } from './prompt-builder.js';
export { collectSkillTools, createSkillTelemetry, activateSkills, evaluateSkillCompletion } from './activation.js';
export { createSkillRegistry } from './registry.js';

// Seed utilities
export { mapSkillToRow, type SkillSeedRow } from './seed.js';
