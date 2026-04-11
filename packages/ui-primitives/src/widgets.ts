/**
 * @weaveintel/ui-primitives — Widget payload builder
 */

import { randomUUID } from 'node:crypto';
import type { WidgetPayload, WidgetType } from '@weaveintel/core';

export interface CreateWidgetOptions {
  type: WidgetType;
  title?: string;
  data: unknown;
  interactive?: boolean;
  config?: Record<string, unknown>;
}

/**
 * Build a WidgetPayload.
 */
export function createWidget(opts: CreateWidgetOptions): WidgetPayload {
  return {
    id: randomUUID(),
    type: opts.type,
    title: opts.title,
    data: opts.data,
    interactive: opts.interactive ?? false,
    config: opts.config,
  };
}

/**
 * Convenience: table widget.
 */
export function tableWidget(
  title: string,
  columns: string[],
  rows: unknown[][],
  opts?: { sortable?: boolean; filterable?: boolean },
): WidgetPayload {
  return createWidget({
    type: 'table',
    title,
    data: { columns, rows },
    interactive: opts?.sortable || opts?.filterable || false,
    config: { sortable: opts?.sortable ?? false, filterable: opts?.filterable ?? false },
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
  opts?: { interactive?: boolean },
): WidgetPayload {
  return createWidget({
    type: 'chart',
    title,
    data: { chartType, labels, datasets },
    interactive: opts?.interactive ?? true,
    config: { chartType },
  });
}

/**
 * Convenience: form widget.
 */
export function formWidget(
  title: string,
  fields: Array<{ name: string; label: string; type: string; required?: boolean; options?: string[] }>,
  submitLabel: string = 'Submit',
): WidgetPayload {
  return createWidget({
    type: 'form',
    title,
    data: { fields, submitLabel },
    interactive: true,
  });
}

/**
 * Convenience: code widget (syntax-highlighted display).
 */
export function codeWidget(
  title: string,
  code: string,
  language: string = 'typescript',
): WidgetPayload {
  return createWidget({
    type: 'code',
    title,
    data: { code, language },
    interactive: false,
  });
}

/**
 * Convenience: timeline widget.
 */
export function timelineWidget(
  title: string,
  events: Array<{ time: string; label: string; description?: string; status?: string }>,
): WidgetPayload {
  return createWidget({
    type: 'timeline',
    title,
    data: { events },
    interactive: false,
  });
}

/**
 * Convenience: image widget.
 */
export function imageWidget(
  title: string,
  src: string,
  alt?: string,
  opts?: { width?: number; height?: number },
): WidgetPayload {
  return createWidget({
    type: 'image',
    title,
    data: { src, alt, width: opts?.width, height: opts?.height },
    interactive: false,
  });
}
