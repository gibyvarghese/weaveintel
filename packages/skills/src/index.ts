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

// Skill retrieval — lexical (default) / embedding / hybrid candidate strategies + retrieve-then-select router.
export {
  skillCard,
  cosine,
  candidatesToMatches,
  lexicalSkillRetriever,
  createSkillEmbeddingIndex,
  embeddingSkillRetriever,
  hybridSkillRetriever,
  createSkillRouter,
} from './retrieval.js';
export type {
  SkillEmbedFn,
  SkillCandidate,
  SkillRetrieveOptions,
  SkillRetriever,
  SkillEmbeddingIndex,
  EmbeddingRetrieverConfig,
  HybridRetrieverConfig,
  SkillRouterConfig,
  SkillRouterResult,
} from './retrieval.js';

// Skill composition — dependency graph resolution (requires / conflicts / provides→precondition).
export { resolveSkillGraph, detectRequiresCycle, isSkillTerminated } from './skill-graph.js';
export type { SkillGraphNode, SkillGraphResult, SkillGraphOptions } from './skill-graph.js';

// Skill packages — the open SKILL.md folder format (frontmatter + body + bundled files/scripts).
export { parseSkillPackage, skillPackageToDefinition, skillPackageRef, SkillPackageError } from './skill-package.js';
export type { SkillPackage, SkillCapabilityManifest, SkillPackageRef } from './skill-package.js';

// Skill security — trust tiers, Ed25519 signing, and the four verification gates (OWASP AST10).
export {
  tierPermissions,
  hashSkillPackage,
  signSkillPackage,
  verifySkillPackage,
  assessSkillPackage,
  OWASP_AGENTIC_SKILLS_TOP_10,
} from './skill-security.js';
export type {
  SkillTrustTier,
  TierPermissions,
  SkillSignature,
  VerifyResult,
  GateName,
  Severity,
  GateFinding,
  GateResult,
  SkillAssessment,
  AssessOptions,
  OwaspSkillRisk,
} from './skill-security.js';

// Three-level progressive disclosure + sandboxed Level-3 script execution.
export {
  skillCardL1,
  skillBodyL2,
  listSkillFiles,
  readSkillFile,
  runSkillScript,
  inferSkillScriptLanguage,
  limitScriptConcurrency,
  skillFileTools,
  createSkillPackageIndex,
  SkillResourceError,
} from './skill-loader.js';
export type {
  SkillScriptRunSpec,
  SkillScriptResult,
  SkillScriptRunner,
  RunSkillScriptOptions,
  SkillFileTool,
  SkillPackageIndex,
} from './skill-loader.js';

// Skill evaluation & lifecycle — quality scoring, eval-gated tier promotion, deprecate/retire.
export {
  evaluateSkill,
  evaluatePromotion,
  deprecateSkill,
  retireSkill,
  isSkillUsable,
  lifecycleForEvaluation,
} from './skill-evaluation.js';
export type {
  SkillEvalDimension,
  DimensionScore,
  SkillEvaluation,
  SkillJudge,
  SkillRubricCriterion,
  SkillJudgeRequest,
  SkillJudgeResponse,
  SkillEvalCase,
  EvaluateSkillOptions,
  PromotionPolicy,
  PromotionInput,
  PromotionDecision,
  SkillTrustTierNum,
  SkillLifecycleState,
  SkillDeprecation,
} from './skill-evaluation.js';

// Interop — import/export the open SKILL.md standard (agentskills.io) + directory import.
export {
  exportSkillMd,
  exportSkillPackage,
  skillDefinitionToSkillMd,
  importSkillMd,
  importSkillMdDirectory,
} from './skill-interop.js';
export type {
  ImportSkillResult,
  ImportSkillOptions,
  DirectoryImportResult,
} from './skill-interop.js';

// MCP bridge — expose the skill catalog over the Model Context Protocol (discovery on demand).
export { createSkillMcpBridge } from './skill-mcp.js';
export type {
  SkillMcpTool,
  SkillMcpToolResult,
  SkillMcpHandlers,
  SkillMcpBridgeOptions,
} from './skill-mcp.js';

// Skill mining + adaptive tuning + multimodal (Phase 6) — failure-driven proposals (human+eval gated).
export {
  mineSkillCandidates,
  approveMinedSkill,
  suggestedMinScore,
  skillAcceptsModality,
  filterSkillsByModality,
} from './skill-mining.js';
export type {
  SkillRunTrace,
  ProposalEvidence,
  ProposalSafety,
  SkillProposal,
  SkillProposer,
  MineSkillsOptions,
  ApproveMinedSkillInput,
  ApproveResult,
  RetrievalFeedbackSample,
  AdaptiveThreshold,
  SkillModality,
} from './skill-mining.js';

// Reusable injection scanner (also used by the miner to refuse poisoned trajectories).
export { scanTextForInjection } from './skill-security.js';

// Skill-system benchmark — score a catalog against public-benchmark-aligned targets (all phases).
export {
  runSkillBenchmark,
  buildDemoCatalog,
  formatScorecard,
  DEMO_QUERIES,
  BENCHMARK_TARGETS,
} from './skill-benchmark.js';
export type { BenchmarkOptions, BenchmarkResult, MetricRow } from './skill-benchmark.js';
// Real-world benchmark dataset — ~50 skills modelled on actual published Agent Skills + messy human messages.
export { buildRealWorldCatalog, REAL_WORLD_QUERIES } from './skill-benchmark-realworld.js';

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
