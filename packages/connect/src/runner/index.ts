/**
 * @weaveintel/connect/runner — the generic operation runner (FRAMEWORK 5.3).
 */
export { BODY_FORMATS, IDEMPOTENCY_STYLES, METHODS, PAGING_STYLES, type BodyFormat, type DeclaredOutput, type IdempotencyStyle, type MappingFrom, type Method, type OperationSpec, type OutcomeRule, type PagingSpec, type PagingStyle, type RequestMapping, type ResponseMapping } from './spec.js'
export { TRANSFORMS, applyTransform, type ChoiceMaps, type Transform } from './transforms.js'
export { getAt, setAt } from './paths.js'
export { buildRequest, deriveIdempotencyKey, safeToRepeat, type BuildResult } from './build.js'
export { runOperation, sentenceFor, type RunInput, type RunResult } from './run.js'
