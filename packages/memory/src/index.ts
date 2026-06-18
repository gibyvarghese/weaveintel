// SPDX-License-Identifier: MIT
export {
  weaveMemoryStore,
  weaveRuntimeMemoryStore,
  weaveConversationMemory,
  createConfiguredConversationMemory,
  createConfiguredMemoryStore,
  createConfiguredMemoryStoreAsync,
  weavePostgresMemoryStore,
  weavePgVectorMemoryStore,
  weaveRedisMemoryStore,
  weaveSqliteMemoryStore,
  weaveMongoDbMemoryStore,
  weaveCloudNoSqlMemoryStore,
  weaveSemanticMemory,
  weaveEntityMemory,
} from './memory.js';

export type {
  ConfiguredConversationMemory,
  ConfiguredMemoryStoreOptions,
  PgVectorMemoryStoreOptions,
  RuntimeMemoryStoreOptions,
} from './memory.js';

export { weaveGovernancePolicy } from './governance.js';
export type { GovernanceRule } from './governance.js';

export { setProvenance, getProvenance, withProvenance, filterByConfidence } from './provenance.js';
export type { ProvenanceInfo } from './provenance.js';

export { deduplicateExact, deduplicateByKey } from './dedup.js';
export type { DeduplicationStrategy } from './dedup.js';

export { recordCorrection, getCorrections, applyCorrection, supersede } from './correction.js';
export type { Correction } from './correction.js';

export { isExpired, filterExpired, enforceRetention, forgetUser, forgetSession } from './expiry.js';

export {
  runHybridMemoryExtraction,
  evaluateSelfDisclosureByRules,
  extractEntitiesByRegexRules,
  mergeExtractedEntities,
} from './extraction.js';
export type {
  MemoryExtractionRule,
  ExtractedEntity,
  ExtractionEvent,
  MemoryExtractionInput,
  MemoryExtractionResult,
  LlmEntityExtractor,
} from './extraction.js';

export {
  weaveWorkingMemory,
  createCompressorRegistry,
  createNoopCompressor,
  createDefaultContextCompressors,
  createContextAssembler,
} from './working.js';
export type {
  CompressorRegistry,
  CompressionProfile,
  AssembleContextOptions,
  AssembledContext,
  ContextAssembler,
} from './working.js';

export { weaveMemoryConsolidator } from './consolidation.js';
export type { MemoryConsolidatorOptions } from './consolidation.js';

export {
  createProceduralEntry,
  isProceduralEntry,
  proposeProceduralUpdate,
  applyApprovedProcedural,
  runProceduralCurator,
} from './procedural.js';
export type {
  ProceduralMemoryMetadata,
  ProceduralMemoryEntry,
  ProposeProceduralUpdateOptions,
  ApplyApprovedProceduralOptions,
  CuratorOptions,
  CuratorResult,
} from './procedural.js';
