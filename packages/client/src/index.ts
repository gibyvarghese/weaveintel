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

// Outbox
export type { OutboxStorage, OutboxFlushResult, RunOutbox } from './outbox.js';
export { MemoryStorage, createRunOutbox } from './outbox.js';
