/**
 * @weaveintel/core — Knowledge graph contracts
 */

// ─── Entity Node ─────────────────────────────────────────────

export interface EntityNode {
  id: string;
  type: string;
  name: string;
  properties: Record<string, unknown>;
  embedding?: number[];
  confidence?: number;
  source?: string;
  createdAt: string;
  updatedAt?: string;
}

// ─── Relationship ────────────────────────────────────────────

export interface RelationshipEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  type: string;
  properties?: Record<string, unknown>;
  weight?: number;
  confidence?: number;
  createdAt: string;
}

// ─── Graph Store ─────────────────────────────────────────────

export interface GraphMemoryStore {
  addNode(node: Omit<EntityNode, 'id' | 'createdAt'>): Promise<EntityNode>;
  getNode(nodeId: string): Promise<EntityNode | null>;
  findNodes(filter: { type?: string; name?: string; properties?: Record<string, unknown> }): Promise<EntityNode[]>;
  addEdge(edge: Omit<RelationshipEdge, 'id' | 'createdAt'>): Promise<RelationshipEdge>;
  getEdges(nodeId: string, direction?: 'in' | 'out' | 'both'): Promise<RelationshipEdge[]>;
  removeNode(nodeId: string): Promise<void>;
  removeEdge(edgeId: string): Promise<void>;
}

// ─── Entity Linker ───────────────────────────────────────────

export interface EntityLinker {
  link(text: string, existingNodes: EntityNode[]): Promise<Array<{ entity: string; nodeId: string | null; confidence: number }>>;
  merge(sourceNodeId: string, targetNodeId: string): Promise<EntityNode>;
}

// ─── Timeline ────────────────────────────────────────────────

export interface TimelineGraph {
  addEvent(event: { nodeId: string; timestamp: string; type: string; description: string }): Promise<void>;
  getTimeline(nodeId: string, from?: string, to?: string): Promise<Array<{ timestamp: string; type: string; description: string }>>;
}

// ─── Graph Retriever ─────────────────────────────────────────

export interface GraphRetriever {
  retrieve(query: string, options?: { maxDepth?: number; maxNodes?: number; types?: string[] }): Promise<{
    nodes: EntityNode[];
    edges: RelationshipEdge[];
    relevanceScores: Record<string, number>;
  }>;
}
