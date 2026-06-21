// SPDX-License-Identifier: MIT
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

// A2A Skill catalog (mid-2026 taxonomy)
export {
  A2A_SKILL_CATALOG,
  A2A_NEW_SKILLS_V2,
  SUPERVISOR_V2_WORKERS,
  M69_NEW_INPUT_MIME_TYPES,
  mapA2ASkillToRow,
} from './a2a-skill-catalog.js';
export type { A2ASkillDef, A2ASkillMode, A2AWorkerDef } from './a2a-skill-catalog.js';
