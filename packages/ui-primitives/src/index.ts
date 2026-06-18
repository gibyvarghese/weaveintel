// SPDX-License-Identifier: MIT
// @weaveintel/ui-primitives — Public API
export {
  createUiEvent,
  textEvent,
  errorEvent,
  statusEvent,
  toolCallEvent,
  stepUpdateEvent,
  envelope,
  resetSequence,
  createStreamBuilder,
  type StreamBuilder,
} from './events.js';

export {
  createApprovalPayload,
  toolApproval,
  workflowApproval,
  type ApprovalAction,
  type CreateApprovalOptions,
} from './approval.js';

export {
  createCitation,
  documentCitation,
  webCitation,
  deduplicateCitations,
  type CreateCitationOptions,
} from './citations.js';

export {
  createArtifactPayload,
  jsonArtifact,
  codeArtifact,
  csvArtifact,
  markdownArtifact,
  type CreateArtifactPayloadOptions,
} from './artifacts.js';

export {
  createWidget,
  tableWidget,
  chartWidget,
  formWidget,
  codeWidget,
  timelineWidget,
  imageWidget,
  type CreateWidgetOptions,
} from './widgets.js';

export {
  createProgress,
  createProgressTracker,
  type CreateProgressOptions,
  type ProgressTracker,
} from './progress.js';

// W2 — Inbound widget action helpers
export {
  widgetActionEvent,
  parseWidgetAction,
  type WidgetActionPayload,
  type ParseWidgetActionResult,
  type ParseWidgetActionError,
  type ParseWidgetActionOutcome,
} from './widget-actions.js';

// W2 — Widget renderer registry (interface + in-memory reference impl)
export {
  createWidgetRendererRegistry,
  type WidgetRenderer,
  type WidgetRendererRegistry,
} from './widget-registry.js';

