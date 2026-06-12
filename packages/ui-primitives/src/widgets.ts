/**
 * @weaveintel/ui-primitives — Widget payload builder
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { WidgetPayload, WidgetType, WidgetFallback } from '@weaveintel/core';

export interface CreateWidgetOptions {
  type: WidgetType;
  title?: string;
  data: unknown;
  interactive?: boolean;
  config?: Record<string, unknown>;
  /**
   * Plain-language description for screen readers.
   * If omitted, builders that can derive a sensible summary will set it
   * automatically (e.g. table → "Table: N rows, M columns").
   */
  a11ySummary?: string;
  /**
   * Fallback rendering hint for clients that do not implement `type`.
   * If omitted and a default can be derived, builders set it automatically.
   */
  fallback?: WidgetFallback;
  /**
   * Schema version for the `data` payload.  Defaults to 1.
   * Increment when the `data` shape changes in a backward-incompatible way.
   */
  schemaVersion?: number;
}

/**
 * Build a WidgetPayload.
 */
export function createWidget(opts: CreateWidgetOptions): WidgetPayload {
  return {
    id: newUUIDv7(),
    type: opts.type,
    title: opts.title,
    data: opts.data,
    interactive: opts.interactive ?? false,
    config: opts.config,
    a11ySummary: opts.a11ySummary,
    fallback: opts.fallback,
    schemaVersion: opts.schemaVersion ?? 1,
  };
}

/**
 * Convenience: table widget.
 * Auto-generates `a11ySummary` and text `fallback` from row/column counts.
 */
export function tableWidget(
  title: string,
  columns: string[],
  rows: unknown[][],
  opts?: { sortable?: boolean; filterable?: boolean; a11ySummary?: string },
): WidgetPayload {
  const summary = opts?.a11ySummary ?? `Table: ${rows.length} rows, ${columns.length} columns`;
  return createWidget({
    type: 'table',
    title,
    data: { columns, rows },
    interactive: opts?.sortable || opts?.filterable || false,
    config: { sortable: opts?.sortable ?? false, filterable: opts?.filterable ?? false },
    a11ySummary: summary,
    fallback: { kind: 'text', text: `${title ? title + ' — ' : ''}${summary}` },
  });
}

/**
 * Convenience: chart widget.
 */
export function chartWidget(
  title: string,
  chartType: 'bar' | 'line' | 'pie' | 'scatter',
  labels: string[],
  datasets: Array<{ label: string; data: number[] }>,
  opts?: { interactive?: boolean; a11ySummary?: string },
): WidgetPayload {
  const summary = opts?.a11ySummary ?? `${chartType} chart: ${title ?? ''}`;
  return createWidget({
    type: 'chart',
    title,
    data: { chartType, labels, datasets },
    interactive: opts?.interactive ?? true,
    config: { chartType },
    a11ySummary: summary,
    fallback: { kind: 'text', text: summary },
  });
}

/**
 * Convenience: form widget.
 */
export function formWidget(
  title: string,
  fields: Array<{ name: string; label: string; type: string; required?: boolean; options?: string[] }>,
  submitLabel: string = 'Submit',
  opts?: { a11ySummary?: string },
): WidgetPayload {
  const summary = opts?.a11ySummary ?? `Form: ${title} — ${fields.length} field${fields.length === 1 ? '' : 's'}`;
  return createWidget({
    type: 'form',
    title,
    data: { fields, submitLabel },
    interactive: true,
    a11ySummary: summary,
    fallback: { kind: 'text', text: summary },
  });
}

/**
 * Convenience: code widget (syntax-highlighted display).
 */
export function codeWidget(
  title: string,
  code: string,
  language: string = 'typescript',
  opts?: { a11ySummary?: string },
): WidgetPayload {
  const lineCount = code.split('\n').length;
  const summary = opts?.a11ySummary ?? `Code: ${language} (${lineCount} line${lineCount === 1 ? '' : 's'})`;
  return createWidget({
    type: 'code',
    title,
    data: { code, language },
    interactive: false,
    a11ySummary: summary,
    fallback: { kind: 'text', text: `${title ? title + ' — ' : ''}${summary}` },
  });
}

/**
 * Convenience: timeline widget.
 */
export function timelineWidget(
  title: string,
  events: Array<{ time: string; label: string; description?: string; status?: string }>,
  opts?: { a11ySummary?: string },
): WidgetPayload {
  const summary = opts?.a11ySummary ?? `Timeline: ${events.length} event${events.length === 1 ? '' : 's'}`;
  return createWidget({
    type: 'timeline',
    title,
    data: { events },
    interactive: false,
    a11ySummary: summary,
    fallback: { kind: 'text', text: `${title ? title + ' — ' : ''}${summary}` },
  });
}

/**
 * Convenience: image widget.
 */
export function imageWidget(
  title: string,
  src: string,
  alt?: string,
  opts?: { width?: number; height?: number; a11ySummary?: string },
): WidgetPayload {
  const summary = opts?.a11ySummary ?? alt ?? `Image: ${title}`;
  return createWidget({
    type: 'image',
    title,
    data: { src, alt, width: opts?.width, height: opts?.height },
    interactive: false,
    a11ySummary: summary,
    fallback: { kind: 'text', text: summary },
  });
}

