export {
  weaveMemoryStore,
  weaveConversationMemory,
  weaveSemanticMemory,
  weaveEntityMemory,
} from './memory.js';

export { weaveGovernancePolicy } from './governance.js';
export type { GovernanceRule } from './governance.js';

export { setProvenance, getProvenance, withProvenance, filterByConfidence } from './provenance.js';
export type { ProvenanceInfo } from './provenance.js';

export { deduplicateExact, deduplicateByKey } from './dedup.js';
export type { DeduplicationStrategy } from './dedup.js';

export { recordCorrection, getCorrections, applyCorrection } from './correction.js';
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
