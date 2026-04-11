/**
 * @weaveintel/core — UI event payload contracts
 */

// ─── Stream Envelope ─────────────────────────────────────────

export type UiEventType =
  | 'text'
  | 'progress'
  | 'approval'
  | 'citation'
  | 'artifact'
  | 'widget'
  | 'error'
  | 'status'
  | 'tool-call'
  | 'step-update';

export interface UiEvent {
  type: UiEventType;
  id: string;
  timestamp: string;
  data: unknown;
}

export interface StreamEnvelope {
  event: UiEvent;
  sequence: number;
  sessionId?: string;
  agentId?: string;
}

// ─── Progress ────────────────────────────────────────────────

export interface ProgressUpdate {
  taskId: string;
  label: string;
  current: number;
  total: number;
  percentage: number;
  status: 'running' | 'completed' | 'failed';
  details?: string;
}

// ─── Approval UI ─────────────────────────────────────────────

export interface ApprovalUiPayload {
  taskId: string;
  title: string;
  description: string;
  riskLevel?: string;
  actions: Array<{
    label: string;
    value: string;
    style?: 'primary' | 'danger' | 'secondary';
  }>;
  context?: Record<string, unknown>;
  deadline?: string;
}

// ─── Citations ───────────────────────────────────────────────

export interface CitationPayload {
  id: string;
  text: string;
  source: string;
  url?: string;
  page?: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

// ─── Artifacts ───────────────────────────────────────────────

export interface ArtifactPayload {
  id: string;
  type: string;
  title: string;
  mimeType: string;
  data: unknown;
  downloadable: boolean;
  preview?: string;
}

// ─── Widgets ─────────────────────────────────────────────────

export type WidgetType = 'table' | 'chart' | 'form' | 'code' | 'image' | 'map' | 'timeline' | 'custom';

export interface WidgetPayload {
  id: string;
  type: WidgetType;
  title?: string;
  data: unknown;
  interactive: boolean;
  config?: Record<string, unknown>;
}
