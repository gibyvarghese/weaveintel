/**
 * View-model stream reducer.
 *
 * Pure function — no side effects, no imports beyond type-only.
 * Maps a stream of `RunEventEnvelope` records onto a typed view model
 * that UI layers can render directly.
 */

import type { RunEventEnvelope } from '@weaveintel/core';

// ---------------------------------------------------------------------------
// Run status mirrors @weaveintel/core RunStatus
// ---------------------------------------------------------------------------

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// ---------------------------------------------------------------------------
// Per-event view kinds
// ---------------------------------------------------------------------------

export type TextChunk = {
  kind: 'text';
  text: string;        // full accumulated text so far
  delta: string;       // latest chunk
  role?: string;
};

export type WidgetView = {
  kind: 'widget';
  id: string;
  payload: Record<string, unknown>;
  schemaVersion?: number;
};

export type StatusView = {
  kind: 'status';
  status: RunStatus;
  detail?: string;
};

export type ToolCallView = {
  kind: 'tool-call';
  toolName: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
};

export type ErrorView = {
  kind: 'error';
  code: string;
  message: string;
};

// ─── Phase 1 — parity view kinds ─────────────────────────────

export type ReasoningChunk = {
  kind: 'reasoning';
  text: string;   // full accumulated reasoning so far
  delta: string;  // latest chunk
};

export type UsageView = {
  kind: 'usage';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  model?: string;
  provider?: string;
  mode?: string;
};

export type StepView = {
  kind: 'step';
  index?: number;
  type?: string;
  content?: string;
  toolName?: string;
  durationMs?: number;
  phase?: 'step_start' | 'step_end';
};

export type CitationView = {
  kind: 'citation';
  id: string;
  text?: string;
  source?: string;
  url?: string;
};

export type ArtifactView = {
  kind: 'artifact';
  id: string;
  type?: string;
  title?: string;
  mimeType?: string;
  url?: string;
};

export type DiagnosticView = {
  kind: 'diagnostic';
  channel: string;
  data?: unknown;
};

export type StreamItem =
  | TextChunk | WidgetView | StatusView | ToolCallView | ErrorView
  | ReasoningChunk | UsageView | StepView | CitationView | ArtifactView | DiagnosticView;

// ---------------------------------------------------------------------------
// The accumulated view model
// ---------------------------------------------------------------------------

export interface RunViewModel {
  /** Latest sequence number seen. */
  sequence: number;
  /** Run lifecycle status. */
  status: RunStatus;
  /** Accumulated text (all deltas joined). */
  fullText: string;
  /** All text chunks in order. */
  textChunks: TextChunk[];
  /** Widgets keyed by widget id (upserted). */
  widgets: Map<string, WidgetView>;
  /** Ordered list of all tool calls. */
  toolCalls: ToolCallView[];
  /** Last error (if any). */
  lastError?: ErrorView;
  // ── Phase 1 — parity ──
  /** Accumulated reasoning text (distinct channel, not part of `fullText`). */
  reasoningText: string;
  /** All reasoning chunks in order. */
  reasoningChunks: ReasoningChunk[];
  /** Latest usage / cost / model snapshot for the run. */
  usage?: UsageView;
  /** Ordered agent / supervisor plan steps. */
  steps: StepView[];
  /** Citations / sources surfaced during the run. */
  citations: CitationView[];
  /** Artifacts produced, keyed by id (upserted). */
  artifacts: Map<string, ArtifactView>;
  /** Non-output diagnostics (guardrail / policy / eval / cognitive / ensemble). */
  diagnostics: DiagnosticView[];
  /** All items in event order (for a linear render). */
  items: StreamItem[];
}

export function emptyRunViewModel(): RunViewModel {
  return {
    sequence: -1,
    status: 'pending',
    fullText: '',
    textChunks: [],
    widgets: new Map(),
    toolCalls: [],
    reasoningText: '',
    reasoningChunks: [],
    steps: [],
    citations: [],
    artifacts: new Map(),
    diagnostics: [],
    items: [],
  };
}

// ---------------------------------------------------------------------------
// Envelope shape — canonical contract from @weaveintel/core (Phase 0).
// Re-exported here so existing import sites (`from './reducer.js'`) keep working
// while the producer (geneweave executor) and consumer (this reducer) share one
// definition and can never drift.
// ---------------------------------------------------------------------------

