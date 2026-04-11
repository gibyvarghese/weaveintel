// @weaveintel/graph — Timeline graph for event ordering

import { createEntityNode, createRelationshipEdge, type EntityNode, type RelationshipEdge } from './entity.js';

export interface TimelineEntry {
  readonly entityId: string;
  readonly timestamp: number;
  readonly label: string;
  readonly metadata: Record<string, unknown>;
}

export interface TimelineGraph {
  addEvent(label: string, timestamp: number, metadata?: Record<string, unknown>): EntityNode;
  getEvents(): readonly TimelineEntry[];
  getEventsBetween(start: number, end: number): readonly TimelineEntry[];
  linkEvents(sourceId: string, targetId: string, relationship?: string): RelationshipEdge;
}

export function createTimelineGraph(): TimelineGraph {
  const entries: TimelineEntry[] = [];
  const eventNodes = new Map<string, EntityNode>();
  const eventEdges: RelationshipEdge[] = [];

  return {
    addEvent(label, timestamp, metadata = {}) {
      const node = createEntityNode(
        `tl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        'timeline-event',
        label,
        { ...metadata, timestamp },
      );
      eventNodes.set(node.id, node);
      entries.push({ entityId: node.id, timestamp, label, metadata });
      return node;
    },

    getEvents() {
      return [...entries].sort((a, b) => a.timestamp - b.timestamp);
    },

    getEventsBetween(start, end) {
      return entries.filter((e) => e.timestamp >= start && e.timestamp <= end).sort((a, b) => a.timestamp - b.timestamp);
    },

    linkEvents(sourceId, targetId, relationship = 'followed-by') {
      const edge = createRelationshipEdge(sourceId, targetId, relationship);
      eventEdges.push(edge);
      return edge;
    },
  };
}
