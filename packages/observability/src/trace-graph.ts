/**
 * Trace graph — builds a DAG visualization of spans within a trace
 */
import type { SpanRecord } from '@weaveintel/core';

export interface TraceNode {
  span: SpanRecord;
  children: TraceNode[];
  depth: number;
}

export interface TraceGraph {
  root: TraceNode | null;
  nodes: Map<string, TraceNode>;
  totalDurationMs: number;
  spanCount: number;
}

export function weaveTraceGraph(spans: SpanRecord[]): TraceGraph {
  const nodes = new Map<string, TraceNode>();
  const sorted = [...spans].sort((a, b) => a.startTime - b.startTime);

  for (const span of sorted) {
    nodes.set(span.spanId, { span, children: [], depth: 0 });
  }

  let root: TraceNode | null = null;
  for (const node of nodes.values()) {
    const parentId = node.span.parentSpanId;
    if (parentId && nodes.has(parentId)) {
      const parent = nodes.get(parentId)!;
      parent.children.push(node);
      node.depth = parent.depth + 1;
    } else if (!root) {
      root = node;
    }
  }

  const totalDurationMs = root
    ? (root.span.endTime ?? root.span.startTime) - root.span.startTime
    : 0;

  return { root, nodes, totalDurationMs, spanCount: nodes.size };
}

/** Pretty print a trace graph as an ASCII tree */
export function formatTraceGraph(graph: TraceGraph): string {
  if (!graph.root) return '(empty trace)';
  const lines: string[] = [];

  function walk(node: TraceNode, prefix: string, isLast: boolean) {
    const dur = (node.span.endTime ?? node.span.startTime) - node.span.startTime;
    const connector = prefix ? (isLast ? '└─ ' : '├─ ') : '';
    lines.push(`${prefix}${connector}${node.span.name} (${dur}ms) [${node.span.status}]`);
    const childPrefix = prefix + (prefix ? (isLast ? '   ' : '│  ') : '');
    node.children.forEach((child, i) => walk(child, childPrefix, i === node.children.length - 1));
  }

  walk(graph.root, '', true);
  return lines.join('\n');
}
