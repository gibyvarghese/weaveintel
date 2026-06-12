/**
 * @weaveintel/ui-primitives — W2 widget ergonomics tests
 *
 * Covers: auto-generated fallback/a11ySummary on builders, round-trip of
 * widgetActionEvent → parseWidgetAction, registry fallback for unknown types.
 */

import { describe, it, expect } from 'vitest';
import {
  tableWidget,
  chartWidget,
  codeWidget,
  timelineWidget,
  imageWidget,
  createWidget,
  widgetActionEvent,
  parseWidgetAction,
  createWidgetRendererRegistry,
} from './index.js';
import type { WidgetPayload } from '@weaveintel/core';

// ─── Widget builders ──────────────────────────────────────────────────────────

describe('tableWidget auto-fallback', () => {
  it('generates a11ySummary and text fallback from row/column counts', () => {
    const w = tableWidget('Sales', ['Q1', 'Q2', 'Q3'], [[1, 2, 3], [4, 5, 6]]);
    expect(w.a11ySummary).toContain('2 rows');
    expect(w.a11ySummary).toContain('3 columns');
    expect(w.fallback?.kind).toBe('text');
    expect(w.fallback?.text).toContain('Sales');
  });

  it('respects caller-provided a11ySummary', () => {
    const w = tableWidget('T', [], [], { a11ySummary: 'Custom summary' });
    expect(w.a11ySummary).toBe('Custom summary');
  });

  it('sets schemaVersion to 1 by default', () => {
    const w = tableWidget('T', ['A'], [[1]]);
    expect(w.schemaVersion).toBe(1);
  });
});

describe('chartWidget auto-fallback', () => {
  it('generates fallback text', () => {
    const w = chartWidget('Revenue', 'bar', ['Jan', 'Feb'], [{ label: 'Sales', data: [100, 200] }]);
    expect(w.fallback?.kind).toBe('text');
    expect(w.fallback?.text).toContain('bar chart');
  });
});

describe('codeWidget auto-fallback', () => {
  it('includes line count in a11ySummary', () => {
    const code = 'const x = 1;\nconst y = 2;\nreturn x + y;';
    const w = codeWidget('Snippet', code, 'typescript');
    expect(w.a11ySummary).toContain('3 lines');
    expect(w.fallback?.kind).toBe('text');
  });
});

describe('timelineWidget auto-fallback', () => {
  it('includes event count', () => {
    const events = [
      { time: '2026-01-01', label: 'Start' },
      { time: '2026-06-01', label: 'Milestone' },
    ];
    const w = timelineWidget('Project', events);
    expect(w.a11ySummary).toContain('2 events');
  });
});

describe('imageWidget auto-fallback', () => {
  it('uses alt text as a11ySummary when provided', () => {
    const w = imageWidget('Photo', 'https://example.com/img.jpg', 'A landscape photo');
    expect(w.a11ySummary).toBe('A landscape photo');
  });

  it('falls back to title when no alt provided', () => {
    const w = imageWidget('Chart Screenshot', 'https://example.com/img.jpg');
    expect(w.a11ySummary).toContain('Chart Screenshot');
  });
});

// ─── Unknown widget type → registry fallback ──────────────────────────────────

describe('WidgetRendererRegistry fallback', () => {
  it('resolves fallback renderer for unknown type', () => {
    const fallback = (w: WidgetPayload): string =>
      w.fallback?.text ?? 'Unsupported widget';

    const registry = createWidgetRendererRegistry<string>(fallback);
    registry.register('table', () => 'rendered table');

    // known type → custom renderer
    const tableResult = registry.render(createWidget({ type: 'table', data: {}, interactive: false }));
    expect(tableResult).toBe('rendered table');

    // unknown type → fallback renderer
    const customWidget = createWidget({
      type: 'custom',
      data: {},
      interactive: false,
      fallback: { kind: 'text', text: 'Custom widget: N/A' },
    });
    const fallbackResult = registry.render(customWidget);
    expect(fallbackResult).toBe('Custom widget: N/A');
  });
});

// ─── Widget action round-trip ─────────────────────────────────────────────────

describe('widgetActionEvent + parseWidgetAction round-trip', () => {
  it('builds and parses a widget action', () => {
    const event = widgetActionEvent('widget-123', 'approve', { reason: 'LGTM' });
    expect(event.type).toBe('widget');

    const result = parseWidgetAction(event);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.widgetId).toBe('widget-123');
      expect(result.payload.actionId).toBe('approve');
      expect((result.payload.value as { reason: string }).reason).toBe('LGTM');
    }
  });

  it('rejects wrong event type', () => {
    const bad = { type: 'text' as const, id: '1', timestamp: '', data: {} };
    const result = parseWidgetAction(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("'widget'");
  });

  it('rejects missing widgetId', () => {
    const event = { type: 'widget' as const, id: '1', timestamp: '', data: { actionId: 'x' } };
    const result = parseWidgetAction(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('widgetId');
  });

  it('rejects missing actionId', () => {
    const event = { type: 'widget' as const, id: '1', timestamp: '', data: { widgetId: 'w1' } };
    const result = parseWidgetAction(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('actionId');
  });

  it('action without value is valid', () => {
    const event = widgetActionEvent('w1', 'dismiss');
    const result = parseWidgetAction(event);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.value).toBeUndefined();
  });
});
