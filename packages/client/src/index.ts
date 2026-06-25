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
  RunEventEnvelope,
} from './reducer.js';
export { streamReducer, emptyRunViewModel } from './reducer.js';

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

// Run session (framework-agnostic UX controller — status / stop / regenerate / throttle)
export type {
  RunSession,
  RunSessionOptions,
  RunSessionState,
  RunSessionStatus,
  RunSessionStartInput,
  RunSessionListener,
} from './run-session.js';
export { createRunSession, RUN_SESSION_SCHEMA_VERSION } from './run-session.js';

// Outbox
export type { OutboxStorage, OutboxFlushResult, RunOutbox } from './outbox.js';
export { MemoryStorage, createRunOutbox } from './outbox.js';