export type { RunEventEnvelope };

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

/**
 * Returns a *new* `RunViewModel` with the envelope applied.
 * Never mutates the input state.
 */
export function streamReducer(state: RunViewModel, envelope: RunEventEnvelope): RunViewModel {
  // Skip already-seen or out-of-order events (idempotent)
  if (envelope.sequence <= state.sequence) return state;

  const p = envelope.payload;
  const next: RunViewModel = {
    ...state,
    sequence: envelope.sequence,
    textChunks: [...state.textChunks],
    widgets: new Map(state.widgets),
    toolCalls: [...state.toolCalls],
    reasoningChunks: [...state.reasoningChunks],
    steps: [...state.steps],
    citations: [...state.citations],
    artifacts: new Map(state.artifacts),
    diagnostics: [...state.diagnostics],
    items: [...state.items],
  };

  switch (envelope.kind) {
    case 'run.started': {
      next.status = 'running';
      const sv: StatusView = { kind: 'status', status: 'running' };
      next.items.push(sv);
      break;
    }

    case 'run.completed': {
      next.status = 'completed';
      const sv: StatusView = { kind: 'status', status: 'completed' };
      next.items.push(sv);
      break;
    }

    case 'run.failed': {
      next.status = 'failed';
      const msg = typeof p['message'] === 'string' ? p['message'] : 'Unknown error';
      const ev: ErrorView = { kind: 'error', code: 'RUN_FAILED', message: msg };
      next.lastError = ev;
      const sv: StatusView = { kind: 'status', status: 'failed', detail: msg };
      next.items.push(sv, ev);
      break;
    }

    case 'run.cancelled': {
      next.status = 'cancelled';
      const sv: StatusView = { kind: 'status', status: 'cancelled' };
      next.items.push(sv);
      break;
    }

    case 'text.delta': {
      const delta = typeof p['delta'] === 'string' ? p['delta'] : '';
      const role = typeof p['role'] === 'string' ? p['role'] : undefined;
      next.fullText = state.fullText + delta;
      const chunk: TextChunk = {
        kind: 'text',
        text: next.fullText,
        delta,
        ...(role !== undefined ? { role } : {}),
      };
      next.textChunks.push(chunk);
      next.items.push(chunk);
      break;
    }

    case 'widget.update': {
      const id = typeof p['id'] === 'string' ? p['id'] : `widget-${envelope.sequence}`;
      const payload = typeof p['payload'] === 'object' && p['payload'] !== null
        ? (p['payload'] as Record<string, unknown>)
        : p;
      const sv = typeof p['schemaVersion'] === 'number' ? p['schemaVersion'] : undefined;
      const wv: WidgetView = {
        kind: 'widget',
        id,
        payload,
        ...(sv !== undefined ? { schemaVersion: sv } : {}),
      };
      next.widgets.set(id, wv);
      next.items.push(wv);
      break;
    }

    case 'tool.invoked': {
      const toolName = typeof p['tool'] === 'string' ? p['tool'] : 'unknown';
      const args = (typeof p['args'] === 'object' && p['args'] !== null)
        ? (p['args'] as Record<string, unknown>) : undefined;
      const tv: ToolCallView = {
        kind: 'tool-call',
        toolName,
        ...(args !== undefined ? { args } : {}),
      };
      next.toolCalls.push(tv);
      next.items.push(tv);
      break;
    }

    case 'tool.completed': {
      // Try to find matching pending tool call (last one with same name)
      const toolName = typeof p['tool'] === 'string' ? p['tool'] : 'unknown';
      const result = p['result'];
      const lastIdx = [...next.toolCalls].reverse().findIndex((tc) => tc.toolName === toolName);
      if (lastIdx !== -1) {
        const realIdx = next.toolCalls.length - 1 - lastIdx;
        next.toolCalls[realIdx] = { ...next.toolCalls[realIdx]!, result };
      }
      break;
    }

    case 'tool.errored': {
      const toolName = typeof p['tool'] === 'string' ? p['tool'] : 'unknown';
      const errorMsg = typeof p['error'] === 'string' ? p['error'] : 'Tool error';
      const lastIdx = [...next.toolCalls].reverse().findIndex((tc) => tc.toolName === toolName);
      if (lastIdx !== -1) {
        const realIdx = next.toolCalls.length - 1 - lastIdx;
        next.toolCalls[realIdx] = { ...next.toolCalls[realIdx]!, error: errorMsg };
      }
      break;
    }

    // ── Phase 1 — parity kinds ──

    case 'reasoning.delta': {
      // Accept either `delta` (canonical) or `text` (raw chat-frame shape).
      const delta = typeof p['delta'] === 'string' ? p['delta']
        : typeof p['text'] === 'string' ? p['text'] : '';
      next.reasoningText = state.reasoningText + delta;
      const chunk: ReasoningChunk = { kind: 'reasoning', text: next.reasoningText, delta };
      next.reasoningChunks.push(chunk);
      next.items.push(chunk);
      break;
    }

    case 'usage.update': {
      const num = (k: string): number | undefined => (typeof p[k] === 'number' ? p[k] as number : undefined);
      const str = (k: string): string | undefined => (typeof p[k] === 'string' ? p[k] as string : undefined);
      const uv: UsageView = {
        kind: 'usage',
        ...(num('promptTokens') !== undefined ? { promptTokens: num('promptTokens') } : {}),
        ...(num('completionTokens') !== undefined ? { completionTokens: num('completionTokens') } : {}),
        ...(num('totalTokens') !== undefined ? { totalTokens: num('totalTokens') } : {}),
        ...(num('costUsd') !== undefined ? { costUsd: num('costUsd') } : {}),
        ...(num('latencyMs') !== undefined ? { latencyMs: num('latencyMs') } : {}),
        ...(str('model') !== undefined ? { model: str('model') } : {}),
        ...(str('provider') !== undefined ? { provider: str('provider') } : {}),
        ...(str('mode') !== undefined ? { mode: str('mode') } : {}),
      };
      next.usage = uv;
      next.items.push(uv);
      break;
    }

    case 'step.update': {
      const sv: StepView = {
        kind: 'step',
        ...(typeof p['index'] === 'number' ? { index: p['index'] as number } : {}),
        ...(typeof p['type'] === 'string' ? { type: p['type'] as string } : {}),
        ...(typeof p['content'] === 'string' ? { content: p['content'] as string } : {}),
        ...(typeof p['toolName'] === 'string' ? { toolName: p['toolName'] as string } : {}),
        ...(typeof p['durationMs'] === 'number' ? { durationMs: p['durationMs'] as number } : {}),
        ...(p['phase'] === 'step_start' || p['phase'] === 'step_end' ? { phase: p['phase'] as 'step_start' | 'step_end' } : {}),
      };
      next.steps.push(sv);
      next.items.push(sv);
      break;
    }

    case 'citation.add': {
      const id = typeof p['id'] === 'string' ? p['id'] : `citation-${envelope.sequence}`;
      const cv: CitationView = {
        kind: 'citation', id,
        ...(typeof p['text'] === 'string' ? { text: p['text'] as string } : {}),
        ...(typeof p['source'] === 'string' ? { source: p['source'] as string } : {}),
        ...(typeof p['url'] === 'string' ? { url: p['url'] as string } : {}),
      };
      if (!next.citations.some((c) => c.id === cv.id)) { // dedupe by id
        next.citations.push(cv);
        next.items.push(cv);
      }
      break;
    }

    case 'artifact.update': {
      const id = typeof p['id'] === 'string' ? p['id'] : `artifact-${envelope.sequence}`;
      const av: ArtifactView = {
        kind: 'artifact', id,
        ...(typeof p['type'] === 'string' ? { type: p['type'] as string } : {}),
        ...(typeof p['title'] === 'string' ? { title: p['title'] as string } : {}),
        ...(typeof p['mimeType'] === 'string' ? { mimeType: p['mimeType'] as string } : {}),
        ...(typeof p['url'] === 'string' ? { url: p['url'] as string } : {}),
      };
      next.artifacts.set(id, av); // upsert by id
      next.items.push(av);
      break;
    }

    case 'diagnostic': {
      const channel = typeof p['channel'] === 'string' ? p['channel'] : 'unknown';
      const dv: DiagnosticView = { kind: 'diagnostic', channel, data: p['data'] };
      next.diagnostics.push(dv);
      next.items.push(dv);
      break;
    }

    default:
      // Unknown event — just advance sequence, no view change
      break;
  }

  return next;
}
