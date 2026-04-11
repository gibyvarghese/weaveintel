// @weaveintel/graph — In-memory graph store

import type { EntityNode, RelationshipEdge } from './entity.js';

export interface GraphMemoryStore {
  addNode(node: EntityNode): void;
  getNode(id: string): EntityNode | undefined;
  findNodes(type: string): readonly EntityNode[];
  searchNodes(query: string): readonly EntityNode[];
  removeNode(id: string): boolean;

  addEdge(edge: RelationshipEdge): void;
  getEdge(id: string): RelationshipEdge | undefined;
  getEdgesFrom(nodeId: string): readonly RelationshipEdge[];
  getEdgesTo(nodeId: string): readonly RelationshipEdge[];
  getEdgesBetween(sourceId: string, targetId: string): readonly RelationshipEdge[];
  removeEdge(id: string): boolean;

  getNeighbors(nodeId: string, depth?: number): readonly EntityNode[];
  nodeCount(): number;
  edgeCount(): number;
  clear(): void;
}

export function createGraphMemoryStore(): GraphMemoryStore {
  const nodes = new Map<string, EntityNode>();
  const edges = new Map<string, RelationshipEdge>();

  function collectNeighbors(nodeId: string, depth: number, visited: Set<string>): EntityNode[] {
    if (depth <= 0 || visited.has(nodeId)) return [];
    visited.add(nodeId);
    const result: EntityNode[] = [];
    for (const edge of edges.values()) {
      let neighborId: string | null = null;
      if (edge.sourceId === nodeId) neighborId = edge.targetId;
      else if (edge.targetId === nodeId) neighborId = edge.sourceId;
      if (neighborId && !visited.has(neighborId)) {
        const neighbor = nodes.get(neighborId);
        if (neighbor) {
          result.push(neighbor);
          result.push(...collectNeighbors(neighborId, depth - 1, visited));
        }
      }
    }
    return result;
  }

  return {
    addNode(node) { nodes.set(node.id, node); },
    getNode(id) { return nodes.get(id); },
    findNodes(type) { return Array.from(nodes.values()).filter((n) => n.type === type); },
    searchNodes(query) {
      const q = query.toLowerCase();
      return Array.from(nodes.values()).filter((n) =>
        n.name.toLowerCase().includes(q) || n.type.toLowerCase().includes(q),
      );
    },
    removeNode(id) {
      // Remove edges connected to this node
      for (const [eid, edge] of edges.entries()) {
        if (edge.sourceId === id || edge.targetId === id) edges.delete(eid);
      }
      return nodes.delete(id);
    },

    addEdge(edge) { edges.set(edge.id, edge); },
    getEdge(id) { return edges.get(id); },
    getEdgesFrom(nodeId) { return Array.from(edges.values()).filter((e) => e.sourceId === nodeId); },
    getEdgesTo(nodeId) { return Array.from(edges.values()).filter((e) => e.targetId === nodeId); },
    getEdgesBetween(sourceId, targetId) {
      return Array.from(edges.values()).filter(
        (e) => (e.sourceId === sourceId && e.targetId === targetId) || (e.sourceId === targetId && e.targetId === sourceId),
      );
    },
    removeEdge(id) { return edges.delete(id); },

    getNeighbors(nodeId, depth = 1) {
      return collectNeighbors(nodeId, depth, new Set());
    },

    nodeCount() { return nodes.size; },
    edgeCount() { return edges.size; },
    clear() { nodes.clear(); edges.clear(); },
  };
}
