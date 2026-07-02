/**
 * SSE parser — re-export of the canonical primitive in `@weaveintel/core`.
 *
 * The implementation moved to `@weaveintel/core` in Collaboration Phase 0 so the
 * run-stream transport (client), the agent-to-agent reader (a2a), and any other
 * SSE consumer share ONE byte→event decoder instead of three copies. This file
 * is kept as a thin re-export so existing `@weaveintel/client` import sites (and
 * `@geneweave/api-client`, which re-exports these names) keep working unchanged.
 */
export {
  parseSseStream,
  SseStallError,
  type SseEvent,
  type ParseSseOptions,
} from '@weaveintel/core';
