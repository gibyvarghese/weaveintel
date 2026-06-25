// SPDX-License-Identifier: MIT
/**
 * @weaveintel/client
 *
 * Browser-safe run client for the weaveIntel platform.
 *
 * Public API surface — everything else is internal.
 */

// Transport
export type {
  AuthProvider,
  EventTransport,
  FetchJsonTransport,
  StreamEvent,
  StreamHandler,
  StreamLifecycle,
  StreamCloseInfo,
  SseTransportOptions,
} from './transport.js';
export { sseTransport, fetchJsonTransport, mockSseTransport } from './transport.js';

// SSE parser (the single byte→event decoder, shared by transport + hosts)
export type { SseEvent, ParseSseOptions } from './sse-parser.js';
export { parseSseStream, SseStallError } from './sse-parser.js';

// Reducer / view model
export type {
  RunStatus,
  RunViewModel,
  StreamItem,
  TextChunk,
  WidgetView,
  StatusView,
  ToolCallView,
  ErrorView,
  ReasoningChunk,
  UsageView,
  StepView,
  CitationView,
  ArtifactView,
  DiagnosticView,
  ApprovalView,
  ApprovalStatus,
  ApprovalPart,
  RunPart,
  TextPart,
  ReasoningPart,
  ToolPart,
  ToolPartState,
  StepPart,
  WidgetPart,
  ArtifactPart,
  CitationPart,
  ObjectPart,
  FilePart,
  ObjectView,
  FileView,
  RunEventEnvelope,
} from './reducer.js';
export { streamReducer, emptyRunViewModel } from './reducer.js';

// Partial-JSON parser (Phase 7 — structured object streaming)
export type { PartialJsonResult, PartialJsonState } from './partial-json.js';
export { parsePartialJson, extractJsonCandidate } from './partial-json.js';

// AG-UI wire adapter (Phase 7, optional — ecosystem interop)
export type { AGUIEvent, AGUIEventType } from './ag-ui.js';
export { toAGUIEvents } from './ag-ui.js';

// Run client
export type {
  RunRecord,
  StartRunInput,
  ListRunsFilter,
  AttachOptions,
  RunClient,
  CreateRunClientOptions,
} from './run-client.js';
export { createRunClient } from './run-client.js';

// Run session (framework-agnostic UX controller — status / stop / regenerate / resume / throttle)
export type {
  RunSession,
  RunSessionOptions,
  RunSessionState,
  RunSessionStatus,
  RunSessionStartInput,
  RunSessionListener,
} from './run-session.js';
export { createRunSession, RUN_SESSION_SCHEMA_VERSION, RunResumeExpiredError } from './run-session.js';

// Cursor store (Phase 6 — refresh-proof resume)
export type { RunCursor, RunCursorStore } from './cursor.js';
export { createRunCursorStore, isCursorResumable } from './cursor.js';

// Run metrics rollup (Phase 6 — client observability)
export type { RunMetrics, RunMetricsSnapshot, RunOutcome } from './metrics.js';
export { createRunMetrics } from './metrics.js';

// Outbox (v2 — backoff / dead-letter / online-offline / event buffering)
export type {
  OutboxStorage,
  OutboxFlushResult,
  RunOutbox,
  OutboxItem,
  OutboxItemKind,
  AutoFlushOptions,
  CreateRunOutboxOptions,
} from './outbox.js';
export { MemoryStorage, createRunOutbox } from './outbox.js';
